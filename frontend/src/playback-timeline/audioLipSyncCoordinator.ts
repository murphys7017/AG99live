import type {
  PlaybackTimelineAudioElementContext,
} from "./audioSink.js";
import type {
  PlaybackTimelineLipSyncRuntime,
  PlaybackTimelineLipSyncRuntimeCallbacks,
} from "./lipSyncSink.js";

export interface PlaybackTimelineAudioLipSyncSink {
  attachAudio(event: PlaybackTimelineAudioElementContext): void;
  start(): void;
  completeAfterAudioEnded(): void;
  failAfterAudioError(): void;
  interrupt?(reason: string): void;
  dispose?(): void;
  stop(): void;
}

export function createPlaybackTimelineAudioLipSyncSink(options: {
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
}): PlaybackTimelineAudioLipSyncSink {
  const lipSyncRuntime = options.createLipSyncRuntime({
    onUnavailable: (reason, degraded) => {
      options.pushHistory(
        "system",
        degraded
          ? `嘴型同步加载失败：${reason}。已切换为随机开合。`
          : `嘴型同步加载失败：${reason}。`,
      );
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
    start() {
      void lipSyncRuntime.resume();
    },
    completeAfterAudioEnded() {
      lipSyncRuntime.completeAfterAudioEnded();
    },
    failAfterAudioError() {
      lipSyncRuntime.failAfterAudioError();
    },
    interrupt(reason) {
      lipSyncRuntime.interrupt?.(reason);
      if (!lipSyncRuntime.interrupt) {
        lipSyncRuntime.stop();
      }
    },
    dispose() {
      if (lipSyncRuntime.dispose) {
        lipSyncRuntime.dispose();
      } else {
        lipSyncRuntime.stop();
      }
    },
    stop() {
      lipSyncRuntime.stop();
    },
  };
}
