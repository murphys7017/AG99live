import assert from "node:assert/strict";
import {
  createPlaybackTimelineEngine,
} from "../src/playback-timeline/playbackTimelineEngine.js";
import { createTimelineClock } from "../src/playback-timeline/timelineClock.js";
import type { AudioPlaybackClock } from "../src/playback-timeline/contracts.js";

function testSyntheticClockLifecycle(): void {
  let nowMs = 100;
  const clock = createTimelineClock({ now: () => nowMs });

  clock.start();
  nowMs = 250;
  assert.equal(clock.snapshot().currentTimeMs, 150);

  clock.pause();
  nowMs = 400;
  assert.equal(clock.snapshot().currentTimeMs, 150);
  assert.equal(clock.snapshot().paused, true);

  clock.resume();
  nowMs = 550;
  assert.equal(clock.snapshot().currentTimeMs, 300);

  clock.stop();
  nowMs = 900;
  assert.equal(clock.snapshot().currentTimeMs, 300);
  assert.equal(clock.snapshot().stopped, true);
}

function testAudioClockTakesPriorityAndExposesUnavailableState(): void {
  let nowMs = 0;
  let audioPlaying = true;
  let audioCurrentTimeMs = 320;
  const audioClock: AudioPlaybackClock = {
    getCurrentTimeMs: () => audioCurrentTimeMs,
    getDurationMs: () => 1200,
    getPlaybackRate: () => 1,
    isPlaying: () => audioPlaying,
  };
  const clock = createTimelineClock({ now: () => nowMs });
  clock.setExpectedDurationMs(900);
  clock.start();
  clock.attachAudioClock(audioClock);

  let snapshot = clock.snapshot();
  assert.equal(snapshot.clockSource, "audio");
  assert.equal(snapshot.currentTimeMs, 320);
  assert.equal(snapshot.durationMs, 1200);

  audioPlaying = false;
  nowMs = 480;
  snapshot = clock.snapshot();
  assert.equal(snapshot.clockSource, "audio_unavailable");
  assert.equal(snapshot.currentTimeMs, 480);
  assert.equal(snapshot.durationMs, 900);

  clock.stop();
  audioPlaying = true;
  audioCurrentTimeMs = 800;
  snapshot = clock.snapshot();
  assert.equal(snapshot.clockSource, "synthetic");
  assert.equal(snapshot.currentTimeMs, 480);
}

function testClockResetClearsPreviousAudioBindingAndDuration(): void {
  let nowMs = 0;
  const clock = createTimelineClock({ now: () => nowMs });
  const audioClock: AudioPlaybackClock = {
    getCurrentTimeMs: () => 250,
    getDurationMs: () => 700,
    getPlaybackRate: () => 1,
    isPlaying: () => true,
  };

  clock.setExpectedDurationMs(900);
  clock.attachAudioClock(audioClock);
  clock.start();
  assert.equal(clock.snapshot().clockSource, "audio");

  clock.reset();
  nowMs = 300;
  const snapshot = clock.snapshot();
  assert.equal(snapshot.clockSource, "synthetic");
  assert.equal(snapshot.currentTimeMs, 0);
  assert.equal(snapshot.durationMs, null);
}

function testTimelineCompletesWhenRequiredSinksSettle(): void {
  let nowMs = 0;
  const engine = createPlaybackTimelineEngine({ now: () => nowMs });
  engine.load(
    { turnId: "turn-1", messageId: "msg-1" },
    [
      { id: "audio", required: true },
      { id: "motion", required: true },
      { id: "lip_sync", required: false },
    ],
  );

  engine.markSinkStarted("audio");
  assert.equal(engine.getPhase(), "preparing");
  engine.markSinkStarted("motion");
  assert.equal(engine.getPhase(), "ready");
  engine.start();
  assert.equal(engine.getPhase(), "playing");

  engine.markSinkTerminal("lip_sync", "failed", "optional_sink_failed");
  assert.equal(engine.getPhase(), "playing");

  nowMs = 100;
  engine.markSinkTerminal("audio", "completed");
  assert.equal(engine.getPhase(), "playing");
  engine.markSinkTerminal("motion", "completed");
  assert.equal(engine.getPhase(), "completed");

  const snapshot = engine.getSnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot?.currentTimeMs, 100);
}

