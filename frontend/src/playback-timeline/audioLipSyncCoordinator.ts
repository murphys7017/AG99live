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
      console.error("[PlaybackTimeline] lip sync unavailable.", {
        turnId: options.turnId,
        messageId: options.messageId,
        reason,
        degraded,
      });
      options.pushHistory(
        "system",
        degraded
          ? `嘴型同步不可用：${reason}。语音随动继续使用可用的声学信号。`
          : `嘴型同步加载失败：${reason}。`,
      );
    },
    onStarted: () => {
      console.info("[PlaybackTimeline] lip sync started.", {
        turnId: options.turnId,
        messageId: options.messageId,
      });
      options.markLipSyncTimelineStarted(
        options.turnId,
        options.messageId,
      );
    },
    onTerminal: (terminal, reason) => {
      console.info("[PlaybackTimeline] lip sync terminal.", {
        turnId: options.turnId,
        messageId: options.messageId,
        terminal,
        reason,
      });
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
      console.info("[PlaybackTimeline] lip sync audio attached.", {
        turnId: options.turnId,
        messageId: options.messageId,
        audioUrl: event.audioUrl,
      });
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
