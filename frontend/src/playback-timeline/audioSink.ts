import type { AudioPlaybackClock } from "./contracts.js";

export interface AudioPlaybackStartedEvent {
  startedAtMs: number;
  durationMs: number | null;
  clock: AudioPlaybackClock;
}

export interface RuntimeAudioPlaybackClock {
  getCurrentTimeMs(): number | null;
  getDurationMs(): number | null;
  getPlaybackRate(): number;
  isPlaying(): boolean;
}

export interface PlaybackTimelineAudioElementContext {
  audioUrl: string;
  audio: HTMLAudioElement;
  getAudioCurrentTimeSeconds: () => number;
  isCurrentAudio: () => boolean;
}

export interface PlaybackTimelineAudioStartCallbacks {
  onAudioElementCreated?: (event: PlaybackTimelineAudioElementContext) => void;
  onAudioElementDisposed?: () => void;
  onDurationChanged?: (durationMs: number | null) => void;
  onPlaybackStarted?: (event: AudioPlaybackStartedEvent) => void;
  onEnded?: () => void;
  onError?: () => void;
}

export interface PlaybackTimelineAudioSink {
  start(audioUrl: string, callbacks?: PlaybackTimelineAudioStartCallbacks): Promise<void>;
  stop(): void;
}

let activeAudioElement: HTMLAudioElement | null = null;

interface AudioElementClockSource {
  currentTime: number;
  duration: number;
  playbackRate: number;
  paused: boolean;
  ended: boolean;
}

export function createAudioElementPlaybackClock(
  audio: AudioElementClockSource,
): RuntimeAudioPlaybackClock {
  return {
    getCurrentTimeMs: () => Number.isFinite(audio.currentTime)
      ? Math.max(0, Math.round(audio.currentTime * 1000))
      : null,
    getDurationMs: () => Number.isFinite(audio.duration) && audio.duration > 0
      ? Math.max(0, Math.round(audio.duration * 1000))
      : null,
    getPlaybackRate: () => Number.isFinite(audio.playbackRate) && audio.playbackRate > 0
      ? audio.playbackRate
      : 1,
    isPlaying: () => !audio.paused && !audio.ended,
  };
}

function adaptClock(clock: RuntimeAudioPlaybackClock): AudioPlaybackClock {
  return {
    getCurrentTimeMs: () => clock.getCurrentTimeMs(),
    getDurationMs: () => clock.getDurationMs(),
    getPlaybackRate: () => clock.getPlaybackRate(),
    isPlaying: () => clock.isPlaying(),
  };
}

async function startBrowserAudioPlayback(
  audioUrl: string,
  callbacks: PlaybackTimelineAudioStartCallbacks,
): Promise<void> {
  stopBrowserAudioPlayback();

  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.src = audioUrl;
  activeAudioElement = audio;
  const clock = adaptClock(createAudioElementPlaybackClock(audio));
  callbacks.onAudioElementCreated?.({
    audioUrl,
    audio,
    getAudioCurrentTimeSeconds: () => Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    isCurrentAudio: () => activeAudioElement === audio,
  });
  let resolvedDurationMs: number | null = null;
  let playbackStartNotified = false;

  const cleanup = () => {
    if (activeAudioElement === audio) {
      activeAudioElement = null;
    }
    callbacks.onAudioElementDisposed?.();
  };

  const syncDurationFromElement = () => {
    const durationSeconds = Number(audio.duration);
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      resolvedDurationMs = Math.round(durationSeconds * 1000);
      callbacks.onDurationChanged?.(resolvedDurationMs);
    }
  };

  const markPlaybackStarted = () => {
    if (playbackStartNotified || activeAudioElement !== audio) {
      return;
    }
    playbackStartNotified = true;
    syncDurationFromElement();
    callbacks.onPlaybackStarted?.({
      startedAtMs: performance.now(),
      durationMs: resolvedDurationMs,
      clock,
    });
  };

  audio.addEventListener(
    "loadedmetadata",
    () => {
      if (activeAudioElement !== audio) {
        return;
      }
      syncDurationFromElement();
    },
    { once: true },
  );

  audio.addEventListener(
    "playing",
    () => {
      markPlaybackStarted();
    },
    { once: true },
  );

  audio.addEventListener(
    "ended",
    () => {
      if (activeAudioElement !== audio) {
        return;
      }
      cleanup();
      callbacks.onEnded?.();
    },
    { once: true },
  );

  audio.addEventListener(
    "error",
    () => {
      if (activeAudioElement !== audio) {
        return;
      }
      console.warn("[Connection] audio element error.", {
        audioUrl,
        errorCode: audio.error?.code ?? null,
        errorMessage: audio.error?.message ?? "",
        networkState: audio.networkState,
        readyState: audio.readyState,
      });
      cleanup();
      callbacks.onError?.();
    },
    { once: true },
  );

  try {
    await audio.play();
    markPlaybackStarted();
  } catch (error) {
    console.warn("[Connection] audio play rejected.", {
      audioUrl,
      error,
      networkState: audio.networkState,
      readyState: audio.readyState,
    });
    cleanup();
    throw error;
  }
}

function stopBrowserAudioPlayback(): void {
  if (activeAudioElement) {
    activeAudioElement.pause();
    activeAudioElement.currentTime = 0;
  }
  activeAudioElement = null;
}

export function createBrowserAudioTimelineSink(): PlaybackTimelineAudioSink {
  return {
    async start(audioUrl, callbacks = {}) {
      await startBrowserAudioPlayback(audioUrl, callbacks);
    },
    stop() {
      stopBrowserAudioPlayback();
    },
  };
}
