import assert from "node:assert/strict";
import {
  createPlaybackTimelineEngine,
} from "../src/playback-timeline/playbackTimelineEngine.js";

function createEngineWithRequiredSinks() {
  const engine = createPlaybackTimelineEngine();
  engine.load(
    { turnId: "turn-1", messageId: "message-1" },
    [
      { id: "audio", required: true },
      { id: "motion", required: true },
    ],
  );
  return engine;
}

function testCompletesAfterRequiredSinksComplete(): void {
  const engine = createEngineWithRequiredSinks();

  engine.markSinkStarted("audio");
  engine.markSinkStarted("motion");
  assert.equal(engine.getPhase(), "ready");

  engine.start(100);
  engine.markSinkTerminal("audio", "completed", "audio_completed");
  assert.equal(engine.getPhase(), "playing");
  engine.markSinkTerminal("motion", "completed", "motion_completed");
  assert.equal(engine.getPhase(), "completed");
}

function testRequiredSinkFailureFailsTimeline(): void {
  const engine = createEngineWithRequiredSinks();

  engine.markSinkTerminal("audio", "failed", "audio_failed");
  engine.markSinkTerminal("motion", "interrupted", "audio_failed");

  assert.equal(engine.getPhase(), "failed");
}

function testExecutionSinkDoesNotBlockTimelineStart(): void {
  const engine = createPlaybackTimelineEngine();
  engine.load(
    { turnId: "turn-1", messageId: "message-1" },
    [
      { id: "audio", required: true },
      { id: "motion", required: true, requiredForStart: false },
    ],
  );

  engine.markSinkStarted("audio");
  assert.equal(engine.getPhase(), "ready");

  engine.start(100);
  assert.equal(engine.getPhase(), "playing");
  assert.equal(
    engine.getSnapshot()?.sinks.find((sink) => sink.id === "motion")?.terminal,
    "idle",
  );

  engine.markSinkTerminal("audio", "completed", "audio_completed");
  assert.equal(engine.getPhase(), "playing");
  engine.markSinkTerminal("motion", "completed", "motion_completed");
  assert.equal(engine.getPhase(), "completed");
}

function testInterruptReachesActiveSinks(): void {
  const interrupted: string[] = [];
  const engine = createPlaybackTimelineEngine();
  engine.load(
    { turnId: "turn-1", messageId: "message-1" },
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
    ],
  );

  engine.interrupt("user_interrupt");

  assert.equal(engine.getPhase(), "interrupted");
  assert.deepEqual(interrupted, [
    "audio:user_interrupt",
    "motion:user_interrupt",
  ]);
}

testCompletesAfterRequiredSinksComplete();
testRequiredSinkFailureFailsTimeline();
testExecutionSinkDoesNotBlockTimelineStart();
testInterruptReachesActiveSinks();
console.log("playbackTimelineEngine smoke tests passed");
