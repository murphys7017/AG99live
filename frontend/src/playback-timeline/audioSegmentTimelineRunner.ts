import type {
  PlaybackTimelineAudioSegmentSink,
  PlaybackTimelineAudioSegmentSinkCallbacks,
} from "./audioSegmentPlaybackSink.js";
import type {
  PlaybackTimelineRuntime,
} from "./playbackTimelineRuntime.js";

export interface PlaybackTimelineAudioSegmentRunnerCallbacks {
  onAudioElementCreated?: PlaybackTimelineAudioSegmentSinkCallbacks["onAudioElementCreated"];
  onDurationChanged?: PlaybackTimelineAudioSegmentSinkCallbacks["onDurationChanged"];
  onPlaybackStarted?: PlaybackTimelineAudioSegmentSinkCallbacks["onPlaybackStarted"];
  onEnded?: () => void;
  onError?: (reason: string) => void;
}

export interface PlaybackTimelineAudioSegmentRunner {
  start(
    audioUrl: string,
    turnId: string | null,
    messageId: string,
    callbacks?: PlaybackTimelineAudioSegmentRunnerCallbacks,
  ): Promise<void>;
  stop(
    turnId: string | null,
    messageId: string | null,
    reason: string,
  ): void;
}

function resolveAudioStartFailureReason(error: unknown): string {
  const name = error instanceof Error
    ? error.name
    : typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : "unknown";
  if (name === "NotAllowedError") {
    return "audio_autoplay_blocked";
  }
  if (name === "AbortError") {
    return "audio_playback_aborted";
  }
  return `audio_sink_start_failed:${name || "unknown"}`;
}

export function createPlaybackTimelineAudioSegmentRunner<TMotionPayload = unknown>(options: {
  runtime: PlaybackTimelineRuntime<TMotionPayload>;
  audioSegmentSink: PlaybackTimelineAudioSegmentSink;
}): PlaybackTimelineAudioSegmentRunner {
  return {
    async start(audioUrl, turnId, messageId, callbacks = {}) {
      try {
        options.runtime.setAudioTimelineInterruptHandler(
          turnId,
          messageId,
          () => options.audioSegmentSink.stop(),
        );

        await options.audioSegmentSink.start(audioUrl, turnId, messageId, {
          onAudioElementCreated: (event) => {
            options.runtime.attachAudioTimelineClock(
              turnId,
              messageId,
              event.clock,
            );
            callbacks.onAudioElementCreated?.(event);
          },
          onDurationChanged: (durationMs) => {
            options.runtime.markAudioTimelineDuration(
              turnId,
              messageId,
              durationMs,
            );
            callbacks.onDurationChanged?.(durationMs);
          },
          onPlaybackStarted: (event) => {
            const timelineActive = options.runtime.markAudioTimelineStarted(
              turnId,
              messageId,
              event.startedAtMs,
              event.durationMs,
              event.clock,
            );
            if (!timelineActive) {
              return false;
            }
            callbacks.onPlaybackStarted?.(event);
            return true;
          },
          onEnded: () => {
            options.runtime.markAudioTimelineTerminal(
              turnId,
              messageId,
              "completed",
              "audio_playback_completed",
            );
            callbacks.onEnded?.();
          },
          onError: () => {
            options.runtime.markAudioTimelineTerminal(
              turnId,
              messageId,
              "failed",
              "audio_playback_error",
            );
            callbacks.onError?.("audio_playback_error");
          },
        });
      } catch (error) {
        const reason = resolveAudioStartFailureReason(error);
        options.runtime.markAudioTimelineTerminal(
          turnId,
          messageId,
          "failed",
          reason,
        );
        callbacks.onError?.(reason);
        console.error("[PlaybackTimelineAudioSegmentRunner] audio sink start failed.", error);
      }
    },
    stop(turnId, messageId, reason) {
      options.audioSegmentSink.stop();
      if (!messageId) {
        return;
      }
      options.runtime.stopTimelineForSegment(turnId, messageId, reason);
    },
  };
}
