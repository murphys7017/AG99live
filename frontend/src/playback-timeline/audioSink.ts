import type { AudioPlaybackClock } from "./contracts.js";
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

export interface PlaybackTimelineAudioElementContext {
  audioUrl: string;
  audio: HTMLAudioElement;
  clock: AudioPlaybackClock;
  getAudioCurrentTimeSeconds: () => number;
  isCurrentAudio: () => boolean;
  speechOutput: SpeechOutputSession | null;
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
  start(audioUrl: string, callbacks?: PlaybackTimelineAudioStartCallbacks): Promise<void>;
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
  speechOutputRuntime?: SpeechOutputRuntime;
} = {}): PlaybackTimelineAudioSink {
  let activeAudioElement: HTMLAudioElement | null = null;
  let activeAudioStartCancel: (() => void) | null = null;
  let activeSpeechOutput: SpeechOutputSession | null = null;

  function stopBrowserAudioPlayback(): void {
    const audio = activeAudioElement;
    const cancelStart = activeAudioStartCancel;
    const speechOutput = activeSpeechOutput;
    activeAudioElement = null;
    activeAudioStartCancel = null;
    activeSpeechOutput = null;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    speechOutput?.dispose();
    cancelStart?.();
  }

  async function startBrowserAudioPlayback(
    audioUrl: string,
    callbacks: PlaybackTimelineAudioStartCallbacks,
  ): Promise<void> {
    stopBrowserAudioPlayback();

    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.src = audioUrl;
    let speechOutput: SpeechOutputSession | null = null;
    try {
      speechOutput = options.speechOutputRuntime?.attach(audio) ?? null;
    } catch (error) {
      console.error("[SpeechOutput] output runtime attach failed; using native media output.", {
        audioUrl,
        error,
      });
    }
    activeAudioElement = audio;
    activeSpeechOutput = speechOutput;
    const clock = adaptClock(createAudioElementPlaybackClock(audio));
    let resolvedDurationMs: number | null = null;
    let playbackStartNotified = false;
    let disposed = false;

    let resolveDurationReady!: () => void;
    let rejectDurationReady!: (error: unknown) => void;
    const durationReady = new Promise<void>((resolve, reject) => {
      resolveDurationReady = resolve;
      rejectDurationReady = reject;
    });
    void durationReady.catch(() => undefined);
    const cancelStart = () => {
      rejectDurationReady(new DOMException("Audio playback stopped before start.", "AbortError"));
    };
    activeAudioStartCancel = cancelStart;

    const cleanup = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (activeAudioElement === audio) {
        activeAudioElement = null;
      }
      if (activeAudioStartCancel === cancelStart) {
        activeAudioStartCancel = null;
      }
      if (activeSpeechOutput === speechOutput) {
        activeSpeechOutput = null;
      }
      speechOutput?.dispose();
      callbacks.onAudioElementDisposed?.();
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

    const markPlaybackStarted = () => {
      if (playbackStartNotified || activeAudioElement !== audio) {
        return;
      }
      playbackStartNotified = true;
      syncDurationFromElement();
      speechOutput?.start();
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

    audio.addEventListener("durationchange", () => {
      if (activeAudioElement === audio && resolvedDurationMs === null) {
        syncDurationFromElement();
      }
    });

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
        rejectDurationReady(new Error("Audio metadata could not be loaded."));
        cleanup();
        if (playbackStartNotified) {
          callbacks.onError?.();
        }
      },
      { once: true },
    );

    try {
      await speechOutput?.prepare();
      if (activeAudioElement !== audio) {
        throw new DOMException("Audio playback stopped before start.", "AbortError");
      }
      await callbacks.onAudioElementCreated?.({
        audioUrl,
        audio,
        clock,
        getAudioCurrentTimeSeconds: () => Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
        isCurrentAudio: () => activeAudioElement === audio,
        speechOutput,
      });
      audio.load();
      await durationReady;
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
    async start(audioUrl, callbacks = {}) {
      await startBrowserAudioPlayback(audioUrl, callbacks);
    },
    stop() {
      stopBrowserAudioPlayback();
    },
  };
}
