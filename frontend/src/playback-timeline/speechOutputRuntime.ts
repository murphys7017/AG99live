import { createPcmOutputSession, type PcmOutputSession } from "./pcmOutputSession.js";

// PCM ramps during its silent scheduling lead, never through spoken samples.
const SPEECH_OUTPUT_FADE_INITIAL_GAIN = 0;
const SPEECH_OUTPUT_FADE_DURATION_SECONDS = 0.003;
const SPEECH_OUTPUT_PRIMER_DURATION_SECONDS = 0.12;
const SPEECH_OUTPUT_KEEPALIVE_GAIN = 1 / 1_000_000;
const SPEECH_OUTPUT_KEEPALIVE_FREQUENCY_HZ = 20;

export interface SpeechOutputSession {
  readonly analyser: AnalyserNode;
  readonly sampleRate: number;
  prepare(): Promise<void>;
  start(atTimeSeconds?: number): void;
  dispose(): void;
}

export interface SpeechOutputRuntime {
  prepare(): Promise<void>;
  attach(audio: HTMLAudioElement): SpeechOutputSession;
  attachPcm(identity: { turnId: string; messageId: string }, notBefore?: number): PcmOutputSession;
  dispose(): Promise<void>;
}

export function createSpeechOutputRuntime(): SpeechOutputRuntime {
  let audioContext: AudioContext | null = null;
  let activeSession: SpeechOutputSession | null = null;
  const pcmSessions = new Set<SpeechOutputSession>();
  let outputWarmed = false;
  let keepAliveSource: OscillatorNode | null = null;
  let keepAliveGain: GainNode | null = null;
  let disposed = false;
  let preparation: Promise<void> | null = null;
  let cancelPrimer: (() => void) | null = null;

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
      // PCM chunks are 32 kHz. Keep their source and context rates identical:
      // resampling each short AudioBuffer independently introduces boundary
      // artifacts. Device-rate conversion then happens on the continuous mix.
      sampleRate: 32000,
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
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin(2 * Math.PI * 50 * i / context.sampleRate) * (2 / 32768);
    }
    source.buffer = buffer;
    source.connect(context.destination);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const resolveReady = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const cancel = () => {
        try {
          source.stop();
        } catch (_error) {
          // The primer may already have ended while preparation is disposed.
        }
        source.disconnect();
        cancelPrimer = null;
        if (!settled) {
          settled = true;
          reject(new DOMException("Output preparation disposed.", "AbortError"));
        }
      };
      cancelPrimer = cancel;
      source.addEventListener(
        "ended",
        () => {
          source.disconnect();
          if (cancelPrimer === cancel) cancelPrimer = null;
          resolveReady();
        },
        { once: true },
      );
      try {
        source.start();
      } catch (error) {
        cancelPrimer = null;
        source.disconnect();
        settled = true;
        reject(error);
      }
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
    if (disposed) throw new Error("speech_output_runtime_disposed");
    ensureOutputKeepAlive(context);
    const needsPrimer = !outputWarmed || resumed;
    if (needsPrimer) {
      await primeOutput(context);
      outputWarmed = true;
    }
    if (disposed) throw new Error("speech_output_runtime_disposed");
    console.info("[SpeechOutput] output runtime prepared.", {
      audioContextState: context.state,
      sampleRate: context.sampleRate,
      resumed,
      primerDurationMs: needsPrimer ? SPEECH_OUTPUT_PRIMER_DURATION_SECONDS * 1000 : 0,
    });
  }

  async function prepare(): Promise<void> {
    const context = requireAudioContext();
    if (preparation) {
      // A suspended context cannot deliver the primer's ended event. A later
      // playback request (or user gesture) can resume the pending preparation.
      const pending = preparation;
      if (context.state === "suspended") await context.resume();
      return pending;
    }
    const pending = prepareOutput(context).finally(() => {
      if (preparation === pending) preparation = null;
    });
    preparation = pending;
    return pending;
  }

  function attachSource(context: AudioContext, source: AudioNode, replace = true): SpeechOutputSession {
    if (replace) activeSession?.dispose();

    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.28;
    const outputGain = context.createGain();
    // Media can consume samples before its JS "playing" event arrives.
    // Keep it audible from attachment; PCM supplies a scheduled start below.
    outputGain.gain.value = 1;
    source.connect(outputGain);
    outputGain.connect(analyser);
    analyser.connect(context.destination);

    let sessionDisposed = false;
    let outputStarted = false;
    const session: SpeechOutputSession = {
      analyser,
      sampleRate: context.sampleRate,
      prepare,
      start(atTimeSeconds) {
        if (sessionDisposed || outputStarted) {
          return;
        }
        outputStarted = true;
        const now = context.currentTime;
        if (atTimeSeconds !== undefined) {
          outputGain.gain.cancelScheduledValues(now);
          outputGain.gain.setValueAtTime(SPEECH_OUTPUT_FADE_INITIAL_GAIN, now);
          outputGain.gain.linearRampToValueAtTime(
            1,
            Math.max(now, Math.min(now + SPEECH_OUTPUT_FADE_DURATION_SECONDS, atTimeSeconds)),
          );
        }
        console.info("[SpeechOutput] segment output started.", {
          scheduledStartTime: atTimeSeconds ?? null,
          fadeMs: atTimeSeconds === undefined ? 0 : SPEECH_OUTPUT_FADE_DURATION_SECONDS * 1000,
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
  }

  return {
    prepare,
    attach(audio) {
      const context = requireAudioContext();
      return attachSource(context, context.createMediaElementSource(audio));
    },
    attachPcm(identity, notBefore) {
      const context = requireAudioContext();
      const input = context.createGain();
      const output = attachSource(context, input, false);
      const session = createPcmOutputSession(context, input, output, identity, notBefore);
      const dispose = session.dispose.bind(session);
      session.dispose = () => { pcmSessions.delete(session); dispose(); };
      pcmSessions.add(session);
      activeSession = session;
      return session;
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      cancelPrimer?.();
      for (const session of pcmSessions) session.dispose();
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
