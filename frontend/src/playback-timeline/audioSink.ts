import {
  getActiveAudioPlaybackClock,
  startAudioPlayback,
  stopAudioPlaybackRuntime,
  type RuntimeAudioPlaybackClock,
} from "../adapter-connection/runtime/audioPlayback.js";
import type { AudioPlaybackClock } from "./contracts.js";

export interface PlaybackTimelineAudioStartCallbacks {
  onLipSyncUnavailable?: () => void;
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

export function createBrowserAudioTimelineSink(): PlaybackTimelineAudioSink {
  return {
    async start(audioUrl, callbacks = {}) {
      await startAudioPlayback(audioUrl, {
        onLipSyncUnavailable: () => callbacks.onLipSyncUnavailable?.(),
        onDurationChanged: (durationMs) => callbacks.onDurationChanged?.(durationMs),
        onPlaybackStarted: (event) => callbacks.onPlaybackStarted?.(event),
        onEnded: () => callbacks.onEnded?.(),
        onError: () => callbacks.onError?.(),
      });
    },
    stop() {
      stopAudioPlaybackRuntime();
    },
    getClock() {
      const clock = getActiveAudioPlaybackClock();
      return clock ? adaptClock(clock) : null;
    },
  };
}
