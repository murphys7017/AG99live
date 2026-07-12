import assert from "node:assert/strict";
import {
  createAudioElementPlaybackClock,
} from "../src/playback-timeline/audioSink.js";
import { createBrowserAudioTimelineSink } from "../src/playback-timeline/audioSink.js";
import type {
  PlaybackTimelineAudioSink,
  PlaybackTimelineAudioStartCallbacks,
} from "../src/playback-timeline/audioSink.js";
import {
  createPlaybackTimelineAudioSegmentSink,
} from "../src/playback-timeline/audioSegmentPlaybackSink.js";
import {
  createPlaybackTimelineLipSyncRuntime,
  type PlaybackTimelineLipSyncSink,
} from "../src/playback-timeline/lipSyncSink.js";
import { createLive2DLipSyncTimelineSink } from "../src/live2d/lipSyncTimelineSink.js";

class FakeAudio {
  static instances: FakeAudio[] = [];

  currentTime = 0.25;
  duration = 1.5;
  playbackRate = 1;
  paused = true;
  ended = false;
  crossOrigin = "";
  src = "";
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor() {
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  async play(): Promise<void> {
    this.paused = false;
    await Promise.resolve();
    this.emit("loadedmetadata");
    this.emit("playing");
  }

  pause(): void {
    this.paused = true;
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

function testAudioElementPlaybackClockMapsElementState(): void {
  const clock = createAudioElementPlaybackClock({
    currentTime: 1.234,
    duration: 4.567,
    playbackRate: 1.25,
    paused: false,
    ended: false,
  });

  assert.equal(clock.getCurrentTimeMs(), 1234);
  assert.equal(clock.getDurationMs(), 4567);
  assert.equal(clock.getPlaybackRate(), 1.25);
  assert.equal(clock.isPlaying(), true);
}

function testAudioElementPlaybackClockHandlesInvalidValues(): void {
  const clock = createAudioElementPlaybackClock({
    currentTime: Number.NaN,
    duration: -1,
    playbackRate: 0,
    paused: true,
    ended: false,
  });

  assert.equal(clock.getCurrentTimeMs(), null);
  assert.equal(clock.getDurationMs(), null);
  assert.equal(clock.getPlaybackRate(), 1);
  assert.equal(clock.isPlaying(), false);
}

function testLipSyncRuntimeFailsWhenAudioEndsBeforeStart(): void {
  const events: string[] = [];
  const sink: PlaybackTimelineLipSyncSink = {
    attachAudio: () => {},
    resume: async () => {},
    stop: () => {},
  };
  const runtime = createPlaybackTimelineLipSyncRuntime(sink, {
    onStarted: () => events.push("started"),
    onTerminal: (terminal, reason) => events.push(`${terminal}:${reason}`),
  });

  runtime.completeAfterAudioEnded();

  assert.deepEqual(events, ["failed:lip_sync_not_started_before_audio_end"]);
}

function testLipSyncRuntimeKeepsUnavailableTerminalStable(): void {
  const events: string[] = [];
  const attachedOptions: Array<Parameters<PlaybackTimelineLipSyncSink["attachAudio"]>[0]> = [];
  const sink: PlaybackTimelineLipSyncSink = {
    attachAudio: (options) => {
      attachedOptions.push(options);
    },
    resume: async () => {},
    stop: () => {},
  };
  const runtime = createPlaybackTimelineLipSyncRuntime(sink, {
    onUnavailable: (reason, degraded) => events.push(`unavailable:${reason}:${degraded}`),
    onTerminal: (terminal, reason) => events.push(`${terminal}:${reason}`),
  });

  runtime.attachAudio({
    audioUrl: "http://127.0.0.1/audio.wav",
    audio: {} as HTMLAudioElement,
    getAudioCurrentTimeSeconds: () => 0,
    isCurrentAudio: () => true,
  });
  attachedOptions[0]?.onUnavailable("lip_sync_audio_context_unavailable", true);
  runtime.completeAfterAudioEnded();

  assert.deepEqual(events, [
    "unavailable:lip_sync_audio_context_unavailable:true",
    "failed:lip_sync_audio_context_unavailable",
  ]);
}

async function testLiveLipSyncUsesRandomFallbackWhenWebAudioIsUnavailable(): Promise<void> {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const values: number[] = [];
  let cleared = false;
  let speechEnergyWrites = 0;
  let speechEnergyCleared = false;
  const scheduled = new Map<number, () => void>();
  let nextTimerId = 1;
  (globalThis as { window?: unknown }).window = {
    getLAppAdapter: () => ({
      setExternalLipSyncValue: (value: number) => values.push(value),
      setExternalSpeechEnergyValue: () => {
        speechEnergyWrites += 1;
      },
      clearExternalLipSyncValue: () => {
        cleared = true;
      },
      clearExternalSpeechEnergyValue: () => {
        speechEnergyCleared = true;
      },
      hasConfiguredLipSyncParameters: () => true,
    }),
    AudioContext: undefined,
    webkitAudioContext: undefined,
    setTimeout: (callback: () => void) => {
      const timerId = nextTimerId++;
      scheduled.set(timerId, callback);
      return timerId;
    },
    clearTimeout: (timerId: number) => {
      scheduled.delete(timerId);
    },
  };

  const unavailable: string[] = [];
  try {
    const sink = createLive2DLipSyncTimelineSink();
    sink.attachAudio({
      audioUrl: "http://127.0.0.1/audio.wav",
      audio: {} as HTMLAudioElement,
      getAudioCurrentTimeSeconds: () => 0,
      isCurrentAudio: () => true,
      onStarted: () => unavailable.push("unexpected_started"),
      onUnavailable: (reason, degraded) => unavailable.push(`${reason}:${degraded}`),
    });
    await sink.resume();

    assert.deepEqual(unavailable, ["lip_sync_audio_context_unavailable:true"]);
    assert.equal(values.length, 1);
    assert.equal(speechEnergyWrites, 0);
    assert.equal(scheduled.size, 1);

    sink.stop();
    assert.equal(cleared, true);
    assert.equal(speechEnergyCleared, true);
    assert.equal(scheduled.size, 0);
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
}

async function testLiveLipSyncPublishesIndependentSpeechEnergyFromAnalyser(): Promise<void> {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const lipSyncValues: number[] = [];
  const speechEnergyValues: number[] = [];
  let lipSyncCleared = false;
  let speechEnergyCleared = false;
  let hasLipSyncParameters = true;
  const frame: { callback: FrameRequestCallback | null } = { callback: null };

  class FakeAudioContext {
    state = "running";
    destination = {};

    createAnalyser() {
      return {
        fftSize: 0,
        smoothingTimeConstant: 0,
        connect: () => {},
        disconnect: () => {},
        getByteTimeDomainData: (samples: Uint8Array) => samples.fill(148),
      };
    }

    createMediaElementSource() {
      return {
        connect: () => {},
        disconnect: () => {},
      };
    }

    async resume(): Promise<void> {}
    async close(): Promise<void> {}
  }

  const adapter = {
    lipSyncValues,
    speechEnergyValues,
    setExternalLipSyncValue(value: number) {
      this.lipSyncValues.push(value);
    },
    setExternalSpeechEnergyValue(value: number) {
      this.speechEnergyValues.push(value);
    },
    clearExternalLipSyncValue: () => {
      lipSyncCleared = true;
    },
    clearExternalSpeechEnergyValue: () => {
      speechEnergyCleared = true;
    },
    hasConfiguredLipSyncParameters: () => hasLipSyncParameters,
  };

  (globalThis as { window?: unknown }).window = {
    getLAppAdapter: () => adapter,
    AudioContext: FakeAudioContext,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frame.callback = callback;
      return 1;
    },
    cancelAnimationFrame: () => {
      frame.callback = null;
    },
  };

  try {
    const sink = createLive2DLipSyncTimelineSink();
    sink.attachAudio({
      audioUrl: "http://127.0.0.1/audio.wav",
      audio: {} as HTMLAudioElement,
      getAudioCurrentTimeSeconds: () => 0,
      isCurrentAudio: () => true,
      onStarted: () => {},
      onUnavailable: (reason) => assert.fail(`unexpected lip-sync failure: ${reason}`),
    });
    await sink.resume();
    const callback = frame.callback;
    assert.ok(callback);
    callback(16);

    assert.equal(lipSyncValues.length, 1);
    assert.equal(speechEnergyValues.length, 1);
    assert.ok(lipSyncValues[0] > speechEnergyValues[0]);
    assert.ok(speechEnergyValues[0] > 0);

    sink.stop();
    assert.equal(lipSyncCleared, true);
    assert.equal(speechEnergyCleared, true);

    hasLipSyncParameters = false;
    const unavailable: string[] = [];
    const energyCount = speechEnergyValues.length;
    const lipSyncCount = lipSyncValues.length;
    const energyOnlySink = createLive2DLipSyncTimelineSink();
    energyOnlySink.attachAudio({
      audioUrl: "http://127.0.0.1/audio.wav",
      audio: {} as HTMLAudioElement,
      getAudioCurrentTimeSeconds: () => 0,
      isCurrentAudio: () => true,
      onStarted: () => {},
      onUnavailable: (reason, degraded) => unavailable.push(`${reason}:${degraded}`),
    });
    await energyOnlySink.resume();
    const energyOnlyCallback = frame.callback;
    assert.ok(energyOnlyCallback);
    energyOnlyCallback(32);

    assert.deepEqual(unavailable, ["lip_sync_parameters_unconfigured:true"]);
    assert.equal(lipSyncValues.length, lipSyncCount);
    assert.equal(speechEnergyValues.length, energyCount + 1);
    energyOnlySink.stop();
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
}

async function testBrowserAudioSinkDoesNotOwnLipSyncCallbacks(): Promise<void> {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalAudio = (globalThis as { Audio?: unknown }).Audio;
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  FakeAudio.instances.length = 0;

  let audioElementCreated = false;
  try {
    const audioSink = createBrowserAudioTimelineSink();
    await audioSink.start("http://127.0.0.1/audio.wav", {
      onAudioElementCreated: () => {
        audioElementCreated = true;
      },
    });
    await Promise.resolve();
    FakeAudio.instances[0].emit("ended");

    assert.equal(audioElementCreated, true);
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { Audio?: unknown }).Audio = originalAudio;
  }
}

async function testAudioSegmentSinkOwnsLipSyncEventOrdering(): Promise<void> {
  const events: string[] = [];
  let callbacksRef: PlaybackTimelineAudioStartCallbacks | null = null;
  const audioSink: PlaybackTimelineAudioSink = {
    start: async (_audioUrl, callbacks = {}) => {
      callbacksRef = callbacks;
      callbacks.onAudioElementCreated?.({
        audioUrl: "http://127.0.0.1/audio.wav",
        audio: {} as HTMLAudioElement,
        getAudioCurrentTimeSeconds: () => 0,
        isCurrentAudio: () => true,
      });
      callbacks.onPlaybackStarted?.({
        startedAtMs: 10,
        durationMs: 500,
      });
      callbacks.onEnded?.();
    },
    stop: () => events.push("audio:stop"),
    getClock: () => null,
  };

  const segmentSink = createPlaybackTimelineAudioSegmentSink({
    audioSink,
    createLipSyncSink: () => ({
      attachAudio: () => events.push("lip:attach"),
      start: () => events.push("lip:start"),
      completeAfterAudioEnded: () => events.push("lip:complete"),
      failAfterAudioError: () => events.push("lip:fail"),
      stop: () => events.push("lip:stop"),
    }),
  });

  await segmentSink.start("http://127.0.0.1/audio.wav", "turn-audio", "msg-audio", {
    onPlaybackStarted: () => events.push("audio:started"),
    onEnded: () => events.push("audio:ended"),
  });

  assert.ok(callbacksRef);
  assert.deepEqual(events, [
    "lip:attach",
    "lip:start",
    "audio:started",
    "lip:complete",
    "audio:ended",
  ]);
}

async function run(): Promise<void> {
  testAudioElementPlaybackClockMapsElementState();
  testAudioElementPlaybackClockHandlesInvalidValues();
  testLipSyncRuntimeFailsWhenAudioEndsBeforeStart();
  testLipSyncRuntimeKeepsUnavailableTerminalStable();
  await testLiveLipSyncUsesRandomFallbackWhenWebAudioIsUnavailable();
  await testLiveLipSyncPublishesIndependentSpeechEnergyFromAnalyser();
  await testBrowserAudioSinkDoesNotOwnLipSyncCallbacks();
  await testAudioSegmentSinkOwnsLipSyncEventOrdering();
  console.log("playbackTimelineAudioSink tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
