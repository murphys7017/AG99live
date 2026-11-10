import type { PlaybackTimelineAudioLipSyncSink } from "./audioLipSyncCoordinator.js";
import type { PlaybackTimelineRuntime } from "./playbackTimelineRuntime.js";
import type { PcmOutputSession } from "./pcmOutputSession.js";
import type { SpeechOutputRuntime } from "./speechOutputRuntime.js";
import { reportLatencyStage } from "../adapter-connection/runtime/latency.js";

export interface PcmTimelineStream {
  readonly completed: Promise<void>;
  readonly readyForNext: Promise<void>;
  append(sampleOffset: number, samples: Float32Array): Promise<void>;
  finish(totalSamples: number, status: "completed" | "failed", reason?: string): void;
}

interface ActiveStream {
  turnId: string;
  messageId: string;
  output: PcmOutputSession;
  lipSync: PlaybackTimelineAudioLipSyncSink | null;
  productionFailure: string | null;
  terminal: boolean;
  finished: boolean;
  completed: Promise<void>;
}

/** Binds PCM to the existing timeline; never creates another Turn or playback clock. */
export function createPcmTimelinePlayback<TMotion>(options: {
  runtime: PlaybackTimelineRuntime<TMotion>;
  speechOutput: SpeechOutputRuntime;
  createLipSyncSink(turnId: string, messageId: string): PlaybackTimelineAudioLipSyncSink;
  onPreparing(): void;
  onStarted(turnId: string, durationMs: number | null): void;
  onEnded(): void;
  onFailed(reason: string): void;
}) {
  let active: ActiveStream | null = null;
  let last: ActiveStream | null = null;
  const streams = new Set<ActiveStream>();

  function settle(stream: ActiveStream, terminal: "completed" | "failed" | "interrupted", reason: string): void {
    if (stream.terminal) return;
    stream.terminal = true;
    if (terminal === "completed") reportLatencyStage("pcm_drained", stream.turnId, null, stream.messageId);
    const errors: unknown[] = [];
    try {
      if (terminal === "completed") stream.lipSync?.completeAfterAudioEnded();
      else if (terminal === "interrupted") {
        if (stream.lipSync?.interrupt) stream.lipSync.interrupt(reason);
        else stream.lipSync?.stop();
      } else stream.lipSync?.failAfterAudioError();
    } catch (error) { errors.push(error); }
    try {
      if (stream.lipSync?.dispose) stream.lipSync.dispose();
      else stream.lipSync?.stop();
    } catch (error) { errors.push(error); }
    try {
      stream.output.dispose();
    } catch (error) { errors.push(error); }
    streams.delete(stream);
    const wasActive = active === stream;
    if (wasActive) active = null;
    if (terminal !== "completed") {
      for (const pending of [...streams]) {
        if (pending !== active) settle(pending, "interrupted", reason);
      }
    }
    try {
      if (terminal === "failed") options.onFailed(reason);
      else if (wasActive) options.onEnded();
    } catch (error) { errors.push(error); }
    // Terminal projection can synchronously release the next segment. Release
    // our resources first so it cannot collide with the previous PCM owner.
    try {
      options.runtime.markAudioTimelineTerminal(stream.turnId, stream.messageId, terminal, reason);
    } catch (error) { errors.push(error); }
    if (errors.length) throw errors[0];
  }

  async function open(turnId: string, messageId: string): Promise<PcmTimelineStream> {
    if (!turnId.trim() || !messageId.trim()) throw new Error("pcm_timeline_identity_missing");
    const previous = last && !last.terminal ? last : null;
    if (previous?.productionFailure) {
      throw new Error("pcm_timeline_previous_production_failed");
    }
    if ((previous && (!previous.finished || previous.turnId !== turnId))
      || streams.size >= 2
      || (!previous && options.runtime.findOpenAudioTimelineSegments().length)) {
      throw new Error("pcm_timeline_previous_audio_unsettled");
    }
    reportLatencyStage("pcm_prepare_start", turnId, null, messageId);
    const output = options.speechOutput.attachPcm({ turnId, messageId }, previous?.output.getScheduledEndTime());
    const stream: ActiveStream = {
      turnId, messageId, output,
      lipSync: null,
      productionFailure: null,
      terminal: false,
      finished: false,
      completed: Promise.resolve(),
    };
    streams.add(stream);
    last = stream;
    // Observe both promises immediately; cancellation during preparation must
    // not leave an unhandled rejection or a later callback for the next segment.
    const started = output.started.then(async (atMs) => {
      // Audio is already scheduled on the device clock. Wait only to transfer
      // presentation ownership; do not defer scheduling to the ended callback.
      if (previous) await previous.completed;
      if (stream.terminal) return;
      active = stream;
      stream.lipSync = options.createLipSyncSink(turnId, messageId);
      stream.lipSync.attachAudio({
        audioUrl: null, clock: output.clock,
        getAudioCurrentTimeSeconds: () => (output.clock.getCurrentTimeMs() ?? 0) / 1000,
        isCurrentAudio: () => active === stream && !stream.terminal,
        speechOutput: output,
      });
      await stream.lipSync.prepare();
      if (stream.terminal) return;
      const durationMs = output.clock.getDurationMs();
      if (!options.runtime.markAudioTimelineStarted(turnId, messageId, atMs, durationMs, output.clock)) {
        throw new Error("pcm_timeline_start_rejected");
      }
      reportLatencyStage("pcm_first_sample", turnId, null, messageId, atMs);
      options.runtime.startLipSyncTimelineSink(turnId, messageId, () => {
        stream.lipSync?.start();
      });
      options.onStarted(turnId, durationMs);
    });
    const completed = (async () => {
      await output.completed;
      await started;
      if (stream.terminal) return;
      const failure = stream.productionFailure;
      settle(stream, failure ? "failed" : "completed", failure ?? "audio_playback_completed");
      if (failure) throw new Error(failure);
    })().catch((error: unknown) => {
      if (!stream.terminal) settle(stream, "failed", "pcm_timeline_playback_failed");
      throw error;
    });
    void started.catch(() => {
      try {
        if (!stream.terminal) settle(stream, "failed", "pcm_timeline_start_failed");
      } catch (error) {
        console.error("[PcmTimeline] start failure cleanup failed.", error);
      }
    });
    void completed.catch(() => undefined);
    stream.completed = completed;
    try {
      if (!previous) options.onPreparing();
      let preparation: Promise<void> = Promise.resolve();
      const accepted = options.runtime.startAudioTimelineSink(turnId, messageId, {
        scheduledWaitMs: output.getScheduledWaitMs(),
        start: () => {
          preparation = output.prepare();
          void preparation.catch(() => undefined);
          return true;
        },
        onInterrupt: (reason) => settle(stream, "interrupted", reason),
      });
      if (accepted === false) throw new Error("pcm_timeline_sink_rejected");
      options.runtime.attachAudioTimelineClock(turnId, messageId, output.clock);
      await preparation;
      if (stream.terminal) throw new DOMException("PCM playback interrupted.", "AbortError");
      reportLatencyStage("pcm_prepare_end", turnId, null, messageId);
    } catch (error) {
      settle(stream, "failed", "pcm_timeline_prepare_failed");
      throw error;
    }
    return {
      completed,
      get readyForNext() {
        // Read after finish(): failed production must drain and reject, never
        // release another segment merely because its partial audio started.
        return stream.productionFailure ? completed : started;
      },
      async append(offset, pcm) {
        if (stream.terminal) throw new DOMException("PCM playback stopped.", "AbortError");
        try {
          await output.append(offset, pcm);
        } catch (error) {
          settle(stream, "failed", "pcm_timeline_chunk_failed");
          throw error;
        }
      },
      finish(totalSamples, status, reason = "") {
        if (stream.terminal) throw new DOMException("PCM playback stopped.", "AbortError");
        try {
          if (status !== "completed" && status !== "failed") throw new Error("pcm_timeline_status_invalid");
          if (status === "failed" && !reason.trim()) throw new Error("pcm_timeline_failure_reason_missing");
          stream.productionFailure = status === "failed" ? reason : null;
          output.finish(totalSamples);
          stream.finished = true;
          options.runtime.markAudioTimelineDuration(turnId, messageId, output.clock.getDurationMs());
        } catch (error) {
          settle(stream, "failed", "pcm_timeline_end_invalid");
          throw error;
        }
      },
    };
  }

  return { open, isActive: () => streams.size > 0 };
}
