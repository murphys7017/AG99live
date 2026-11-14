import { loadSpeechVolume, SPEECH_VOLUME_KEY } from "../app/petPreferences.js";
import { reportLatencyStage } from "../adapter-connection/runtime/latency.js";
import type { AudioPlaybackClock } from "./contracts.js";
import type { SpeechOutputSession } from "./speechOutputRuntime.js";

const SAMPLE_RATE = 32000;
const MAX_CHUNK_SAMPLES = 32768;
const MAX_BUFFERED_SAMPLES = SAMPLE_RATE * 4;
const MAX_BUFFERED_NODES = 128;
const SCHEDULE_LEAD_SECONDS = 0.005;
const INITIAL_PREBUFFER_SAMPLES = Math.round(SAMPLE_RATE * 0.08);
const INITIAL_PREBUFFER_MAX_WAIT_MS = 120;
const MIN_SCHEDULE_GAP_SAMPLES = 2;
const BOUNDARY_GUARD_SAMPLES = 32; // 1 ms at 32 kHz; appended only after speech.

export interface PcmOutputSession extends SpeechOutputSession {
  readonly clock: AudioPlaybackClock;
  /** First consumed samples, expressed on this renderer's performance clock. */
  readonly started: Promise<number>;
  /** Resolves only after production ends AND accepted audio drains. */
  readonly completed: Promise<void>;
  getScheduledEndTime(): number;
  getScheduledWaitMs(): number;
  append(sampleOffset: number, samples: Float32Array): Promise<void>;
  finish(totalSamples: number): void;
}

interface ScheduledChunk {
  source: AudioBufferSourceNode;
  start: number;
  end: number;
  samples: number;
  ended: boolean;
}

interface PendingChunk {
  buffer: AudioBuffer;
  samples: number;
}

