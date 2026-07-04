import assert from "node:assert/strict";
import {
  createPlaybackTimelineEngine,
} from "../src/playback-timeline/playbackTimelineEngine.js";
import { resolvePerformanceCurveTimeline } from "../src/playback-timeline/performanceCurveSink.js";
import { createPlaybackTimelineRuntime } from "../src/playback-timeline/playbackTimelineRuntime.js";
import { createTimelineClock } from "../src/playback-timeline/timelineClock.js";
import { createAudioStartMotionTimelineBridge } from "../src/playback-timeline/audioStartMotionBridge.js";
import type {
  AudioPlaybackClock,
  PlaybackTimelineSnapshot,
} from "../src/playback-timeline/contracts.js";

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

function testPerformanceCurveTimelineUsesRemainingAudioDuration(): void {
  const resolution = resolvePerformanceCurveTimeline({
    hint: {
      schema_version: "ag99.performance_curve_hint.v1",
      curve_family: "quick_in_hold_soft_out",
      entry: "quick",
      hold: "steady",
      exit: "soft",
      emphasis: "early",
      energy: "medium",
    },
    minRemainingDurationMs: 180,
    timeline: {
      timelineId: "timeline-curve",
      turnId: "turn-curve",
      messageId: "msg-curve",
      phase: "playing",
      clockSource: "audio",
      startedAtMs: 100,
      currentTimeMs: 450,
      durationMs: 2000,
      playbackRate: 1,
      sinks: [],
    },
  });

  assert.equal(resolution.ok, true);
  if (!resolution.ok) {
    throw new Error("expected performance curve timeline resolution");
  }
  assert.equal(resolution.clockSource, "audio");
  assert.equal(resolution.targetDurationMs, 1550);
  assert.equal(resolution.speechActive, true);
}

function testPerformanceCurveTimelineRejectsUnavailableAudio(): void {
  const resolution = resolvePerformanceCurveTimeline({
    hint: {
      schema_version: "ag99.performance_curve_hint.v1",
      curve_family: "quick_in_hold_soft_out",
      entry: "quick",
      hold: "steady",
      exit: "soft",
      emphasis: "early",
      energy: "medium",
    },
    minRemainingDurationMs: 180,
    timeline: {
      timelineId: "timeline-curve",
      turnId: "turn-curve",
      messageId: "msg-curve",
      phase: "playing",
      clockSource: "audio_unavailable",
      startedAtMs: 100,
      currentTimeMs: 450,
      durationMs: 2000,
      playbackRate: 1,
      sinks: [],
    },
  });

  assert.equal(resolution.ok, false);
  if (resolution.ok) {
    throw new Error("expected unavailable audio to be rejected");
  }
  assert.equal(resolution.reason, "playback_timeline_audio_unavailable");
}

function testPlaybackTimelineRuntimeCreatesMotionOnlyTimeline(): void {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
  });

  let snapshot = runtime.prepareMotionOnlyTimeline("turn-motion", "msg-motion");
  assert.equal(snapshot?.phase, "preparing");
  assert.equal(snapshot?.clockSource, "synthetic");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "motion")?.terminal, "idle");

  runtime.markMotionTimelineStarted("turn-motion", "msg-motion");
  snapshot = runtime.getActiveTimelineSnapshot();
  assert.equal(snapshot?.phase, "playing");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "motion")?.terminal, "started");

  runtime.markMotionTimelineTerminal(
    "turn-motion",
    "msg-motion",
    "completed",
    "motion_completed",
  );
  assert.equal(runtime.getActiveTimelineSnapshot(), null);
}

function testPlaybackTimelineRuntimeDoesNotStealMismatchedActiveTimeline(): void {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
  });

  runtime.prepareAudioTimeline("turn-audio", "msg-audio");
  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-motion", "msg-motion"),
    null,
  );
  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-audio", "msg-audio")?.messageId,
    "msg-audio",
  );

  assert.equal(
    runtime.prepareMotionOnlyTimeline("turn-motion", "msg-motion"),
    null,
  );
  assert.equal(
    runtime.prepareMotionTimelineSink("turn-motion", "msg-motion"),
    false,
  );
  const snapshot = runtime.getActiveTimelineSnapshot();
  assert.equal(snapshot?.turnId, "turn-audio");
  assert.equal(snapshot?.messageId, "msg-audio");
  assert.equal(snapshot?.sinks.some((sink) => sink.id === "motion"), false);
}

