export interface PlaybackTimelineLipSyncAttachOptions {
  audioUrl: string;
  audio: HTMLAudioElement;
  getAudioCurrentTimeSeconds: () => number;
  isCurrentAudio: () => boolean;
  onStarted: () => void;
  onUnavailable: () => void;
}

export interface PlaybackTimelineLipSyncSink {
  attachAudio(options: PlaybackTimelineLipSyncAttachOptions): void;
  resume(): Promise<void>;
  stop(): void;
}

export interface PlaybackTimelineLipSyncRuntimeCallbacks {
  onUnavailable?: () => void;
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
  stop(): void;
}

interface LiveLipSyncRuntime {
  resume: () => Promise<void>;
  stop: () => void;
}

type WavLipSyncPrepareResult = "started" | "unsupported" | "unavailable" | "stale";

export function createPlaybackTimelineLipSyncRuntime(
  sink: PlaybackTimelineLipSyncSink,
  callbacks: PlaybackTimelineLipSyncRuntimeCallbacks = {},
): PlaybackTimelineLipSyncRuntime {
  let terminalSettled = false;
  let started = false;

  const settleTerminal = (
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ): void => {
    if (terminalSettled) {
      return;
    }
    terminalSettled = true;
    callbacks.onTerminal?.(terminal, reason);
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
          callbacks.onStarted?.();
        },
        onUnavailable: () => {
          callbacks.onUnavailable?.();
          settleTerminal("failed", "lip_sync_unavailable");
        },
      });
    },
    async resume() {
      try {
        await sink.resume();
      } catch (_error) {
        settleTerminal("failed", "lip_sync_resume_failed");
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
    stop() {
      sink.stop();
    },
  };
}

export function createBrowserLipSyncTimelineSink(): PlaybackTimelineLipSyncSink {
  let liveRuntime: LiveLipSyncRuntime | null = null;
  let attachmentSerial = 0;
  let markActiveStarted: (() => void) | null = null;
  let markActiveUnavailable: (() => void) | null = null;

  function stop(): void {
    attachmentSerial += 1;
    liveRuntime?.stop();
    liveRuntime = null;
    markActiveStarted = null;
    markActiveUnavailable = null;
    window.getLAppAdapter?.()?.clearExternalLipSyncValue?.();
  }

  return {
    attachAudio(options) {
      stop();
      const serial = attachmentSerial;
      let settled = false;
      const isActiveAttachment = () =>
        serial === attachmentSerial && options.isCurrentAudio();
      const markStarted = () => {
        if (!isActiveAttachment() || settled) {
          return;
        }
        settled = true;
        options.onStarted();
      };
      const markUnavailable = () => {
        if (!isActiveAttachment() || settled) {
          return;
        }
        settled = true;
        options.onUnavailable();
      };
      markActiveStarted = markStarted;
      markActiveUnavailable = markUnavailable;
      liveRuntime = startLiveLipSync(
        options.audio,
        options.isCurrentAudio,
      );
      void prepareWavLipSync(options).then((result) => {
        if (!isActiveAttachment()) {
          return;
        }
        if (result === "started") {
          markStarted();
          return;
        }
        if (!liveRuntime && (result === "unsupported" || result === "unavailable")) {
          markUnavailable();
        }
      });
    },
    async resume() {
      if (!liveRuntime) {
        return;
      }
      try {
        await liveRuntime.resume();
        markActiveStarted?.();
      } catch (_error) {
        markActiveUnavailable?.();
      }
    },
    stop,
  };
}

async function prepareWavLipSync(
  options: PlaybackTimelineLipSyncAttachOptions,
): Promise<WavLipSyncPrepareResult> {
  const adapter = window.getLAppAdapter?.();
  if (!adapter || typeof adapter.loadWavFileForLipSync !== "function") {
    return "unsupported";
  }

  try {
    const lipSyncReady = await adapter.loadWavFileForLipSync(
      options.audioUrl,
      Math.max(0, options.getAudioCurrentTimeSeconds()),
    );
    if (!options.isCurrentAudio()) {
      return "stale";
    }
    return lipSyncReady === false ? "unavailable" : "started";
  } catch (_error) {
    return options.isCurrentAudio() ? "unavailable" : "stale";
  }
}

function startLiveLipSync(
  audio: HTMLAudioElement,
  isCurrentAudio: () => boolean,
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
      if (stopped || !isCurrentAudio()) {
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
    return null;
  }
}
