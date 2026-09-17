const SPEECH_OUTPUT_FADE_INITIAL_GAIN = 0.86;
const SPEECH_OUTPUT_FADE_DURATION_SECONDS = 0.04;
const SPEECH_OUTPUT_WARMUP_MS = 80;

export interface SpeechOutputSession {
  readonly analyser: AnalyserNode;
  readonly sampleRate: number;
  prepare(): Promise<void>;
  start(): void;
  dispose(): void;
}

export interface SpeechOutputRuntime {
  attach(audio: HTMLAudioElement): SpeechOutputSession;
  dispose(): Promise<void>;
}

export function createSpeechOutputRuntime(): SpeechOutputRuntime {
  let audioContext: AudioContext | null = null;
  let activeSession: SpeechOutputSession | null = null;
  let outputWarmed = false;
  let disposed = false;

  function requireAudioContext(): AudioContext {
    if (disposed) {
      throw new Error("speech_output_runtime_disposed");
    }
    if (audioContext) {
      return audioContext;
    }
    const AudioContextCtor = window.AudioContext
      ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("speech_output_audio_context_unavailable");
    }
    audioContext = new AudioContextCtor({
      latencyHint: "interactive",
    } as AudioContextOptions);
    return audioContext;
  }

  async function prepareOutput(context: AudioContext): Promise<void> {
    if (context.state === "closed") {
      throw new Error("speech_output_audio_context_closed");
    }
    const resumed = context.state !== "running";
    if (resumed) {
      await context.resume();
    }
    const needsWarmup = !outputWarmed || resumed;
    if (needsWarmup) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, SPEECH_OUTPUT_WARMUP_MS);
      });
      outputWarmed = true;
    }
    console.info("[SpeechOutput] output runtime prepared.", {
      audioContextState: context.state,
      resumed,
      warmupMs: needsWarmup ? SPEECH_OUTPUT_WARMUP_MS : 0,
    });
  }

  return {
    attach(audio) {
      const context = requireAudioContext();
      activeSession?.dispose();

      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.28;
      const outputGain = context.createGain();
      outputGain.gain.value = SPEECH_OUTPUT_FADE_INITIAL_GAIN;
      const source = context.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(outputGain);
      outputGain.connect(context.destination);

      let sessionDisposed = false;
      let outputStarted = false;
      const session: SpeechOutputSession = {
        analyser,
        sampleRate: context.sampleRate,
        prepare: () => prepareOutput(context),
        start() {
          if (sessionDisposed || outputStarted) {
            return;
          }
          outputStarted = true;
          const now = context.currentTime;
          outputGain.gain.cancelScheduledValues(now);
          outputGain.gain.setValueAtTime(SPEECH_OUTPUT_FADE_INITIAL_GAIN, now);
          outputGain.gain.linearRampToValueAtTime(
            1,
            now + SPEECH_OUTPUT_FADE_DURATION_SECONDS,
          );
          console.info("[SpeechOutput] segment output fade started.", {
            initialGain: SPEECH_OUTPUT_FADE_INITIAL_GAIN,
            fadeMs: SPEECH_OUTPUT_FADE_DURATION_SECONDS * 1000,
          });
        },
        dispose() {
          if (sessionDisposed) {
            return;
          }
          sessionDisposed = true;
          if (activeSession === session) {
            activeSession = null;
          }
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
          try {
            outputGain.disconnect();
          } catch (_error) {
            // Browser audio graph teardown can race with element disposal.
          }
        },
      };
      activeSession = session;
      return session;
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      activeSession?.dispose();
      activeSession = null;
      const context = audioContext;
      audioContext = null;
      if (context && context.state !== "closed") {
        await context.close();
      }
    },
  };
}
