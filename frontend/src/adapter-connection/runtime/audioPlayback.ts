export interface AudioPlaybackStartedEvent {
  startedAtMs: number;
  durationMs: number | null;
}

export interface RuntimeAudioPlaybackClock {
  getCurrentTimeMs(): number | null;
  getDurationMs(): number | null;
  getPlaybackRate(): number;
  isPlaying(): boolean;
}

export interface StartAudioPlaybackOptions {
  onAudioElementCreated?: (event: AudioPlaybackElementEvent) => void;
  onAudioElementDisposed?: () => void;
  onDurationChanged: (durationMs: number) => void;
  onPlaybackStarted: (event: AudioPlaybackStartedEvent) => void;
  onEnded: () => void;
  onError: () => void;
}

let audioElement: HTMLAudioElement | null = null;

export interface AudioPlaybackElementEvent {
  audio: HTMLAudioElement;
  getAudioCurrentTimeSeconds: () => number;
  isCurrentAudio: () => boolean;
}

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

export function getActiveAudioPlaybackClock(): RuntimeAudioPlaybackClock | null {
  if (!audioElement) {
    return null;
  }
  return createAudioElementPlaybackClock(audioElement);
}

export async function startAudioPlayback(
  audioUrl: string,
  options: StartAudioPlaybackOptions,
): Promise<void> {
  stopAudioPlaybackRuntime();

  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.src = audioUrl;
  audioElement = audio;
  options.onAudioElementCreated?.({
    audio,
    getAudioCurrentTimeSeconds: () => Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    isCurrentAudio: () => audioElement === audio,
  });
  let resolvedDurationMs: number | null = null;
  let playbackStartNotified = false;

  const cleanup = () => {
    if (audioElement === audio) {
      audioElement = null;
    }
    options.onAudioElementDisposed?.();
  };

  const syncDurationFromElement = () => {
    const durationSeconds = Number(audio.duration);
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      resolvedDurationMs = Math.round(durationSeconds * 1000);
      options.onDurationChanged(resolvedDurationMs);
    }
  };

  const markPlaybackStarted = () => {
    if (playbackStartNotified || audioElement !== audio) {
      return;
    }
    playbackStartNotified = true;
    syncDurationFromElement();
    options.onPlaybackStarted({
      startedAtMs: performance.now(),
      durationMs: resolvedDurationMs,
    });
  };

  audio.addEventListener(
    "loadedmetadata",
    () => {
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
      if (audioElement !== audio) {
        return;
      }
      cleanup();
      options.onEnded();
    },
    { once: true },
  );

  audio.addEventListener(
    "error",
    () => {
      if (audioElement !== audio) {
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
      options.onError();
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

export function stopAudioPlaybackRuntime(): void {
  if (audioElement) {
    audioElement.pause();
    audioElement.currentTime = 0;
  }
  audioElement = null;
}
