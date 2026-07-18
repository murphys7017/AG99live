import type {
  AudioPlaybackClock,
  PlaybackClockSnapshot,
} from "./contracts.js";

interface TimelineClockOptions {
  now?: () => number;
}

export interface TimelineClock {
  reset(): void;
  start(startedAtMs?: number): void;
  pause(pausedAtMs?: number): void;
  resume(resumedAtMs?: number): void;
  stop(stoppedAtMs?: number): void;
  attachAudioClock(clock: AudioPlaybackClock): void;
  detachAudioClock(): void;
  setExpectedDurationMs(durationMs: number | null): void;
  snapshot(): PlaybackClockSnapshot;
}

export function createTimelineClock(
  options: TimelineClockOptions = {},
): TimelineClock {
  const now = options.now ?? (() => performance.now());
  let startedAtMs: number | null = null;
  let pausedAtMs: number | null = null;
  let stoppedAtMs: number | null = null;
  let pausedOffsetMs = 0;
  let audioClock: AudioPlaybackClock | null = null;
  let expectedDurationMs: number | null = null;

  function getSyntheticCurrentTimeMs(atMs: number): number {
    if (startedAtMs === null) {
      return 0;
    }
    const effectiveNowMs = pausedAtMs ?? stoppedAtMs ?? atMs;
    return Math.max(0, effectiveNowMs - startedAtMs - pausedOffsetMs);
  }

  function getAudioSnapshot(): PlaybackClockSnapshot | null {
    if (pausedAtMs !== null || stoppedAtMs !== null) {
      return null;
    }
    if (!audioClock) {
      return null;
    }
    const currentTimeMs = audioClock.getCurrentTimeMs();
    if (currentTimeMs === null) {
      return null;
    }
    return {
      startedAtMs,
      currentTimeMs: Math.max(0, currentTimeMs),
      durationMs: audioClock.getDurationMs() ?? expectedDurationMs,
      playbackRate: audioClock.getPlaybackRate(),
      clockSource: "audio",
      paused: !audioClock.isPlaying(),
      stopped: stoppedAtMs !== null,
    };
  }

  return {
    reset() {
      startedAtMs = null;
      pausedAtMs = null;
      stoppedAtMs = null;
      pausedOffsetMs = 0;
      audioClock = null;
      expectedDurationMs = null;
    },
    start(startedAtMsOverride) {
      const atMs = startedAtMsOverride ?? now();
      startedAtMs = atMs;
      pausedAtMs = null;
      stoppedAtMs = null;
      pausedOffsetMs = 0;
    },
    pause(pausedAtMsOverride) {
      if (startedAtMs === null || pausedAtMs !== null || stoppedAtMs !== null) {
        return;
      }
      pausedAtMs = pausedAtMsOverride ?? now();
    },
    resume(resumedAtMsOverride) {
      if (startedAtMs === null || pausedAtMs === null || stoppedAtMs !== null) {
        return;
      }
      const atMs = resumedAtMsOverride ?? now();
      pausedOffsetMs += Math.max(0, atMs - pausedAtMs);
      pausedAtMs = null;
    },
    stop(stoppedAtMsOverride) {
      if (startedAtMs === null || stoppedAtMs !== null) {
        return;
      }
      stoppedAtMs = stoppedAtMsOverride ?? now();
    },
    attachAudioClock(clock) {
      audioClock = clock;
    },
    detachAudioClock() {
      audioClock = null;
    },
    setExpectedDurationMs(durationMs) {
      expectedDurationMs = durationMs !== null && Number.isFinite(durationMs)
        ? Math.max(0, durationMs)
        : null;
    },
    snapshot() {
      const audioSnapshot = getAudioSnapshot();
      if (audioSnapshot) {
        return audioSnapshot;
      }
      const atMs = now();
      const audioUnavailable = Boolean(
        audioClock
        && pausedAtMs === null
        && stoppedAtMs === null,
      );
      const audioPending = audioClock !== null && startedAtMs === null;
      return {
        startedAtMs,
        currentTimeMs: getSyntheticCurrentTimeMs(atMs),
        durationMs: expectedDurationMs,
        playbackRate: 1,
        clockSource: audioPending
          ? "audio_pending"
          : audioUnavailable
            ? "audio_unavailable"
            : "synthetic",
        paused: pausedAtMs !== null,
        stopped: stoppedAtMs !== null,
      };
    },
  };
}
