import type { AudioPlaybackClock } from "./contracts.js";
import { loadSpeechVolume, SPEECH_VOLUME_KEY } from "../app/petPreferences.js";
import { onOutputPresented, presentedOutputTime } from "./outputPresentationClock.js";
import type {
  SpeechOutputRuntime,
  SpeechOutputSession,
} from "./speechOutputRuntime.js";

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

export interface PlaybackTimelineAudioSourceContext {
  audioUrl: string | null;
  clock: AudioPlaybackClock;
  getAudioCurrentTimeSeconds: () => number;
  isCurrentAudio: () => boolean;
  speechOutput: SpeechOutputSession | null;
}

export interface PlaybackTimelineAudioElementContext extends PlaybackTimelineAudioSourceContext {
  audioUrl: string;
  audio: HTMLAudioElement;
}

export interface PlaybackTimelineAudioStartCallbacks {
  onAudioElementCreated?: (
    event: PlaybackTimelineAudioElementContext,
  ) => Promise<void> | void;
  onAudioElementDisposed?: () => void;
  onDurationChanged?: (durationMs: number | null) => void;
  onPlaybackStarted?: (event: AudioPlaybackStartedEvent) => void;
  onEnded?: () => void;
  onError?: () => void;
}

export interface PlaybackTimelineAudioSink {
  start(audioUrl: string, turnId: string | null, callbacks?: PlaybackTimelineAudioStartCallbacks): Promise<void>;
  stop(): void;
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

function adaptClock(clock: RuntimeAudioPlaybackClock): AudioPlaybackClock {
  return {
    getCurrentTimeMs: () => clock.getCurrentTimeMs(),
    getDurationMs: () => clock.getDurationMs(),
    getPlaybackRate: () => clock.getPlaybackRate(),
    isPlaying: () => clock.isPlaying(),
  };
}

export function createBrowserAudioTimelineSink(options: {
  speechOutputRuntime: SpeechOutputRuntime;
}): PlaybackTimelineAudioSink & { dispose(): void } {
  let activeAudioElement: HTMLAudioElement | null = null;
  let activeAudioStartCancel: (() => void) | null = null;
  const onVolumeChanged = (event: StorageEvent) => {
    if (event.key === SPEECH_VOLUME_KEY && activeAudioElement) {
      activeAudioElement.volume = loadSpeechVolume();
    }
  };
  window.addEventListener("storage", onVolumeChanged);

  function stopBrowserAudioPlayback(): void {
    const audio = activeAudioElement;
    const cancelStart = activeAudioStartCancel;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    cancelStart?.();
  }

  async function startBrowserAudioPlayback(
    audioUrl: string,
    turnId: string | null,
    callbacks: PlaybackTimelineAudioStartCallbacks,
  ): Promise<void> {
    stopBrowserAudioPlayback();

    const audio = new Audio();
    audio.volume = loadSpeechVolume();
    audio.crossOrigin = "anonymous";
    audio.src = audioUrl;
    const speechOutput = options.speechOutputRuntime.attach(audio, turnId);
    activeAudioElement = audio;
    const clock = adaptClock(createAudioElementPlaybackClock(audio));
    const context = speechOutput.context;
    let firstRender: number | undefined;
    let renderEnd: number | undefined;
    clock.getCurrentTimeMs = () => {
      const queued = Math.max(0, (renderEnd ?? context.currentTime) - presentedOutputTime(context));
      return Math.max(0, (audio.currentTime - queued * audio.playbackRate) * 1000);
    };
    clock.isPlaying = () => renderEnd === undefined ? !audio.paused && !audio.ended
      : presentedOutputTime(context) < renderEnd;
    let resolvedDurationMs: number | null = null;
    let playbackStartNotified = false;
    let disposed = false;
    let cancelStartPresentation: (() => void) | undefined;
    let cancelEndPresentation: (() => void) | undefined;

    let resolveDurationReady!: () => void;
    let rejectDurationReady!: (error: unknown) => void;
    const durationReady = new Promise<void>((resolve, reject) => {
      resolveDurationReady = resolve;
      rejectDurationReady = reject;
    });
    void durationReady.catch(() => undefined);
    const cleanup = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      cancelStartPresentation?.();
      cancelEndPresentation?.();
      if (activeAudioElement === audio) {
        activeAudioElement = null;
        activeAudioStartCancel = null;
      }
      speechOutput.dispose();
      callbacks.onAudioElementDisposed?.();
    };
    activeAudioStartCancel = () => {
      rejectDurationReady(new DOMException("Audio playback stopped.", "AbortError"));
      cleanup();
    };

    const syncDurationFromElement = (): boolean => {
      const durationSeconds = Number(audio.duration);
      if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
        const nextDurationMs = Math.round(durationSeconds * 1000);
        if (resolvedDurationMs !== nextDurationMs) {
          resolvedDurationMs = nextDurationMs;
          callbacks.onDurationChanged?.(resolvedDurationMs);
        }
        resolveDurationReady();
        return true;
      }
      return false;
    };

