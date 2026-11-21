import { createSpeechOutputRuntime } from "../src/playback-timeline/speechOutputRuntime";
import { createBrowserAudioTimelineSink } from "../src/playback-timeline/audioSink";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const check = (condition: boolean, message: string) => { if (!condition) throw Error(message); };

export async function run() {
  // Exercise Chromium's live audio graph without opening a physical output device.
  const NativeContext = window.AudioContext;
  window.AudioContext = class extends NativeContext {
    constructor(options?: AudioContextOptions) {
      super({ ...options, sinkId: { type: "none" } } as AudioContextOptions);
    }
  };
  const events: string[] = [];
  let notifyReady: (() => void) | undefined;
  let notifyResume: (() => void) | undefined;
  const nextPrimer = () => new Promise<void>(resolve => { notifyReady = resolve; });
  Object.assign(window, { ag99desktop: {
    reportLatencyEvent: (e: { stage: string }) => {
      events.push(e.stage);
      if (e.stage === "output_primer_presented") notifyReady?.();
    },
    onIpc(channel: string, callback: () => void) {
      check(channel === "desktop:system-resumed", "Unexpected power event subscription");
      notifyResume = callback;
      return () => { notifyResume = undefined; };
    },
  } });
  const startupReady = nextPrimer();
  const startup = performance.now();
  const runtime = createSpeechOutputRuntime();
  await startupReady; // No turn, speech session, or user gesture.
  const startupMs = Math.round(performance.now() - startup);
  const open = (turnId: string, messageId: string) => runtime.attachPcm({ turnId, messageId });
  const cold = open("first", "cold");
  const context = cold.context;
  const worklet = URL.createObjectURL(new Blob([
    `registerProcessor("capture", class extends AudioWorkletProcessor {
      process(inputs) {
        if (inputs[0][0]) this.port.postMessage({ frame: currentFrame, samples: inputs[0][0] });
        return true;
      }
    })`,
  ], { type: "text/javascript" }));
  try {
    await context.audioWorklet.addModule(worklet);
    const wav = (window as Window & {fixtureWav?: string}).fixtureWav;
    let fileUrl: string | undefined;
    let pcm = Float32Array.from({ length: 8192 }, (_, i) => ((i * 197 % 1021) - 510) / 1024);
    if (wav) {
      const bytes = Uint8Array.from(atob(wav), c => c.charCodeAt(0));
      fileUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      const decoded = (await context.decodeAudioData(bytes.buffer)).getChannelData(0);
      const onset = decoded.findIndex(sample => Math.abs(sample) >= 0.02);
      check(onset >= 0, "Fixture needs a voiced onset");
      pcm = decoded.slice(onset, onset + 16000);
    }
    async function verify(session: typeof cold, input: Float32Array, interruptBeforeFlush = false) {
      const tap = new AudioWorkletNode(context, "capture");
      const frames: number[] = [];
      let voicedFrame = -1;
      tap.port.onmessage = ({ data }) => {
        if (voicedFrame < 0) {
          const sample = data.samples.findIndex((v: number) => v !== 0);
          if (sample >= 0) voicedFrame = data.frame + sample;
        }
        frames.push(...data.samples);
      };
      session.analyser.connect(tap);
      tap.connect(context.destination);
      const beforePrepare = performance.now();
      await session.prepare();
      const prepareMs = Math.round(performance.now() - beforePrepare);
      const start = session.started.then(at => ({ at, stamp: context.getOutputTimestamp() }));
      await session.append(0, input);
      if (interruptBeforeFlush) await context.suspend();
      await session.finish(input.length);
      const { at, stamp } = await start;
      await session.completed;
      const positionAtEndMs = session.clock.getCurrentTimeMs();
      await wait(50);
      const first = frames.findIndex(sample => sample === input[0]);
      check(first >= 0 && input.every((v, i) => frames[first + i] === v), "Speech samples lost or changed");
      check(positionAtEndMs === input.length / context.sampleRate * 1000, "Truncated presentation clock");
      // Compare the public start event against the first nonzero AudioWorklet frame,
      // mapped independently through Chromium's device timestamp at notification.
      const startErrorMs = stamp.performanceTime! + (voicedFrame / context.sampleRate - stamp.contextTime!) * 1000 - at;
      check(voicedFrame >= 0 && !!stamp.performanceTime && Math.abs(startErrorMs) <= 12,
        "Audio timeline start differs from output waveform by " + startErrorMs + " ms");
      tap.port.close();
      tap.disconnect();
      session.dispose();
      return { prepareMs, samplesMatched: input.length, startErrorMs, positionAtEndMs };
    }
    const primers = () => events.filter(e => e === "output_primer_presented").length;
    await Promise.all([runtime.prepare("first"), runtime.prepare("first")]);
    const coldStart = await verify(cold, pcm);
    const continuous = await verify(open("first", "continuous"), pcm);
    check(primers() === 1, "Overlapping requests or continuous segments repeated warmup");
    const idleStart = context.getOutputTimestamp().contextTime!;
    await wait(31000);
    const idleOutputMs = Math.round((context.getOutputTimestamp().contextTime! - idleStart) * 1000);
    check(idleOutputMs >= 30000, "Output clock stopped during silence");
    const afterIdle = await verify(open("second", "idle"), pcm);
    check(primers() === 1, "Idle time or a new turn repeated warmup on the active route");
    const short = open("next", "short");
    const afterSuspend = await verify(short, pcm.slice(0, 256), true);
    check(primers() === 2, "Suspended output failed to recover once");
    let fileDurationMs: number | undefined;
    if (fileUrl) {
      const sink = createBrowserAudioTimelineSink({ speechOutputRuntime: runtime });
      try {
        await new Promise<void>((resolve, reject) => {
          void sink.start(fileUrl!, "file", {
            onPlaybackStarted: event => { fileDurationMs = event.durationMs ?? undefined; },
            onEnded: resolve, onError: () => reject(Error("Media output failed")),
          }).catch(reject);
        });
        check(!!fileDurationMs && primers() === 2, "File playback failed to reuse the active output");
        let disposals = 0;
        let ended = false;
        await new Promise<void>((resolve, reject) => {
          void sink.start(fileUrl!, "interrupt", {
            onPlaybackStarted: () => { sink.stop(); resolve(); },
            onAudioElementDisposed: () => { disposals++; },
            onEnded: () => { ended = true; },
            onError: () => reject(Error("Media output failed before interruption")),
          }).catch(reject);
        });
        check(disposals === 1 && !ended, "Interrupted file did not retire exactly once");
      } finally {
        sink.dispose();
        URL.revokeObjectURL(fileUrl);
      }
    }
    const recovered = nextPrimer();
    notifyResume?.();
    await recovered;
    check(primers() === 3, "System resume failed to restore idle output");
    context.dispatchEvent(new Event("sinkchange"));
    const cancelled = runtime.prepare("cancelled").then(() => false, error => error.name === "AbortError");
    await runtime.dispose();
    check(await cancelled, "Disposed output reported ready");
    return { startupMs, idleOutputMs, coldStart, continuous, afterIdle, afterSuspend, primers: primers(), fileDurationMs };
  } finally {
    URL.revokeObjectURL(worklet);
    await runtime.dispose();
  }
}