function testPlaybackTimelineRuntimeExposesMissingAudioClock(): void {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
  });

  runtime.prepareAudioTimeline("turn-audio", "msg-audio");
  runtime.markAudioTimelineStarted("turn-audio", "msg-audio", 100, 1200);

  const snapshot = runtime.getTimelineSnapshotForSegment("turn-audio", "msg-audio");
  assert.equal(snapshot?.phase, "playing");
  assert.equal(snapshot?.clockSource, "audio_unavailable");
  assert.equal(snapshot?.durationMs, 1200);
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

function buildTimelineSnapshot(
  currentTimeMs: number,
): PlaybackTimelineSnapshot {
  return {
    timelineId: `timeline-${currentTimeMs}`,
    turnId: "turn-audio",
    messageId: "msg-audio",
    phase: "playing",
    clockSource: "audio",
    startedAtMs: 10,
    currentTimeMs,
    durationMs: 1200,
    playbackRate: 1,
    sinks: [],
  };
}

function testAudioStartMotionBridgeRefreshesTimelineAtFireTime(): void {
  const scheduled: Array<() => void> = [];
  let snapshot = buildTimelineSnapshot(100);
  const started: PlaybackTimelineSnapshot[] = [];
  const bridge = createAudioStartMotionTimelineBridge({
    delayMs: 90,
    schedule: (_delayMs, fn) => {
      scheduled.push(fn);
      return "timer-1";
    },
    clearSchedule: () => {},
    getPlaybackTimelineSnapshotForSegment: () => snapshot,
    startMotionForAudioTimeline: (_turnId, _messageId, playbackTimeline) => {
      if (playbackTimeline) {
        started.push(playbackTimeline);
      }
    },
  });

  bridge.handleAudioTimelineStarted("turn-audio", "msg-audio");
  snapshot = buildTimelineSnapshot(220);
  scheduled[0]?.();

  assert.equal(started.length, 1);
  assert.equal(started[0].currentTimeMs, 220);
}

function testAudioStartMotionBridgeCanCancelPendingWakeup(): void {
  const cleared: unknown[] = [];
  const scheduled: Array<() => void> = [];
  let started = false;
  const bridge = createAudioStartMotionTimelineBridge({
    schedule: (_delayMs, fn) => {
      scheduled.push(fn);
      return "timer-clear";
    },
    clearSchedule: (timer) => {
      cleared.push(timer);
    },
    getPlaybackTimelineSnapshotForSegment: () => buildTimelineSnapshot(0),
    startMotionForAudioTimeline: () => {
      started = true;
    },
  });

  bridge.handleAudioTimelineStarted("turn-audio", "msg-audio");
  bridge.clear();
  scheduled[0]?.();

  assert.deepEqual(cleared, ["timer-clear"]);
  assert.equal(started, false);
}

function testAudioStartMotionBridgeSkipsStaleSegment(): void {
  const scheduled: Array<() => void> = [];
  let started = false;
  const bridge = createAudioStartMotionTimelineBridge({
    schedule: (_delayMs, fn) => {
      scheduled.push(fn);
      return "timer-stale";
    },
    clearSchedule: () => {},
    canStartMotionForAudioTimeline: () => false,
    getPlaybackTimelineSnapshotForSegment: () => buildTimelineSnapshot(0),
    startMotionForAudioTimeline: () => {
      started = true;
    },
  });

  bridge.handleAudioTimelineStarted("turn-audio", "msg-audio");
  scheduled[0]?.();

  assert.equal(started, false);
}

function run(): void {
  testSyntheticClockLifecycle();
  testAudioClockTakesPriorityAndExposesUnavailableState();
  testClockResetClearsPreviousAudioBindingAndDuration();
  testTimelineCompletesWhenRequiredSinksSettle();
  testTimelineFailsWhenRequiredSinkFails();
  testInterruptPropagatesToActiveSinks();
  testLateSinkEventsDoNotRewriteTerminalTimeline();
  testPerformanceCurveTimelineUsesRemainingAudioDuration();
  testPerformanceCurveTimelineRejectsUnavailableAudio();
  testPlaybackTimelineRuntimeCreatesMotionOnlyTimeline();
  testPlaybackTimelineRuntimeDoesNotStealMismatchedActiveTimeline();
  testPlaybackTimelineRuntimeExposesMissingAudioClock();
  testTerminalSinkEventsAreStable();
  testAudioStartMotionBridgeRefreshesTimelineAtFireTime();
  testAudioStartMotionBridgeCanCancelPendingWakeup();
  testAudioStartMotionBridgeSkipsStaleSegment();
  console.log("playbackTimelineEngine tests passed");
}

run();
