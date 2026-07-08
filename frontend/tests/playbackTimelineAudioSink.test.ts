import assert from "node:assert/strict";
import {
  createAudioElementPlaybackClock,
} from "../src/adapter-connection/runtime/audioPlayback.js";
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
    onUnavailable: () => events.push("unavailable"),
    onTerminal: (terminal, reason) => events.push(`${terminal}:${reason}`),
  });

  runtime.attachAudio({
    audioUrl: "http://127.0.0.1/audio.wav",
    audio: {} as HTMLAudioElement,
    getAudioCurrentTimeSeconds: () => 0,
    isCurrentAudio: () => true,
  });
  attachedOptions[0]?.onUnavailable();
  runtime.completeAfterAudioEnded();

  assert.deepEqual(events, [
    "unavailable",
    "failed:lip_sync_unavailable",
  ]);
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
  await testBrowserAudioSinkDoesNotOwnLipSyncCallbacks();
  await testAudioSegmentSinkOwnsLipSyncEventOrdering();
  console.log("playbackTimelineAudioSink tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
