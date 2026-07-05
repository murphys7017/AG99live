import type {
  PendingAudioItem,
} from "../../playback-timeline/playbackReleaseQueue.js";
import {
  queueAudioForPlayback as queuePendingAudioForPlayback,
} from "../../playback-timeline/playbackReleaseQueue.js";
import {
  createQueuedAudioSegmentSink,
} from "../../playback-timeline/segmentReleaseSinks.js";

export interface AdapterAudioQueueState {
  statusMessage: string;
  pendingAudios: Map<string, PendingAudioItem>;
}

export interface AdapterAudioQueueControllerDeps {
  state: AdapterAudioQueueState;
  pushHistory: (role: string, text: string) => void;
  startAudioPlayback: (
    audioUrl: string,
    turnId: string | null,
    messageId: string,
  ) => void;
}

export function createAdapterAudioQueueController(
  deps: AdapterAudioQueueControllerDeps,
) {
  const queuedAudioSegmentSink = createQueuedAudioSegmentSink({
    state: deps.state,
    startAudioPlayback: deps.startAudioPlayback,
  });

  return {
    queueAudioForPlayback(
      audioUrl: string,
      turnId: string | null,
      messageId: string,
    ): void {
      queuePendingAudioForPlayback(
        deps.state.pendingAudios,
        audioUrl,
        turnId,
        messageId,
      );
      deps.state.statusMessage = "收到语音回复，等待同步播放。";
      deps.pushHistory("system", deps.state.statusMessage);
    },
    releaseAudioForPlayback(
      messageId: string,
      turnId: string | null,
    ): boolean {
      return queuedAudioSegmentSink.releaseAudioForPlayback(messageId, turnId);
    },
  };
}
