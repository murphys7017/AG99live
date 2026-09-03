import type {
  PlaybackTimelineLipSyncSink,
} from "../playback-timeline/lipSyncSink.js";

const SPEECH_ANALYSIS_BAND_MIN_HZ = 160;
const SPEECH_ANALYSIS_BAND_MAX_HZ = 4200;
const SPEECH_EMPHASIS_BAND_MIN_HZ = 900;
const SPEECH_EMPHASIS_RATIO_FLOOR = 0.24;
const SPEECH_EMPHASIS_RATIO_SPAN = 0.24;

interface LiveLipSyncRuntime {
  resume: () => Promise<void>;
  stop: () => void;
}

interface LiveLipSyncStartResult {
  runtime: LiveLipSyncRuntime | null;
  failureReason: string | null;
}

export function createLive2DLipSyncTimelineSink(): PlaybackTimelineLipSyncSink {
  let liveRuntime: LiveLipSyncRuntime | null = null;
  let attachmentSerial = 0;
  let markActiveStarted: (() => void) | null = null;
  let markActiveUnavailable: ((reason: string, degraded: boolean) => void) | null = null;

  function stop(): void {
    attachmentSerial += 1;
    liveRuntime?.stop();
    liveRuntime = null;
    markActiveStarted = null;
    markActiveUnavailable = null;
  }

  return {
    attachAudio(options) {
      stop();
      const serial = attachmentSerial;
      const sourceId = `speech-audio:${serial}`;
      let started = false;
      let terminalUnavailable = false;
      const isActiveAttachment = () =>
        serial === attachmentSerial && options.isCurrentAudio();
      const markStarted = () => {
        if (!isActiveAttachment() || started || terminalUnavailable) {
          return;
        }
        started = true;
        options.onStarted();
      };
      const markUnavailable = (reason: string, degraded: boolean) => {
        if (!isActiveAttachment() || terminalUnavailable) {
          return;
        }
        if (!degraded) {
          terminalUnavailable = true;
        }
        options.onUnavailable(reason, degraded);
      };
      markActiveStarted = markStarted;
      markActiveUnavailable = markUnavailable;
      const result = startLiveLipSync(
        options.audio,
        options.isCurrentAudio,
        sourceId,
        markUnavailable,
      );
      liveRuntime = result.runtime;
      console.info("[Live2D] speech audio attachment evaluated.", {
        audioUrl: options.audioUrl,
        runtimeAvailable: result.runtime !== null,
        failureReason: result.failureReason,
      });
      if (result.failureReason) {
        markUnavailable(result.failureReason, result.runtime !== null);
      }
    },
    async resume() {
      if (!liveRuntime) {
        return;
      }
      try {
        await liveRuntime.resume();
        markActiveStarted?.();
      } catch (error) {
        const reason = error instanceof Error && error.message.trim()
          ? error.message.trim()
          : `lip_sync_resume_failed:${error instanceof Error && error.name ? error.name : "unknown"}`;
        console.error("[Live2D] lip sync resume failed without degradation.", {
          reason,
          error,
        });
        markActiveUnavailable?.(reason, false);
      }
    },
    stop,
  };
}