function testTimelineFailsWhenRequiredSinkFails(): void {
  const engine = createPlaybackTimelineEngine({ now: () => 0 });
  engine.load(
    { turnId: "turn-2", messageId: "msg-2" },
    [
      { id: "audio", required: true },
      { id: "motion", required: true },
    ],
  );

  engine.markSinkStarted("audio");
  engine.markSinkStarted("motion");
  engine.start();

  engine.markSinkTerminal("audio", "completed");
  assert.equal(engine.getPhase(), "playing");
  engine.markSinkTerminal("motion", "failed", "compile_failed");
  assert.equal(engine.getPhase(), "failed");
}

function testInterruptPropagatesToActiveSinks(): void {
  const interrupted: string[] = [];
  const engine = createPlaybackTimelineEngine({ now: () => 0 });
  engine.load(
    { turnId: "turn-3", messageId: "msg-3" },
    [
      {
        id: "audio",
        required: true,
        onInterrupt: (reason) => interrupted.push(`audio:${reason}`),
      },
      {
        id: "motion",
        required: true,
        onInterrupt: (reason) => interrupted.push(`motion:${reason}`),
      },
      {
        id: "curve",
        required: false,
        initialTerminal: "absent",
      },
    ],
  );

  engine.markSinkStarted("audio");
  engine.markSinkStarted("motion");
  engine.start();
  engine.interrupt("session_replaced");

  assert.equal(engine.getPhase(), "interrupted");
  assert.deepEqual(interrupted, ["audio:session_replaced", "motion:session_replaced"]);

  const snapshot = engine.getSnapshot();
  assert.ok(snapshot);
  assert.equal(
    snapshot?.sinks.find((sink) => sink.id === "audio")?.terminal,
    "interrupted",
  );
  assert.equal(
    snapshot?.sinks.find((sink) => sink.id === "curve")?.terminal,
    "absent",
  );
}

function testLateSinkEventsDoNotRewriteTerminalTimeline(): void {
  const engine = createPlaybackTimelineEngine({ now: () => 0 });
  engine.load(
    { turnId: "turn-4", messageId: "msg-4" },
    [
      { id: "audio", required: true },
      { id: "motion", required: true },
    ],
  );

  engine.markSinkStarted("audio");
  engine.markSinkStarted("motion");
  engine.start();
  engine.interrupt("session_replaced");

  engine.markSinkTerminal("audio", "completed");
  engine.markSinkStarted("motion");

  const snapshot = engine.getSnapshot();
  assert.equal(engine.getPhase(), "interrupted");
  assert.equal(
    snapshot?.sinks.find((sink) => sink.id === "audio")?.terminal,
    "interrupted",
  );
  assert.equal(
    snapshot?.sinks.find((sink) => sink.id === "motion")?.terminal,
    "interrupted",
  );
}

function testTerminalSinkEventsAreStable(): void {
  const engine = createPlaybackTimelineEngine({ now: () => 0 });
  engine.load(
    { turnId: "turn-5", messageId: "msg-5" },
    [
      { id: "audio", required: true },
      { id: "lip_sync", required: false },
    ],
  );

  engine.markSinkStarted("audio");
  engine.start();
  engine.markSinkTerminal("lip_sync", "failed", "lip_sync_unavailable");
  engine.markSinkTerminal("lip_sync", "completed", "audio_playback_completed");
  engine.markSinkStarted("lip_sync");

  const lipSyncSink = engine.getSnapshot()?.sinks.find((sink) => sink.id === "lip_sync");
  assert.equal(lipSyncSink?.terminal, "failed");
  assert.equal(lipSyncSink?.reason, "lip_sync_unavailable");
}

function run(): void {
  testSyntheticClockLifecycle();
  testAudioClockTakesPriorityAndExposesUnavailableState();
  testClockResetClearsPreviousAudioBindingAndDuration();
  testTimelineCompletesWhenRequiredSinksSettle();
  testTimelineFailsWhenRequiredSinkFails();
  testInterruptPropagatesToActiveSinks();
  testLateSinkEventsDoNotRewriteTerminalTimeline();
  testTerminalSinkEventsAreStable();
  console.log("playbackTimelineEngine tests passed");
}

run();
