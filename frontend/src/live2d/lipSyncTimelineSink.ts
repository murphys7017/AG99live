import type {
  PlaybackTimelineLipSyncAttachOptions,
  PlaybackTimelineLipSyncSink,
} from "../playback-timeline/lipSyncSink.js";

interface LiveLipSyncRuntime {
  resume: () => Promise<void>;
  stop: () => void;
}

export function createLive2DLipSyncTimelineSink(): PlaybackTimelineLipSyncSink {
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
      if (!liveRuntime) {
        markUnavailable();
      }
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
          // Browser audio graph teardown can race with element disposal.
        }
        try {
          analyser.disconnect();
        } catch (_error) {
          // Browser audio graph teardown can race with element disposal.
        }
        void audioContext.close?.();
      },
    };
  } catch (error) {
    console.warn("[Live2D] live lip sync analyser unavailable.", error);
    return null;
  }
}
