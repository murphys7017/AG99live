const SPEECH_OUTPUT_FADE_INITIAL_GAIN = 0.86;
const SPEECH_OUTPUT_FADE_DURATION_SECONDS = 0.04;
const SPEECH_OUTPUT_PRIMER_DURATION_SECONDS = 0.35;
const SPEECH_OUTPUT_REPRIME_IDLE_MS = 30_000;
const SPEECH_OUTPUT_KEEPALIVE_GAIN = 1 / 1_000_000;
const SPEECH_OUTPUT_KEEPALIVE_FREQUENCY_HZ = 20;

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
  let lastOutputActivityAtMs: number | null = null;
  let keepAliveSource: OscillatorNode | null = null;
  let keepAliveGain: GainNode | null = null;
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

  function primeOutput(context: AudioContext): Promise<void> {
    const source = context.createBufferSource();
    const frameCount = Math.ceil(
      context.sampleRate * SPEECH_OUTPUT_PRIMER_DURATION_SECONDS,
    );
    const buffer = context.createBuffer(1, frameCount, context.sampleRate);
    // Keep the primer technically non-silent so Chromium keeps the device path active,
    // while remaining far below an audible level.
    buffer.getChannelData(0)[0] = 1 / 32768;
    source.buffer = buffer;
    source.connect(context.destination);

    return new Promise<void>((resolve) => {
      source.addEventListener(
        "ended",
        () => {
          source.disconnect();
          resolve();
        },
        { once: true },
      );
      source.start();
    });
  }

  function ensureOutputKeepAlive(context: AudioContext): void {
    if (keepAliveSource) {
      return;
    }

    const source = context.createOscillator();
    const gain = context.createGain();
    source.frequency.value = SPEECH_OUTPUT_KEEPALIVE_FREQUENCY_HZ;
    gain.gain.value = SPEECH_OUTPUT_KEEPALIVE_GAIN;
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
    keepAliveSource = source;
    keepAliveGain = gain;
  }

  async function prepareOutput(context: AudioContext): Promise<void> {
    if (context.state === "closed") {
      throw new Error("speech_output_audio_context_closed");
    }
    const resumed = context.state !== "running";
    if (resumed) {
      await context.resume();
    }
    ensureOutputKeepAlive(context);
    const now = performance.now();
    const needsPrimer = !outputWarmed
      || resumed
      || lastOutputActivityAtMs === null
      || now - lastOutputActivityAtMs >= SPEECH_OUTPUT_REPRIME_IDLE_MS;
    if (needsPrimer) {
      await primeOutput(context);
      outputWarmed = true;
    }
    console.info("[SpeechOutput] output runtime prepared.", {
      audioContextState: context.state,
      resumed,
      primerMs: needsPrimer ? SPEECH_OUTPUT_PRIMER_DURATION_SECONDS * 1000 : 0,
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
          lastOutputActivityAtMs = performance.now();
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
        try {
          keepAliveSource?.stop();
        } catch (_error) {
          // The source may already be stopped while the context is closing.
        }
        keepAliveSource?.disconnect();
        keepAliveGain?.disconnect();
        keepAliveSource = null;
        keepAliveGain = null;
        await context.close();
      }
    },
  };
}
