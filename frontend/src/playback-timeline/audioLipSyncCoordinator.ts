import type {
  PlaybackTimelineAudioElementContext,
} from "./audioSink.js";
import type {
  PlaybackTimelineLipSyncRuntime,
  PlaybackTimelineLipSyncRuntimeCallbacks,
} from "./lipSyncSink.js";

export interface PlaybackTimelineAudioLipSyncCoordinator {
  attachAudio(event: PlaybackTimelineAudioElementContext): void;
  resume(): void;
  completeAfterAudioEnded(): void;
  failAfterAudioError(): void;
  stop(): void;
}

export function createPlaybackTimelineAudioLipSyncCoordinator(options: {
  turnId: string | null;
  messageId: string;
  pushHistory: (role: string, text: string) => void;
  createLipSyncRuntime: (
    callbacks: PlaybackTimelineLipSyncRuntimeCallbacks,
  ) => PlaybackTimelineLipSyncRuntime;
  markLipSyncTimelineStarted: (
    turnId: string | null,
    messageId: string,
  ) => void;
  markLipSyncTimelineTerminal: (
    turnId: string | null,
    messageId: string,
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ) => void;
}): PlaybackTimelineAudioLipSyncCoordinator {
  const lipSyncRuntime = options.createLipSyncRuntime({
    onUnavailable: () => {
      options.pushHistory("system", "嘴型同步加载失败，音频播放将无对应张嘴动作。");
    },
    onStarted: () => {
      options.markLipSyncTimelineStarted(
        options.turnId,
        options.messageId,
      );
    },
    onTerminal: (terminal, reason) => {
      options.markLipSyncTimelineTerminal(
        options.turnId,
        options.messageId,
        terminal,
        reason,
      );
    },
  });

  return {
    attachAudio(event) {
      lipSyncRuntime.attachAudio({
        audioUrl: event.audioUrl,
        audio: event.audio,
        getAudioCurrentTimeSeconds: event.getAudioCurrentTimeSeconds,
        isCurrentAudio: event.isCurrentAudio,
      });
    },
    resume() {
      void lipSyncRuntime.resume();
    },
    completeAfterAudioEnded() {
      lipSyncRuntime.completeAfterAudioEnded();
    },
    failAfterAudioError() {
      lipSyncRuntime.failAfterAudioError();
    },
    stop() {
      lipSyncRuntime.stop();
    },
  };
}