/** One segment, one serialized writer, using the runtime's existing output graph. */
export function createPcmOutputSession(
  context: AudioContext,
  input: GainNode,
  output: SpeechOutputSession,
  identity: { turnId: string; messageId: string },
  notBefore = 0,
): PcmOutputSession {
  const chunks: ScheduledChunk[] = [];
  const pendingChunks: PendingChunk[] = [];
  let acceptedSamples = 0;
  let drainedSamples = 0;
  let tailTime = 0;
  let finished = false;
  let disposed = false;
  let prepared = false;
  let appending = false;
  let wakeWriter: (() => void) | null = null;
  let firstStartTime: number | null = null;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let prebufferTimer: ReturnType<typeof setTimeout> | null = null;
  let startNotified = false;
  let previousSample = 0;
  let resolveStarted!: (atMs: number) => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<number>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  void started.catch(() => undefined);
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  // The owner may not attach its terminal observer until after an interruption.
  void completed.catch(() => undefined);

  const syncVolume = (event?: StorageEvent) => {
    if (!event || event.key === SPEECH_VOLUME_KEY) {
      input.gain.value = loadSpeechVolume();
    }
  };
  syncVolume();
  window.addEventListener("storage", syncVolume);

  function assertWritable(): void {
    if (disposed) throw new DOMException("PCM playback stopped.", "AbortError");
    if (finished) throw new Error("pcm_output_already_finished");
  }

  function currentSamples(): number {
    let samples = drainedSamples;
    for (const chunk of chunks) {
      samples += Math.min(chunk.samples, Math.max(
        0, Math.floor((context.currentTime - chunk.start) * SAMPLE_RATE),
      ));
    }
    return samples;
  }

  function timelineSamples(): number {
    if (firstStartTime === null) return 0;
    const endTime = Math.min(context.currentTime, tailTime);
    return Math.max(0, Math.floor((endTime - firstStartTime) * SAMPLE_RATE));
  }

  function clearPrebufferTimer(): void {
    if (prebufferTimer !== null) {
      clearTimeout(prebufferTimer);
      prebufferTimer = null;
    }
  }

  function settleDrain(): void {
    while (chunks[0]?.ended) {
      drainedSamples += chunks.shift()!.samples;
    }
    wakeWriter?.();
    if (finished && chunks.length === 0) {
      console.info("[PcmOutput] segment drained.", {
        ...identity,
        acceptedSamples,
        drainedSamples,
        scheduledDurationMs: scheduledDurationSamples() * 1000 / SAMPLE_RATE,
      });
      resolveCompleted();
    }
  }

  function scheduledDurationSamples(): number {
    if (firstStartTime === null) return 0;
    return Math.max(0, Math.floor((tailTime - firstStartTime) * SAMPLE_RATE));
  }

  function schedulePendingChunks(contiguousOnly = false): void {
    if (disposed || pendingChunks.length === 0) return;
    clearPrebufferTimer();
    // Finish the gain ramp during the silent scheduling lead, before sample 0.
    output.start(context.currentTime + SCHEDULE_LEAD_SECONDS);
    while (pendingChunks.length > 0) {
      const pending = pendingChunks.shift()!;
      const previousTailTime = tailTime;
      // An optional end guard is useful only at the exact original boundary.
      // If admission is already late, discard it instead of replaying old PCM.
      if (contiguousOnly && previousTailTime < context.currentTime + SCHEDULE_LEAD_SECONDS) {
        continue;
      }
      const start = contiguousOnly ? previousTailTime
        : Math.max(context.currentTime + SCHEDULE_LEAD_SECONDS, previousTailTime, notBefore);
      const gapSamples = previousTailTime > 0
        ? Math.floor(Math.max(0, start - previousTailTime) * SAMPLE_RATE)
        : 0;
      if (gapSamples >= MIN_SCHEDULE_GAP_SAMPLES) {
        reportLatencyStage("pcm_schedule_gap", identity.turnId, null, identity.messageId);
        console.warn("[PcmOutput] scheduled PCM gap detected.", {
          gapMs: gapSamples * 1000 / SAMPLE_RATE,
          bufferedMs: Math.max(0, (previousTailTime - context.currentTime) * 1000),
          pendingSamples: pending.samples,
        });
      }
      const source = context.createBufferSource();
      source.buffer = pending.buffer;
      source.connect(input);
      const chunk = {
        source,
        start,
        end: start + pending.buffer.duration,
        samples: pending.samples,
        ended: false,
      };
      source.onended = () => {
        observeStart();
        chunk.ended = true;
        source.disconnect();
        settleDrain();
      };
      try {
        source.start(start);
      } catch (error) {
        source.onended = null;
        source.disconnect();
        throw error;
      }
      chunks.push(chunk);
      tailTime = chunk.end;
      if (firstStartTime === null) {
        firstStartTime = start;
        console.info("[PcmOutput] first samples scheduled.", {
          ...identity,
          samples: pending.samples,
          leadMs: (start - context.currentTime) * 1000,
          audioContextTime: context.currentTime,
          scheduledStartTime: start,
          baseLatencyMs: context.baseLatency * 1000,
          outputLatencyMs: context.outputLatency * 1000,
        });
        observeStart();
      }
    }
  }

  function observeStart(): void {
    if (startTimer !== null) clearTimeout(startTimer);
    startTimer = null;
    if (disposed || startNotified || firstStartTime === null) return;
    if (context.state === "running" && context.currentTime > firstStartTime) {
      startNotified = true;
      resolveStarted(performance.now() - (context.currentTime - firstStartTime) * 1000);
    } else {
      startTimer = setTimeout(observeStart, 5);
    }
  }

  return {
    analyser: output.analyser,
    sampleRate: output.sampleRate,
    completed,
    started,
    getScheduledEndTime() {
      if (!finished) throw new Error("pcm_output_schedule_not_finished");
      return tailTime;
    },
    getScheduledWaitMs: () => Math.max(0, (notBefore - context.currentTime) * 1000),
    clock: {
      getCurrentTimeMs: () => timelineSamples() * 1000 / SAMPLE_RATE,
      getDurationMs: () => finished
        ? Math.max(acceptedSamples, scheduledDurationSamples()) * 1000 / SAMPLE_RATE
        : null,
      getPlaybackRate: () => 1,
      isPlaying: () => !disposed && context.state === "running" && chunks.some(
        (chunk) => context.currentTime >= chunk.start && context.currentTime < chunk.end,
      ),
    },
    async prepare() {
      assertWritable();
      await output.prepare();
      assertWritable();
      prepared = true;
    },
    start: () => output.start(),
    async append(sampleOffset, pcm) {
      assertWritable();
      if (!prepared) throw new Error("pcm_output_not_prepared");
      if (appending) throw new Error("pcm_output_concurrent_append");
      if (!Number.isSafeInteger(sampleOffset) || sampleOffset !== acceptedSamples
        || !(pcm instanceof Float32Array) || !pcm.length
        || pcm.length > MAX_CHUNK_SAMPLES
        || pcm.some((sample) => !Number.isFinite(sample) || sample < -1 || sample > 1)
        || !Number.isSafeInteger(sampleOffset + pcm.length)) {
        throw new Error("pcm_output_invalid_chunk_or_offset");
      }
      const count = pcm.length;
      appending = true;
      try {
        while (chunks.length >= MAX_BUFFERED_NODES
          || acceptedSamples - drainedSamples + count > MAX_BUFFERED_SAMPLES) {
          await new Promise<void>((resolve) => { wakeWriter = resolve; });
          wakeWriter = null;
          assertWritable();
        }
        const buffer = context.createBuffer(1, count, SAMPLE_RATE);
        const target = buffer.getChannelData(0);
        target.set(pcm);
        // Preserve every received speech sample exactly. The output graph has
        // already completed its gain ramp during the silent scheduling lead;
        // modifying the first samples here can erase a short initial phoneme.
        previousSample = target[target.length - 1];
        pendingChunks.push({ buffer, samples: count });
        acceptedSamples += count;

        if (firstStartTime === null) {
          const pendingSamples = pendingChunks.reduce((sum, chunk) => sum + chunk.samples, 0);
          if (pendingSamples >= INITIAL_PREBUFFER_SAMPLES) {
            schedulePendingChunks();
          } else if (prebufferTimer === null) {
            prebufferTimer = setTimeout(() => {
              prebufferTimer = null;
              schedulePendingChunks();
            }, INITIAL_PREBUFFER_MAX_WAIT_MS);
          }
        } else {
          schedulePendingChunks();
        }
      } finally {
        appending = false;
      }
    },
    finish(totalSamples) {
      assertWritable();
      if (appending || !Number.isSafeInteger(totalSamples) || totalSamples !== acceptedSamples) {
        throw new Error("pcm_output_incomplete_or_invalid_end");
      }
      schedulePendingChunks();
      // Schedule the final sample's return to zero before the next segment.
      // All received samples remain present; only this 1 ms guard is appended.
      if (acceptedSamples > 0 && previousSample !== 0) {
        const buffer = context.createBuffer(1, BOUNDARY_GUARD_SAMPLES, SAMPLE_RATE);
        const values = buffer.getChannelData(0);
        for (let index = 0; index < values.length; index++) {
          values[index] = previousSample * (1 - (index + 1) / values.length);
        }
        pendingChunks.push({ buffer, samples: 0 });
        // Guard nodes must drain too, but are not wire samples or audio credit.
        schedulePendingChunks(true);
      }
      finished = true;
      if (acceptedSamples === 0) {
        rejectStarted(new Error("pcm_output_empty"));
      }
      settleDrain();
    },
    dispose() {
      if (disposed) return;
      // Freeze the clock at the actual consumed prefix before removing sources.
      const consumed = currentSamples();
      disposed = true;
      if (startTimer !== null) clearTimeout(startTimer);
      clearPrebufferTimer();
      rejectStarted(new DOMException("PCM playback stopped.", "AbortError"));
      window.removeEventListener("storage", syncVolume);
      for (const chunk of chunks) {
        chunk.source.onended = null;
        chunk.source.stop();
        chunk.source.disconnect();
      }
      chunks.length = 0;
      pendingChunks.length = 0;
      drainedSamples = consumed;
      wakeWriter?.();
      rejectCompleted(new DOMException("PCM playback stopped.", "AbortError"));
      output.dispose();
    },
  };
}
