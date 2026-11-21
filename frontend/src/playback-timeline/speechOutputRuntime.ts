import { reportLatencyStage } from "../adapter-connection/runtime/latency.js";
import { desktopHostPort } from "../desktop-bridge/desktopHostPort.js";
import { onOutputPresented } from "./outputPresentationClock.js";
import { createPcmOutputSession, type PcmOutputSession } from "./pcmOutputSession.js";

// PCM ramps during its silent scheduling lead, never through spoken samples.
const SPEECH_OUTPUT_FADE_INITIAL_GAIN = 0;
const SPEECH_OUTPUT_FADE_DURATION_SECONDS = 0.003;
const SPEECH_OUTPUT_PRIMER_DURATION_SECONDS = 0.12;
// The wake signal must survive conversion to a 16-bit output mix.
const SPEECH_OUTPUT_WAKE_GAIN = 2 / 32768;
const SPEECH_OUTPUT_KEEPALIVE_FREQUENCY_HZ = 20;

export interface SpeechOutputSession {
  readonly context: AudioContext;
  readonly analyser: AnalyserNode;
  readonly sampleRate: number;
  prepare(): Promise<void>;
  start(atTimeSeconds?: number): void;
  dispose(): void;
}

export interface SpeechOutputRuntime {
  prepare(turnId?: string): Promise<void>;
  attach(audio: HTMLAudioElement, turnId: string | null): SpeechOutputSession;
  attachPcm(identity: { turnId: string; messageId: string }, notBefore?: number): PcmOutputSession;
  dispose(): Promise<void>;
}

export function createSpeechOutputRuntime(): SpeechOutputRuntime {
  let audioContext: AudioContext | null = null;
  let activeSession: SpeechOutputSession | null = null;
  const pcmSessions = new Set<SpeechOutputSession>();
  let preparedRevision = -1;
  let routeRevision = 0;
  let keepAliveSource: OscillatorNode | null = null;
  let keepAliveGain: GainNode | null = null;
  let disposed = false;
  let preparation: Promise<void> | null = null;
  let cancelPrimer: (() => void) | null = null;

  function invalidateOutput(): void {
    routeRevision++;
    cancelPrimer?.();
  }

  function warmInBackground(): void {
    void prepare().catch(error => {
      if (!disposed) console.warn("[SpeechOutput] background preparation failed.", error);
    });
  }

  function onRouteChange(): void {
    if (disposed) return;
    invalidateOutput();
    warmInBackground();
  }

  function onContextStateChange(): void {
    const state = audioContext?.state;
    if (state !== "running") invalidateOutput();
    if (disposed || !keepAliveSource || (state !== "running" && state !== "suspended")) return;
    if (!preparation && preparedRevision !== routeRevision) {
      warmInBackground();
    }
  }

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
    audioContext.addEventListener("statechange", onContextStateChange);
    audioContext.addEventListener("sinkchange", onRouteChange);
    navigator.mediaDevices?.addEventListener("devicechange", onRouteChange);
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
      samples[i] = Math.sin(2 * Math.PI * 50 * i / context.sampleRate) * SPEECH_OUTPUT_WAKE_GAIN;
    }
    source.buffer = buffer;
    source.connect(context.destination);

    return new Promise<void>((resolve, reject) => {
      const startTime = context.currentTime;
      const endTime = startTime + buffer.duration;
      let cancelPresentation: (() => void) | undefined;
      const cancel = () => {
        cancelPresentation?.();
        try {
          source.stop();
        } catch (_error) {
          // The primer may already have ended while preparation is disposed.
        }
        source.disconnect();
        cancelPrimer = null;
        reject(new DOMException("Output preparation interrupted.", "AbortError"));
      };
      cancelPrimer = cancel;
      source.addEventListener(
        "ended",
        () => {
          source.disconnect();
          if (cancelPrimer !== cancel) return;
          cancelPresentation = onOutputPresented(context, endTime, () => {
            cancelPrimer = null;
            resolve();
          });
        },
        { once: true },
      );
      try {
        source.start(startTime);
      } catch (error) {
        cancelPrimer = null;
        source.disconnect();
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
    gain.gain.value = SPEECH_OUTPUT_WAKE_GAIN;
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
    keepAliveSource = source;
    keepAliveGain = gain;
  }

  async function prepareOutput(context: AudioContext, turnId?: string): Promise<void> {
    if (context.state === "closed") {
      throw new Error("speech_output_audio_context_closed");
    }
    if (context.state !== "running") {
      invalidateOutput();
      await context.resume();
    }
    if (disposed) throw new Error("speech_output_runtime_disposed");
    ensureOutputKeepAlive(context);
    const revision = routeRevision;
    reportLatencyStage("output_primer_started", turnId ?? null);
    try {
      await primeOutput(context);
    } catch (error) {
      if (disposed || revision === routeRevision) throw error;
      return; // prepare() retries for the replacement route.
    }
    if (revision === routeRevision && context.state === "running") {
      preparedRevision = revision;
      reportLatencyStage("output_primer_presented", turnId ?? null);
    }
  }

  async function prepare(turnId?: string): Promise<void> {
    const context = requireAudioContext();
    try {
      while (!disposed) {
        if (context.state === "running" && preparedRevision === routeRevision) return;
        if (preparation) {
          const pending = preparation;
          // A later user gesture can resume a pending or suspended preparation.
          if (context.state === "suspended") await context.resume();
          await pending;
        } else {
          preparation = prepareOutput(context, turnId).finally(() => { preparation = null; });
          await preparation;
        }
      }
    } catch (error) {
      if (!disposed) throw error;
    }
    throw new DOMException("Output preparation interrupted.", "AbortError");
  }

  function attachSource(context: AudioContext, source: AudioNode, replace = true, turnId?: string): SpeechOutputSession {
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
      context,
      analyser,
      sampleRate: context.sampleRate,
      prepare: () => prepare(turnId),
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

  // The pet renderer owns this graph for its lifetime, including gaps between turns.
  const stopListeningForResume = desktopHostPort.getApi()?.onIpc("desktop:system-resumed", onRouteChange);
  warmInBackground();
  return {
    prepare,
    attach(audio, turnId) {
      const context = requireAudioContext();
      return attachSource(context, context.createMediaElementSource(audio), true, turnId ?? undefined);
    },
    attachPcm(identity, notBefore) {
      const context = requireAudioContext();
      const input = context.createGain();
      const output = attachSource(context, input, false, identity.turnId);
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
      stopListeningForResume?.();
      cancelPrimer?.();
      for (const session of pcmSessions) session.dispose();
      activeSession?.dispose();
      activeSession = null;
      const context = audioContext;
      audioContext = null;
      context?.removeEventListener("statechange", onContextStateChange);
      context?.removeEventListener("sinkchange", onRouteChange);
      navigator.mediaDevices?.removeEventListener("devicechange", onRouteChange);
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
