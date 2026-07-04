import assert from "node:assert/strict";
import {
  createAudioElementPlaybackClock,
} from "../src/adapter-connection/runtime/audioPlayback.js";
import { createBrowserAudioTimelineSink } from "../src/playback-timeline/audioSink.js";
import type { PlaybackTimelineLipSyncSink } from "../src/playback-timeline/lipSyncSink.js";

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

async function testBrowserAudioSinkDrivesLipSyncSink(): Promise<void> {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalAudio = (globalThis as { Audio?: unknown }).Audio;
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  FakeAudio.instances.length = 0;

  const events: string[] = [];
  let attachedOptions: Parameters<PlaybackTimelineLipSyncSink["attachAudio"]>[0] | null = null;
  const lipSyncSink: PlaybackTimelineLipSyncSink = {
    attachAudio: (options) => {
      events.push(`attach:${options.audioUrl}`);
      attachedOptions = options;
    },
    resume: async () => {
      events.push("resume");
      attachedOptions?.onStarted();
    },
    stop: () => {
      events.push("stop");
    },
  };

  try {
    const audioSink = createBrowserAudioTimelineSink(lipSyncSink);
    let playbackStarted = false;
    await audioSink.start("http://127.0.0.1/audio.wav", {
      onLipSyncStarted: () => {
        events.push("timeline:started");
      },
      onLipSyncTerminal: (terminal, reason) => {
        events.push(`timeline:${terminal}:${reason}`);
      },
      onPlaybackStarted: () => {
        playbackStarted = true;
      },
    });
    await Promise.resolve();

    assert.equal(playbackStarted, true);
    assert.deepEqual(events, [
      "stop",
      "attach:http://127.0.0.1/audio.wav",
      "resume",
      "timeline:started",
    ]);
    assert.equal(audioSink.getClock()?.getCurrentTimeMs(), 250);

    FakeAudio.instances[0].emit("ended");
    assert.deepEqual(events.slice(-2), [
      "stop",
      "timeline:completed:audio_playback_completed",
    ]);
    assert.equal(audioSink.getClock(), null);

    audioSink.stop();
    assert.equal(events.at(-1), "stop");
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { Audio?: unknown }).Audio = originalAudio;
  }
}

async function testBrowserAudioSinkDoesNotStartLipSyncWithoutSinkConfirmation(): Promise<void> {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalAudio = (globalThis as { Audio?: unknown }).Audio;
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  FakeAudio.instances.length = 0;

  const events: string[] = [];
  const lipSyncSink: PlaybackTimelineLipSyncSink = {
    attachAudio: () => {
      events.push("attach");
    },
    resume: async () => {
      events.push("resume");
    },
    stop: () => {
      events.push("stop");
    },
  };

  try {
    const audioSink = createBrowserAudioTimelineSink(lipSyncSink);
    await audioSink.start("http://127.0.0.1/audio.wav", {
      onLipSyncStarted: () => {
        events.push("timeline:started");
      },
    });
    await Promise.resolve();

    assert.equal(events.includes("timeline:started"), false);
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { Audio?: unknown }).Audio = originalAudio;
  }
}

async function testBrowserAudioSinkKeepsLipSyncFailureTerminal(): Promise<void> {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalAudio = (globalThis as { Audio?: unknown }).Audio;
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  FakeAudio.instances.length = 0;

  const events: string[] = [];
  const lipSyncSink: PlaybackTimelineLipSyncSink = {
    attachAudio: (options) => {
      events.push("attach");
      options.onUnavailable();
    },
    resume: async () => {
      events.push("resume");
    },
    stop: () => {
      events.push("stop");
    },
  };

  try {
    const audioSink = createBrowserAudioTimelineSink(lipSyncSink);
    await audioSink.start("http://127.0.0.1/audio.wav", {
      onLipSyncTerminal: (terminal, reason) => {
        events.push(`timeline:${terminal}:${reason}`);
      },
    });
    await Promise.resolve();

    FakeAudio.instances[0].emit("ended");
    assert.deepEqual(
      events.filter((event) => event.startsWith("timeline:")),
      ["timeline:failed:lip_sync_unavailable"],
    );
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { Audio?: unknown }).Audio = originalAudio;
  }
}

async function testBrowserAudioSinkReportsDefaultLipSyncUnavailable(): Promise<void> {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalAudio = (globalThis as { Audio?: unknown }).Audio;
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  FakeAudio.instances.length = 0;

  const terminalEvents: string[] = [];
  try {
    const audioSink = createBrowserAudioTimelineSink();
    await audioSink.start("http://127.0.0.1/audio.wav", {
      onLipSyncTerminal: (terminal, reason) => {
        terminalEvents.push(`${terminal}:${reason}`);
      },
    });
    await Promise.resolve();

    assert.deepEqual(terminalEvents, ["failed:lip_sync_unavailable"]);
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { Audio?: unknown }).Audio = originalAudio;
  }
}

async function run(): Promise<void> {
  testAudioElementPlaybackClockMapsElementState();
  testAudioElementPlaybackClockHandlesInvalidValues();
  await testBrowserAudioSinkDrivesLipSyncSink();
  await testBrowserAudioSinkDoesNotStartLipSyncWithoutSinkConfirmation();
  await testBrowserAudioSinkKeepsLipSyncFailureTerminal();
  await testBrowserAudioSinkReportsDefaultLipSyncUnavailable();
  console.log("playbackTimelineAudioSink tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
