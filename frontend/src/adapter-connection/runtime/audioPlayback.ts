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
let lipSyncRuntime: LiveLipSyncRuntime | null = null;

interface LiveLipSyncRuntime {
  resume: () => Promise<void>;
  stop: () => void;
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
  const liveLipSync = startLiveLipSync(audio, options.onLipSyncUnavailable);
  lipSyncRuntime = liveLipSync;
  void prepareLipSync(
    audioUrl,
    options.onLipSyncUnavailable,
    () => Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    () => audioElement === audio,
  );
  let resolvedDurationMs: number | null = null;
  let playbackStartNotified = false;

  const cleanup = () => {
    if (audioElement === audio) {
      audioElement = null;
    }
    if (lipSyncRuntime === liveLipSync) {
      lipSyncRuntime = null;
    }
    liveLipSync?.stop();
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
    void liveLipSync?.resume();
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
  lipSyncRuntime?.stop();
  lipSyncRuntime = null;
  if (audioElement) {
    audioElement.pause();
    audioElement.currentTime = 0;
    window.getLAppAdapter?.()?.clearExternalLipSyncValue?.();
  }
  audioElement = null;
}

async function prepareLipSync(
  audioUrl: string,
  onLipSyncUnavailable: () => void,
  getAudioCurrentTimeSeconds: () => number,
  isCurrentAudio: () => boolean,
): Promise<void> {
  const adapter = window.getLAppAdapter?.();
  if (!adapter || typeof adapter.loadWavFileForLipSync !== "function") {
    return;
  }

  try {
    const lipSyncReady = await adapter.loadWavFileForLipSync(
      audioUrl,
      Math.max(0, getAudioCurrentTimeSeconds()),
    );
    if (isCurrentAudio() && lipSyncReady === false) {
      onLipSyncUnavailable();
    }
  } catch (_error) {
    if (isCurrentAudio()) {
      onLipSyncUnavailable();
    }
  }
}

function startLiveLipSync(
  audio: HTMLAudioElement,
  onLipSyncUnavailable: () => void,
): LiveLipSyncRuntime | null {
  const adapter = window.getLAppAdapter?.();
  if (!adapter || typeof adapter.setExternalLipSyncValue !== "function") {
    return null;
  }

  const AudioContextCtor = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  try {
    const audioContext = new AudioContextCtor();
    if (typeof audioContext.createMediaElementSource !== "function") {
      void audioContext.close?.();
      return null;
    }
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.28;
    const source = audioContext.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioContext.destination);

    const samples = new Uint8Array(analyser.fftSize);
    let animationFrameId: number | null = null;
    let stopped = false;

    const tick = () => {
      if (stopped || audioElement !== audio) {
        return;
      }
      analyser.getByteTimeDomainData(samples);
      let squareSum = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        squareSum += centered * centered;
      }
      const rms = Math.sqrt(squareSum / samples.length);
      const mouthValue = Math.max(0, Math.min(1, (rms - 0.012) * 7.5));
      adapter.setExternalLipSyncValue?.(mouthValue);
      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);

    return {
      resume: async () => {
        if (audioContext.state === "suspended") {
          await audioContext.resume();
        }
      },
      stop: () => {
        stopped = true;
        if (animationFrameId !== null) {
          window.cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
        adapter.clearExternalLipSyncValue?.();
        try {
          source.disconnect();
        } catch (_error) {
          // Ignore teardown races from browser audio graphs.
        }
        try {
          analyser.disconnect();
        } catch (_error) {
          // Ignore teardown races from browser audio graphs.
        }
        void audioContext.close?.();
      },
    };
  } catch (error) {
    console.warn("[Connection] live lip sync analyser unavailable.", error);
    onLipSyncUnavailable();
    return null;
  }
}
