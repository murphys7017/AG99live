import type {
  PlaybackTimelineAudioSink,
  PlaybackTimelineAudioStartCallbacks,
} from "./audioSink.js";
import type {
  PlaybackTimelineAudioLipSyncSink,
} from "./audioLipSyncCoordinator.js";

export interface PlaybackTimelineAudioSegmentSinkCallbacks {
  onDurationChanged?: PlaybackTimelineAudioStartCallbacks["onDurationChanged"];
  onPlaybackStarted?: PlaybackTimelineAudioStartCallbacks["onPlaybackStarted"];
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
            lipSyncSink.attachAudio(event);
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
            if (options.startLipSyncTimelineSink) {
              options.startLipSyncTimelineSink(
                turnId,
                messageId,
                () => {
                  lipSyncSink.start();
                  return true;
                },
              );
            } else {
              lipSyncSink.start();
            }
            callbacks.onPlaybackStarted?.(event);
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