    const markPlaybackStarted = (startedAtMs: number) => {
      if (playbackStartNotified || activeAudioElement !== audio) {
        return;
      }
      playbackStartNotified = true;
      syncDurationFromElement();
      callbacks.onPlaybackStarted?.({
        startedAtMs,
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

    audio.addEventListener("durationchange", () => {
      if (activeAudioElement === audio && resolvedDurationMs === null) {
        syncDurationFromElement();
      }
    });

    audio.addEventListener(
      "playing",
      () => {
        if (activeAudioElement !== audio) return;
        speechOutput.start();
        firstRender = Math.max(0, context.currentTime - audio.currentTime / audio.playbackRate);
        cancelStartPresentation = onOutputPresented(context, firstRender, markPlaybackStarted);
      },
      { once: true },
    );

    audio.addEventListener(
      "ended",
      () => {
        if (activeAudioElement !== audio) {
          return;
        }
        renderEnd = context.currentTime;
        cancelEndPresentation = onOutputPresented(context, renderEnd, () => {
          if (activeAudioElement !== audio) return;
          if (!playbackStartNotified && firstRender !== undefined) {
            const elapsed = presentedOutputTime(context) - firstRender;
            markPlaybackStarted(performance.now() - 1000 * elapsed);
            if (activeAudioElement !== audio) return;
          }
          cleanup();
          callbacks.onEnded?.();
        });
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
        rejectDurationReady(new Error("Audio metadata could not be loaded."));
        cleanup();
        if (firstRender !== undefined) {
          callbacks.onError?.();
        }
      },
      { once: true },
    );

    try {
      await callbacks.onAudioElementCreated?.({
        audioUrl,
        audio,
        clock,
        getAudioCurrentTimeSeconds: () => (clock.getCurrentTimeMs() ?? 0) / 1000,
        isCurrentAudio: () => activeAudioElement === audio,
        speechOutput,
      });
      if (activeAudioElement !== audio) {
        throw new DOMException("Audio playback stopped before load.", "AbortError");
      }
      audio.load();
      await durationReady;
      if (activeAudioElement !== audio) {
        throw new DOMException("Audio playback stopped before start.", "AbortError");
      }
      // The output route may have changed while the file was loading.
      await speechOutput.prepare();
      if (activeAudioElement !== audio) {
        throw new DOMException("Audio playback stopped before start.", "AbortError");
      }
      await audio.play();
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

  return {
    async start(audioUrl, turnId, callbacks = {}) {
      await startBrowserAudioPlayback(audioUrl, turnId, callbacks);
    },
    stop() {
      stopBrowserAudioPlayback();
    },
    dispose() {
      window.removeEventListener("storage", onVolumeChanged);
      stopBrowserAudioPlayback();
    },
  };
}
