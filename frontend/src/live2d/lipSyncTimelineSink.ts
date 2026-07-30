import type {
  PlaybackTimelineLipSyncSink,
} from "../playback-timeline/lipSyncSink.js";

interface LiveLipSyncRuntime {
  resume: () => Promise<string | null>;
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
      const sourceId = `lip-sync:${serial}`;
      let started = false;
      let unavailable = false;
      const isActiveAttachment = () =>
        serial === attachmentSerial && options.isCurrentAudio();
      const markStarted = () => {
        if (!isActiveAttachment() || started || unavailable) {
          return;
        }
        started = true;
        options.onStarted();
      };
      const markUnavailable = (reason: string, degraded: boolean) => {
        if (!isActiveAttachment() || unavailable) {
          return;
        }
        unavailable = true;
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
      console.info("[Live2D] lip sync attachment evaluated.", {
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
        const degradedReason = await liveRuntime.resume();
        if (degradedReason) {
          console.error("[Live2D] lip sync failed during resume.", {
            reason: degradedReason,
          });
          markActiveUnavailable?.(degradedReason, true);
          return;
        }
        markActiveStarted?.();
      } catch (error) {
        const name = error instanceof Error && error.name
          ? error.name
          : "unknown";
        console.error("[Live2D] lip sync resume failed without degradation.", {
          reason: `lip_sync_resume_failed:${name}`,
          error,
        });
        markActiveUnavailable?.(`lip_sync_resume_failed:${name}`, false);
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

  console.info("[Live2D] lip sync model capability checked.", {
    hasLipSyncParameters,
    hasAudioContext: Boolean(
      window.AudioContext
      || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext,
    ),
  });

  if (!hasLipSyncParameters) {
    return reportLipSyncFailure("lip_sync_parameters_unconfigured");
  }

  try {
    beginAudioSignalSource(sourceId, {
      onFailed: (reason) => {
        sourceRuntime?.stop();
        onRuntimeFailure(reason, false);
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

  const degradedRuntime = (): LiveLipSyncRuntime | null => {
    if (!hasLipSyncParameters) {
      return null;
    }
    sourceRuntime = createRandomLipSyncRuntime(
      (values) => writeAudioSignalSource(sourceId, values),
      endSignalSource,
      isCurrentAudio,
      onRuntimeFailure,
    );
    return sourceRuntime;
  };

  const AudioContextCtor = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return reportLipSyncFailure(
      "lip_sync_audio_context_unavailable",
      undefined,
      degradedRuntime(),
    );
  }

  try {
    const audioContext = new AudioContextCtor();
    if (typeof audioContext.createMediaElementSource !== "function") {
      void audioContext.close?.();
      return reportLipSyncFailure(
        "lip_sync_media_element_source_unavailable",
        undefined,
        degradedRuntime(),
      );
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
    let resumeFallback: LiveLipSyncRuntime | null = null;
    let firstFrameLogged = false;

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
      const lipSyncIntensity = Math.max(0, Math.min(1, (rms - 0.012) * 30));
      const speechEnergyValue = Math.max(0, Math.min(1, (rms - 0.008) * 5.5));
      try {
        writeAudioSignalSource(sourceId, {
          lipSyncIntensity,
          speechEnergyValue,
        });
        if (!firstFrameLogged) {
          firstFrameLogged = true;
          console.info("[Live2D] lip sync first frame written.", {
            hasLipSyncParameters,
            lipSyncIntensity,
            speechEnergyValue,
          });
        }
      } catch (error) {
        stopped = true;
        animationFrameId = null;
        endSignalSource();
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
            stopped = true;
            if (animationFrameId !== null) {
              window.cancelAnimationFrame(animationFrameId);
              animationFrameId = null;
            }
            const name = error instanceof Error && error.name
              ? error.name
              : "unknown";
            try {
              writeAudioSignalSource(sourceId, { speechEnergyValue: 0 });
              resumeFallback = degradedRuntime();
              await resumeFallback?.resume();
            } catch (fallbackError) {
              endSignalSource();
              console.error("[Live2D] degraded lip sync setup failed.", {
                reason: "lip_sync_resume_degradation_failed",
                fallbackError,
              });
            }
            return `lip_sync_resume_failed:${name}`;
          }
        }
        return null;
      },
      stop: () => {
        stopped = true;
        resumeFallback?.stop();
        resumeFallback = null;
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
    return reportLipSyncFailure(
      "lip_sync_analyser_failed",
      error,
      degradedRuntime(),
    );
  }
}

function reportLipSyncFailure(
  reason: string,
  error?: unknown,
  runtime: LiveLipSyncRuntime | null = null,
): LiveLipSyncStartResult {
  console.error("[Live2D] lip sync failed.", { reason, error });
  return { runtime, failureReason: reason };
}

function createRandomLipSyncRuntime(
  writeAudioSignalSource: (values: {
    lipSyncIntensity?: number;
    speechEnergyValue?: number;
  }) => void,
  endSignalSource: () => void,
  isCurrentAudio: () => boolean,
  onRuntimeFailure: (reason: string, degraded: boolean) => void,
): LiveLipSyncRuntime {
  let timerId: number | null = null;
  let stopped = false;

  const scheduleNext = (): void => {
    if (stopped || !isCurrentAudio()) {
      return;
    }
    const open = Math.random() >= 0.45;
    const value = open ? 0.35 + Math.random() * 0.5 : 0;
    try {
      writeAudioSignalSource({ lipSyncIntensity: value });
    } catch (error) {
      stopped = true;
      timerId = null;
      console.error("[Live2D] random lip sync fallback failed.", {
        reason: "lip_sync_random_fallback_parameter_write_failed",
        error,
      });
      endSignalSource();
      onRuntimeFailure("lip_sync_random_fallback_parameter_write_failed", false);
      return;
    }
    timerId = window.setTimeout(scheduleNext, 90 + Math.round(Math.random() * 140));
  };

  return {
    resume: async () => {
      if (stopped || timerId !== null) {
        return null;
      }
      scheduleNext();
      return null;
    },
    stop: () => {
      stopped = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      endSignalSource();
    },
  };
}
