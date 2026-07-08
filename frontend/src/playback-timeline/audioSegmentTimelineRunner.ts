import type {
  PlaybackTimelineAudioSegmentSink,
  PlaybackTimelineAudioSegmentSinkCallbacks,
} from "./audioSegmentPlaybackSink.js";
import type {
  PlaybackTimelineRuntime,
} from "./playbackTimelineRuntime.js";

export interface PlaybackTimelineAudioSegmentRunnerCallbacks {
  onDurationChanged?: PlaybackTimelineAudioSegmentSinkCallbacks["onDurationChanged"];
  onPlaybackStarted?: PlaybackTimelineAudioSegmentSinkCallbacks["onPlaybackStarted"];
  onEnded?: () => void;
  onError?: () => void;
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

export function createPlaybackTimelineAudioSegmentRunner(options: {
  runtime: PlaybackTimelineRuntime;
  audioSegmentSink: PlaybackTimelineAudioSegmentSink;
}): PlaybackTimelineAudioSegmentRunner {
  return {
    async start(audioUrl, turnId, messageId, callbacks = {}) {
      options.runtime.prepareAudioTimeline(turnId, messageId);
      try {
        await options.audioSegmentSink.start(audioUrl, turnId, messageId, {
          onDurationChanged: (durationMs) => {
            options.runtime.markAudioTimelineDuration(
              turnId,
              messageId,
              durationMs,
            );
            callbacks.onDurationChanged?.(durationMs);
          },
          onPlaybackStarted: (event) => {
            options.runtime.markAudioTimelineStarted(
              turnId,
              messageId,
              event.startedAtMs,
              event.durationMs,
            );
            callbacks.onPlaybackStarted?.(event);
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
            callbacks.onError?.();
          },
        });
      } catch (error) {
        options.runtime.markAudioTimelineTerminal(
          turnId,
          messageId,
          "failed",
          "audio_autoplay_blocked",
        );
        throw error;
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