function startLiveLipSync(
  audio: HTMLAudioElement,
  isCurrentAudio: () => boolean,
  sourceId: string,
  onRuntimeFailure: (reason: string, degraded: boolean) => void,
): LiveLipSyncStartResult {
  const adapter = window.getLAppAdapter?.();
  if (
    !adapter
    || typeof adapter.beginExternalAudioSignalSource !== "function"
    || typeof adapter.writeExternalAudioSignalSource !== "function"
    || typeof adapter.endExternalAudioSignalSource !== "function"
  ) {
    return reportLipSyncFailure("speech_audio_adapter_unavailable");
  }
  const beginAudioSignalSource = adapter.beginExternalAudioSignalSource.bind(adapter);
  const writeAudioSignalSource = adapter.writeExternalAudioSignalSource.bind(adapter);
  const endAudioSignalSource = adapter.endExternalAudioSignalSource.bind(adapter);
  let sourceRuntime: LiveLipSyncRuntime | null = null;
  let hasLipSyncParameters = false;
  try {
    hasLipSyncParameters = adapter.hasConfiguredLipSyncParameters?.() === true;
  } catch (error) {
    return reportLipSyncFailure("lip_sync_model_unavailable", error);
  }

  console.info("[Live2D] speech audio model capability checked.", {
    hasLipSyncParameters,
    hasAudioContext: Boolean(
      window.AudioContext
      || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext,
    ),
  });

  try {
    beginAudioSignalSource(sourceId, {
      lipSyncEnabled: hasLipSyncParameters,
      onFailed: (reason) => {
        sourceRuntime?.stop();
        onRuntimeFailure(reason, false);
      },
      onLipSyncUnavailable: (reason) => {
        onRuntimeFailure(reason, true);
      },
    });
  } catch (error) {
    return reportLipSyncFailure("speech_audio_signal_source_begin_failed", error);
  }

  let sourceEnded = false;
  const endSignalSource = () => {
    if (sourceEnded) {
      return;
    }
    sourceEnded = true;
    try {
      endAudioSignalSource(sourceId);
    } catch (error) {
      console.error("[Live2D] audio signal source end failed.", {
        sourceId,
        error,
      });
    }
  };

  const AudioContextCtor = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    endSignalSource();
    return reportLipSyncFailure("lip_sync_audio_context_unavailable");
  }

  try {
    const audioContext = new AudioContextCtor();
    if (typeof audioContext.createMediaElementSource !== "function") {
      void audioContext.close?.();
      endSignalSource();
      return reportLipSyncFailure("lip_sync_media_element_source_unavailable");
    }
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.28;
    const source = audioContext.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioContext.destination);

    const samples = new Uint8Array(analyser.fftSize);
    const frequencyBins = new Uint8Array(analyser.frequencyBinCount);
    let animationFrameId: number | null = null;
    let stopped = false;
    let firstFrameLogged = false;

    const tick = () => {
      if (stopped || !isCurrentAudio()) {
        return;
      }
      analyser.getByteTimeDomainData(samples);
      analyser.getByteFrequencyData(frequencyBins);
      let squareSum = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        squareSum += centered * centered;
      }
      const rms = Math.sqrt(squareSum / samples.length);
      const lipSyncIntensity = Math.max(0, Math.min(1, (rms - 0.012) * 30));
      const speechEnergyValue = Math.max(0, Math.min(1, (rms - 0.008) * 5.5));
      const speechEmphasisValue = resolveSpeechEmphasisValue(
        frequencyBins,
        audioContext.sampleRate,
      );
      try {
        writeAudioSignalSource(sourceId, {
          ...(hasLipSyncParameters ? { lipSyncIntensity } : {}),
          speechEnergyValue,
          speechEmphasisValue,
        });
        if (!firstFrameLogged) {
          firstFrameLogged = true;
          console.info("[Live2D] speech audio first frame written.", {
            hasLipSyncParameters,
            lipSyncIntensity,
            speechEnergyValue,
            speechEmphasisValue,
          });
        }
      } catch (error) {
        sourceRuntime?.stop();
        console.error("[Live2D] lip sync frame write failed.", {
          reason: "lip_sync_parameter_write_failed",
          error,
        });
        onRuntimeFailure(
          "lip_sync_parameter_write_failed",
          false,
        );
        return;
      }
      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);

    sourceRuntime = {
      resume: async () => {
        if (audioContext.state === "suspended") {
          try {
            await audioContext.resume();
          } catch (error) {
            const name = error instanceof Error && error.name
              ? error.name
              : "unknown";
            sourceRuntime?.stop();
            throw new Error(`lip_sync_resume_failed:${name}`);
          }
        }
        return;
      },
      stop: () => {
        stopped = true;
        if (animationFrameId !== null) {
          window.cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
        endSignalSource();
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
    return {
      runtime: sourceRuntime,
      failureReason: hasLipSyncParameters ? null : "lip_sync_parameters_unconfigured",
    };
  } catch (error) {
    endSignalSource();
    return reportLipSyncFailure("lip_sync_analyser_failed", error);
  }
}

function reportLipSyncFailure(
  reason: string,
  error?: unknown,
): LiveLipSyncStartResult {
  console.error("[Live2D] lip sync failed.", { reason, error });
  return { runtime: null, failureReason: reason };
}

function resolveSpeechEmphasisValue(
  frequencyBins: Uint8Array,
  sampleRate: number,
): number {
  if (frequencyBins.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return 0;
  }
  const binWidthHz = sampleRate / (frequencyBins.length * 2);
  const speechBandEnergy = resolveFrequencyBandEnergy(
    frequencyBins,
    binWidthHz,
    SPEECH_ANALYSIS_BAND_MIN_HZ,
    SPEECH_ANALYSIS_BAND_MAX_HZ,
  );
  if (speechBandEnergy <= 0) {
    return 0;
  }
  const upperSpeechBandEnergy = resolveFrequencyBandEnergy(
    frequencyBins,
    binWidthHz,
    SPEECH_EMPHASIS_BAND_MIN_HZ,
    SPEECH_ANALYSIS_BAND_MAX_HZ,
  );
  const upperBandRatio = upperSpeechBandEnergy / speechBandEnergy;
  return Math.max(
    0,
    Math.min(
      1,
      (upperBandRatio - SPEECH_EMPHASIS_RATIO_FLOOR)
        / SPEECH_EMPHASIS_RATIO_SPAN,
    ),
  );
}

function resolveFrequencyBandEnergy(
  frequencyBins: Uint8Array,
  binWidthHz: number,
  minFrequencyHz: number,
  maxFrequencyHz: number,
): number {
  const minBin = Math.max(0, Math.ceil(minFrequencyHz / binWidthHz));
  const maxBin = Math.min(
    frequencyBins.length - 1,
    Math.floor(maxFrequencyHz / binWidthHz),
  );
  let energy = 0;
  for (let index = minBin; index <= maxBin; index += 1) {
    const normalizedMagnitude = frequencyBins[index] / 255;
    energy += normalizedMagnitude * normalizedMagnitude;
  }
  return energy;
}
