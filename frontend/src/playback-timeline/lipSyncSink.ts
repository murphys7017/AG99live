export interface PlaybackTimelineLipSyncAttachOptions {
  audioUrl: string;
  audio: HTMLAudioElement;
  getAudioCurrentTimeSeconds: () => number;
  isCurrentAudio: () => boolean;
  onStarted: () => void;
  onUnavailable: () => void;
}

export interface PlaybackTimelineLipSyncSink {
  attachAudio(options: PlaybackTimelineLipSyncAttachOptions): void;
  resume(): Promise<void>;
  stop(): void;
}

export interface PlaybackTimelineLipSyncRuntimeCallbacks {
  onUnavailable?: () => void;
  onStarted?: () => void;
  onTerminal?: (
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ) => void;
}

export interface PlaybackTimelineLipSyncRuntime {
  attachAudio(options: Omit<
    PlaybackTimelineLipSyncAttachOptions,
    "onStarted" | "onUnavailable"
  >): void;
  resume(): Promise<void>;
  completeAfterAudioEnded(): void;
  failAfterAudioError(): void;
  interrupt?(reason: string): void;
  dispose?(): void;
  stop(): void;
}

export function createPlaybackTimelineLipSyncRuntime(
  sink: PlaybackTimelineLipSyncSink,
  callbacks: PlaybackTimelineLipSyncRuntimeCallbacks = {},
): PlaybackTimelineLipSyncRuntime {
  let terminalSettled = false;
  let started = false;

  const settleTerminal = (
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ): void => {
    if (terminalSettled) {
      return;
    }
    terminalSettled = true;
    callbacks.onTerminal?.(terminal, reason);
  };

  return {
    attachAudio(options) {
      sink.stop();
      terminalSettled = false;
      started = false;
      sink.attachAudio({
        ...options,
        onStarted: () => {
          if (terminalSettled) {
            return;
          }
          started = true;
          callbacks.onStarted?.();
        },
        onUnavailable: () => {
          callbacks.onUnavailable?.();
          settleTerminal("failed", "lip_sync_unavailable");
        },
      });
    },
    async resume() {
      try {
        await sink.resume();
      } catch (_error) {
        settleTerminal("failed", "lip_sync_resume_failed");
      }
    },
    completeAfterAudioEnded() {
      settleTerminal(
        started ? "completed" : "failed",
        started
          ? "audio_playback_completed"
          : "lip_sync_not_started_before_audio_end",
      );
    },
    failAfterAudioError() {
      settleTerminal("failed", "audio_playback_error");
    },
    interrupt(reason) {
      settleTerminal("interrupted", reason);
      sink.stop();
    },
    dispose() {
      sink.stop();
    },
    stop() {
      settleTerminal("interrupted", "lip_sync_stopped");
      sink.stop();
    },
  };
}
