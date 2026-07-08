import type {
  PendingAudioItem,
} from "./playbackReleaseQueue.js";
import {
  queueAudioForPlayback as queuePendingAudioForPlayback,
} from "./playbackReleaseQueue.js";
import {
  createQueuedAudioSegmentSink,
} from "./segmentReleaseSinks.js";

export interface PlaybackTimelineAudioReleaseState {
  pendingAudios: Map<string, PendingAudioItem>;
}

export interface PlaybackTimelineAudioReleaseControllerOptions {
  state: PlaybackTimelineAudioReleaseState;
  onAudioQueued?: () => void;
  startAudioPlayback(
    audioUrl: string,
    turnId: string | null,
    messageId: string,
  ): void;
}

export interface PlaybackTimelineAudioReleaseController {
  queueAudioForPlayback(
    audioUrl: string,
    turnId: string | null,
    messageId: string,
  ): void;
  releaseAudioForPlayback(
    messageId: string,
    turnId: string | null,
  ): boolean;
}

export function createPlaybackTimelineAudioReleaseController(
  options: PlaybackTimelineAudioReleaseControllerOptions,
): PlaybackTimelineAudioReleaseController {
  const queuedAudioSegmentSink = createQueuedAudioSegmentSink({
    state: options.state,
    startAudioPlayback: options.startAudioPlayback,
  });

  return {
    queueAudioForPlayback(audioUrl, turnId, messageId) {
      queuePendingAudioForPlayback(
        options.state.pendingAudios,
        audioUrl,
        turnId,
        messageId,
      );
      options.onAudioQueued?.();
    },
    releaseAudioForPlayback(messageId, turnId) {
      return queuedAudioSegmentSink.releaseAudioForPlayback(messageId, turnId);
    },
  };
}
