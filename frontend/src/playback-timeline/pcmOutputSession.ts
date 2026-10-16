import { loadSpeechVolume, SPEECH_VOLUME_KEY } from "../app/petPreferences.js";
import type { AudioPlaybackClock } from "./contracts.js";
import type { SpeechOutputSession } from "./speechOutputRuntime.js";

const SAMPLE_RATE = 32000;
const MAX_CHUNK_BYTES = 65536;
const MAX_BUFFERED_SAMPLES = SAMPLE_RATE * 4;
const MAX_BUFFERED_NODES = 128;
const SCHEDULE_LEAD_SECONDS = 0.005;

export interface PcmOutputSession extends SpeechOutputSession {
  readonly clock: AudioPlaybackClock;
  /** Resolves only after production ends AND accepted audio drains. */
  readonly completed: Promise<void>;
  append(sampleOffset: number, pcm: Uint8Array): Promise<void>;
  finish(totalSamples: number): void;
}

interface ScheduledChunk {
  source: AudioBufferSourceNode;
  start: number;
  end: number;
  samples: number;
  ended: boolean;
}

/** One segment, one serialized writer, using the runtime's existing output graph. */
export function createPcmOutputSession(
  context: AudioContext,
  input: GainNode,
  output: SpeechOutputSession,
): PcmOutputSession {
  const chunks: ScheduledChunk[] = [];
  let acceptedSamples = 0;
  let drainedSamples = 0;
  let tailTime = 0;
  let finished = false;
  let disposed = false;
  let prepared = false;
  let appending = false;
  let wakeWriter: (() => void) | null = null;
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

  function settleDrain(): void {
    while (chunks[0]?.ended) {
      drainedSamples += chunks.shift()!.samples;
    }
    wakeWriter?.();
    if (finished && chunks.length === 0) resolveCompleted();
  }

  return {
    analyser: output.analyser,
    sampleRate: output.sampleRate,
    completed,
    clock: {
      getCurrentTimeMs: () => currentSamples() * 1000 / SAMPLE_RATE,
      getDurationMs: () => finished ? acceptedSamples * 1000 / SAMPLE_RATE : null,
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
        || !(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength % 2
        || pcm.byteLength > MAX_CHUNK_BYTES
        || !Number.isSafeInteger(sampleOffset + pcm.byteLength / 2)) {
        throw new Error("pcm_output_invalid_chunk_or_offset");
      }
      const count = pcm.byteLength / 2;
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
        const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        for (let i = 0; i < count; i++) target[i] = view.getInt16(i * 2, true) / 32768;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(input);
        const start = Math.max(context.currentTime + SCHEDULE_LEAD_SECONDS, tailTime);
        const chunk = { source, start, end: start + count / SAMPLE_RATE, samples: count, ended: false };
        source.onended = () => {
          chunk.ended = true;
          source.disconnect();
          settleDrain();
        };
        output.start();
        try {
          source.start(start);
        } catch (error) {
          source.onended = null;
          source.disconnect();
          throw error;
        }
        chunks.push(chunk);
        tailTime = chunk.end;
        acceptedSamples += count;
      } finally {
        appending = false;
      }
    },
    finish(totalSamples) {
      assertWritable();
      if (appending || !Number.isSafeInteger(totalSamples) || totalSamples !== acceptedSamples) {
        throw new Error("pcm_output_incomplete_or_invalid_end");
      }
      finished = true;
      settleDrain();
    },
    dispose() {
      if (disposed) return;
      // Freeze the clock at the actual consumed prefix before removing sources.
      const consumed = currentSamples();
      disposed = true;
      window.removeEventListener("storage", syncVolume);
      for (const chunk of chunks) {
        chunk.source.onended = null;
        chunk.source.stop();
        chunk.source.disconnect();
      }
      chunks.length = 0;
      drainedSamples = consumed;
      wakeWriter?.();
      rejectCompleted(new DOMException("PCM playback stopped.", "AbortError"));
      output.dispose();
    },
  };
}
