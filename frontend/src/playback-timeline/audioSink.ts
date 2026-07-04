import {
  getActiveAudioPlaybackClock,
  startAudioPlayback,
  stopAudioPlaybackRuntime,
  type RuntimeAudioPlaybackClock,
} from "../adapter-connection/runtime/audioPlayback.js";
import type { AudioPlaybackClock } from "./contracts.js";
import {
  createBrowserLipSyncTimelineSink,
  type PlaybackTimelineLipSyncSink,
} from "./lipSyncSink.js";

export interface PlaybackTimelineAudioStartCallbacks {
  onLipSyncUnavailable?: () => void;
  onLipSyncStarted?: () => void;
  onLipSyncTerminal?: (
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ) => void;
  onDurationChanged?: (durationMs: number | null) => void;
  onPlaybackStarted?: (event: { startedAtMs: number; durationMs: number | null }) => void;
  onEnded?: () => void;
  onError?: () => void;
}

export interface PlaybackTimelineAudioSink {
  start(audioUrl: string, callbacks?: PlaybackTimelineAudioStartCallbacks): Promise<void>;
  stop(): void;
  getClock(): AudioPlaybackClock | null;
}

function adaptClock(clock: RuntimeAudioPlaybackClock): AudioPlaybackClock {
  return {
    getCurrentTimeMs: () => clock.getCurrentTimeMs(),
    getDurationMs: () => clock.getDurationMs(),
    getPlaybackRate: () => clock.getPlaybackRate(),
    isPlaying: () => clock.isPlaying(),
  };
}

export function createBrowserAudioTimelineSink(
  lipSyncSink: PlaybackTimelineLipSyncSink = createBrowserLipSyncTimelineSink(),
): PlaybackTimelineAudioSink {
  return {
    async start(audioUrl, callbacks = {}) {
      let lipSyncTerminalSettled = false;
      let lipSyncStarted = false;
      const settleLipSyncTerminal = (
        terminal: "completed" | "failed" | "interrupted",
        reason: string,
      ) => {
        if (lipSyncTerminalSettled) {
          return;
        }
        lipSyncTerminalSettled = true;
        callbacks.onLipSyncTerminal?.(terminal, reason);
      };
      lipSyncSink.stop();
      await startAudioPlayback(audioUrl, {
        onAudioElementCreated: (event) => {
          lipSyncSink.attachAudio({
            audioUrl,
            audio: event.audio,
            getAudioCurrentTimeSeconds: event.getAudioCurrentTimeSeconds,
            isCurrentAudio: event.isCurrentAudio,
            onStarted: () => {
              if (lipSyncTerminalSettled) {
                return;
              }
              lipSyncStarted = true;
              callbacks.onLipSyncStarted?.();
            },
            onUnavailable: () => {
              callbacks.onLipSyncUnavailable?.();
              settleLipSyncTerminal("failed", "lip_sync_unavailable");
            },
          });
        },
        onAudioElementDisposed: () => {
          lipSyncSink.stop();
        },
        onDurationChanged: (durationMs) => callbacks.onDurationChanged?.(durationMs),
        onPlaybackStarted: (event) => {
          void lipSyncSink.resume().catch(() => {
            settleLipSyncTerminal("failed", "lip_sync_resume_failed");
          });
          callbacks.onPlaybackStarted?.(event);
        },
        onEnded: () => {
          settleLipSyncTerminal(
            lipSyncStarted ? "completed" : "failed",
            lipSyncStarted
              ? "audio_playback_completed"
              : "lip_sync_not_started_before_audio_end",
          );
          callbacks.onEnded?.();
        },
        onError: () => {
          settleLipSyncTerminal("failed", "audio_playback_error");
          callbacks.onError?.();
        },
      });
    },
    stop() {
      lipSyncSink.stop();
      stopAudioPlaybackRuntime();
    },
    getClock() {
      const clock = getActiveAudioPlaybackClock();
      return clock ? adaptClock(clock) : null;
    },
  };
}
