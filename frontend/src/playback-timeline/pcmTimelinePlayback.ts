import type { PlaybackTimelineAudioLipSyncSink } from "./audioLipSyncCoordinator.js";
import type { PlaybackTimelineRuntime } from "./playbackTimelineRuntime.js";
import type { PcmOutputSession } from "./pcmOutputSession.js";
import type { SpeechOutputRuntime } from "./speechOutputRuntime.js";

export interface PcmTimelineStream {
  readonly completed: Promise<void>;
  append(sampleOffset: number, pcm: Uint8Array): Promise<void>;
  finish(totalSamples: number, status: "completed" | "failed", reason?: string): void;
}

interface ActiveStream {
  turnId: string;
  messageId: string;
  output: PcmOutputSession;
  lipSync: PlaybackTimelineAudioLipSyncSink;
  productionFailure: string | null;
  terminal: boolean;
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

  function settle(stream: ActiveStream, terminal: "completed" | "failed" | "interrupted", reason: string): void {
    if (stream.terminal) return;
    stream.terminal = true;
    const errors: unknown[] = [];
    try {
      if (terminal === "completed") stream.lipSync.completeAfterAudioEnded();
      else if (terminal === "interrupted") {
        if (stream.lipSync.interrupt) stream.lipSync.interrupt(reason);
        else stream.lipSync.stop();
      } else stream.lipSync.failAfterAudioError();
    } catch (error) { errors.push(error); }
    try {
      if (stream.lipSync.dispose) stream.lipSync.dispose();
      else stream.lipSync.stop();
    } catch (error) { errors.push(error); }
    try {
      stream.output.dispose();
    } catch (error) { errors.push(error); }
    if (active === stream) active = null;
    try {
      if (terminal === "failed") options.onFailed(reason);
      else options.onEnded();
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
    if (active || options.runtime.findOpenAudioTimelineSegments().length) {
      throw new Error("pcm_timeline_previous_audio_unsettled");
    }
    const output = options.speechOutput.attachPcm();
    let lipSync: PlaybackTimelineAudioLipSyncSink;
    try {
      lipSync = options.createLipSyncSink(turnId, messageId);
    } catch (error) {
      output.dispose();
      throw error;
    }
    const stream: ActiveStream = {
      turnId, messageId, output,
      lipSync,
      productionFailure: null,
      terminal: false,
    };
    active = stream;
    // Observe both promises immediately; cancellation during preparation must
    // not leave an unhandled rejection or a later callback for the next segment.
    const started = output.started.then((atMs) => {
      if (stream.terminal) return;
      const durationMs = output.clock.getDurationMs();
      if (!options.runtime.markAudioTimelineStarted(turnId, messageId, atMs, durationMs, output.clock)) {
        throw new Error("pcm_timeline_start_rejected");
      }
      options.runtime.startLipSyncTimelineSink(turnId, messageId, () => {
        stream.lipSync.start();
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
    try {
      options.onPreparing();
      let preparation: Promise<void> = Promise.resolve();
      const accepted = options.runtime.startAudioTimelineSink(turnId, messageId, {
        start: () => {
          preparation = output.prepare();
          void preparation.catch(() => undefined);
          return true;
        },
        onInterrupt: (reason) => settle(stream, "interrupted", reason),
      });
      if (accepted === false) throw new Error("pcm_timeline_sink_rejected");
      options.runtime.attachAudioTimelineClock(turnId, messageId, output.clock);
      stream.lipSync.attachAudio({
        audioUrl: null,
        clock: output.clock,
        getAudioCurrentTimeSeconds: () => (output.clock.getCurrentTimeMs() ?? 0) / 1000,
        isCurrentAudio: () => active === stream && !stream.terminal,
        speechOutput: output,
      });
      await Promise.all([preparation, stream.lipSync.prepare()]);
      if (stream.terminal) throw new DOMException("PCM playback interrupted.", "AbortError");
    } catch (error) {
      settle(stream, "failed", "pcm_timeline_prepare_failed");
      throw error;
    }
    return {
      completed,
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
          options.runtime.markAudioTimelineDuration(turnId, messageId, output.clock.getDurationMs());
        } catch (error) {
          settle(stream, "failed", "pcm_timeline_end_invalid");
          throw error;
        }
      },
    };
  }

  return { open, isActive: () => active !== null };
}
