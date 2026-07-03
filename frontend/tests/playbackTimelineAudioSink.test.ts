import assert from "node:assert/strict";
import {
  createAudioElementPlaybackClock,
} from "../src/adapter-connection/runtime/audioPlayback.js";

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

function run(): void {
  testAudioElementPlaybackClockMapsElementState();
  testAudioElementPlaybackClockHandlesInvalidValues();
  console.log("playbackTimelineAudioSink tests passed");
}

run();
