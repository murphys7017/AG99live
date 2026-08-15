export interface PlaybackTimelineLipSyncAttachOptions {
  audioUrl: string;
  audio: HTMLAudioElement;
  getAudioCurrentTimeSeconds: () => number;
  isCurrentAudio: () => boolean;
  onStarted: () => void;
  onUnavailable: (reason: string, degraded: boolean) => void;
}

export interface PlaybackTimelineLipSyncSink {
  attachAudio(options: PlaybackTimelineLipSyncAttachOptions): void;
  resume(): Promise<void>;
  stop(): void;
}

export interface PlaybackTimelineLipSyncRuntimeCallbacks {
  onUnavailable?: (reason: string, degraded: boolean) => void;
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

  const notify = (
    phase: "started" | "unavailable" | "terminal",
    callback: (() => void) | undefined,
  ): void => {
    try {
      callback?.();
    } catch (error) {
      console.error(`[PlaybackTimeline] lip sync ${phase} observer failed.`, error);
    }
  };

  const settleTerminal = (
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ): void => {
    if (terminalSettled) {
      return;
    }
    terminalSettled = true;
    notify("terminal", () => callbacks.onTerminal?.(terminal, reason));
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
          notify("started", callbacks.onStarted);
        },
        onUnavailable: (reason, degraded) => {
          notify("unavailable", () => callbacks.onUnavailable?.(reason, degraded));
          if (!degraded) {
            settleTerminal("failed", reason);
          }
        },
      });
    },
    async resume() {
      try {
        await sink.resume();
      } catch (error) {
        const name = error instanceof Error && error.name
          ? error.name
          : "unknown";
        settleTerminal("failed", `lip_sync_resume_failed:${name}`);
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
