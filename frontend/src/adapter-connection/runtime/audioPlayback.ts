export interface AudioPlaybackStartedEvent {
  startedAtMs: number;
  durationMs: number | null;
}

export interface StartAudioPlaybackOptions {
  onLipSyncUnavailable: () => void;
  onDurationChanged: (durationMs: number) => void;
  onPlaybackStarted: (event: AudioPlaybackStartedEvent) => void;
  onEnded: () => void;
  onError: () => void;
}

let audioElement: HTMLAudioElement | null = null;

export async function startAudioPlayback(
  audioUrl: string,
  options: StartAudioPlaybackOptions,
): Promise<void> {
  stopAudioPlaybackRuntime();
  await prepareLipSync(audioUrl, options.onLipSyncUnavailable);

  const audio = new Audio(audioUrl);
  audioElement = audio;
  let resolvedDurationMs: number | null = null;
  let playbackStartNotified = false;

  const cleanup = () => {
    if (audioElement === audio) {
      audioElement = null;
    }
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
      cleanup();
      options.onError();
    },
    { once: true },
  );

  try {
    await audio.play();
    markPlaybackStarted();
  } catch (error) {
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

async function prepareLipSync(
  audioUrl: string,
  onLipSyncUnavailable: () => void,
): Promise<void> {
  const adapter = window.getLAppAdapter?.();
  if (!adapter || typeof adapter.loadWavFileForLipSync !== "function") {
    return;
  }

  try {
    const lipSyncReady = await Promise.race<boolean | null>([
      adapter.loadWavFileForLipSync(audioUrl),
      new Promise<null>((resolve) => {
        window.setTimeout(() => resolve(null), 480);
      }),
    ]);
    if (lipSyncReady === false) {
      onLipSyncUnavailable();
    }
  } catch (_error) {
    onLipSyncUnavailable();
  }
}
