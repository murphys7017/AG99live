import type {
  PlaybackTimelineAudioSink,
  PlaybackTimelineAudioStartCallbacks,
} from "./audioSink.js";
import type {
  PlaybackTimelineAudioLipSyncSink,
} from "./audioLipSyncCoordinator.js";

export interface PlaybackTimelineAudioSegmentSinkCallbacks {
  onAudioElementCreated?: PlaybackTimelineAudioStartCallbacks["onAudioElementCreated"];
  onDurationChanged?: PlaybackTimelineAudioStartCallbacks["onDurationChanged"];
  onPlaybackStarted?: (
    event: Parameters<NonNullable<PlaybackTimelineAudioStartCallbacks["onPlaybackStarted"]>>[0],
  ) => boolean | void;
  onEnded?: () => void;
  onError?: () => void;
}

export interface PlaybackTimelineAudioSegmentSink {
  start(
    audioUrl: string,
    turnId: string | null,
    messageId: string,
    callbacks?: PlaybackTimelineAudioSegmentSinkCallbacks,
  ): Promise<void>;
  stop(): void;
}

export function createPlaybackTimelineAudioSegmentSink(options: {
  audioSink: PlaybackTimelineAudioSink;
  startLipSyncTimelineSink?: (
    turnId: string | null,
    messageId: string,
    start: () => boolean | void,
  ) => boolean | void;
  createLipSyncSink: (
    turnId: string | null,
    messageId: string,
  ) => PlaybackTimelineAudioLipSyncSink;
}): PlaybackTimelineAudioSegmentSink {
  let activeLipSyncSink: PlaybackTimelineAudioLipSyncSink | null = null;

  function stopActiveLipSyncSink(): void {
    if (activeLipSyncSink?.interrupt) {
      activeLipSyncSink.interrupt("audio_playback_replaced");
    } else {
      activeLipSyncSink?.stop();
    }
    activeLipSyncSink = null;
  }

  return {
    async start(audioUrl, turnId, messageId, callbacks = {}) {
      stopActiveLipSyncSink();
      const lipSyncSink = options.createLipSyncSink(turnId, messageId);
      activeLipSyncSink = lipSyncSink;
      try {
        await options.audioSink.start(audioUrl, {
          onAudioElementCreated: (event) => {
            console.info("[PlaybackTimeline] audio element created; attaching lip sync.", {
              turnId,
              messageId,
              audioUrl,
            });
            lipSyncSink.attachAudio(event);
            callbacks.onAudioElementCreated?.(event);
          },
          onAudioElementDisposed: () => {
            if (lipSyncSink.dispose) {
              lipSyncSink.dispose();
            } else {
              lipSyncSink.stop();
            }
            if (activeLipSyncSink === lipSyncSink) {
              activeLipSyncSink = null;
            }
          },
          onDurationChanged: callbacks.onDurationChanged,
          onPlaybackStarted: (event) => {
            const timelineActive = callbacks.onPlaybackStarted?.(event) !== false;
            console.info("[PlaybackTimeline] audio playback callback received.", {
              turnId,
              messageId,
              startedAtMs: event.startedAtMs,
              durationMs: event.durationMs,
              timelineActive,
            });
            if (!timelineActive) {
              console.error("[PlaybackTimeline] lip sync start skipped because audio timeline is inactive.", {
                turnId,
                messageId,
              });
              return;
            }
            if (options.startLipSyncTimelineSink) {
              const accepted = options.startLipSyncTimelineSink(
                turnId,
                messageId,
                () => {
                  lipSyncSink.start();
                  return true;
                },
              );
              console.info("[PlaybackTimeline] lip sync timeline start requested.", {
                turnId,
                messageId,
                accepted: accepted !== false,
              });
            } else {
              lipSyncSink.start();
            }
          },
          onEnded: () => {
            lipSyncSink.completeAfterAudioEnded();
            callbacks.onEnded?.();
          },
          onError: () => {
            lipSyncSink.failAfterAudioError();
            callbacks.onError?.();
          },
        });
      } catch (error) {
        lipSyncSink.failAfterAudioError();
        throw error;
      }
    },
    stop() {
      stopActiveLipSyncSink();
      options.audioSink.stop();
    },
  };
}
