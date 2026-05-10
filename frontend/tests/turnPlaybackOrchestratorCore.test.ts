import assert from "node:assert/strict";
import {
  AUDIO_MOTION_SYNC_WAIT_MS,
  TEXT_ONLY_RELEASE_WAIT_MS,
  createTurnPlaybackOrchestratorCore,
  type TurnPlaybackReleaseContext,
} from "../src/composables/turnPlaybackOrchestratorCore.js";

interface ScheduledTask {
  id: number;
  dueAtMs: number;
  fn: () => void;
  cleared: boolean;
}

function createHarness() {
  let nowMs = 0;
  let nextTimerId = 1;
  const tasks: ScheduledTask[] = [];
  const events: string[] = [];

  const core = createTurnPlaybackOrchestratorCore({
    now: () => nowMs,
    schedule: (delayMs: number, fn: () => void): number => {
      const task: ScheduledTask = {
        id: nextTimerId,
        dueAtMs: nowMs + delayMs,
        fn,
        cleared: false,
      };
      nextTimerId += 1;
      tasks.push(task);
      return task.id;
    },
    clearSchedule: (timer: unknown): void => {
      const task = tasks.find((candidate) => candidate.id === timer);
      if (task) {
        task.cleared = true;
      }
    },
    releaseText: (
      messageId: string,
      turnId: string | null,
      orchestrationId: string | null,
    ): boolean => {
      events.push(`text:${messageId}:${turnId ?? ""}:${orchestrationId ?? ""}`);
      return true;
    },
    releaseAudio: (
      messageId: string,
      turnId: string | null,
      orchestrationId: string | null,
    ): void => {
      events.push(`audio:${messageId}:${turnId ?? ""}:${orchestrationId ?? ""}`);
    },
    releaseMotion: (
      payload: unknown,
      context: TurnPlaybackReleaseContext,
    ): void => {
      events.push(
        `motion:${String(payload)}:${context.messageId}:${context.turnId ?? ""}:${context.orchestrationId ?? ""}`,
      );
    },
  });

  function advanceTo(nextNowMs: number): void {
    nowMs = nextNowMs;
    let ranTask = true;
    while (ranTask) {
      ranTask = false;
      for (const task of tasks) {
        if (!task.cleared && task.dueAtMs <= nowMs) {
          task.cleared = true;
          task.fn();
          ranTask = true;
        }
      }
    }
  }

  return {
    core,
    events,
    advanceTo,
    pendingTasks: () => tasks.filter((task) => !task.cleared),
  };
}

function testTextAudioMotionReadyReleaseTogether(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1", "orch-1");
  harness.core.markAudioReady("msg-1", "turn-1", "orch-1");
  harness.core.markMotionReady("msg-1", "turn-1", "orch-1", "motion-1", 42);

  assert.deepEqual(harness.events, [
    "text:msg-1:turn-1:orch-1",
    "motion:motion-1:msg-1:turn-1:orch-1",
    "audio:msg-1:turn-1:orch-1",
  ]);
}

function testAudioWaitsForLateMotionWithinWindow(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1", "orch-1");
  harness.core.markAudioReady("msg-1", "turn-1", "orch-1");

  assert.deepEqual(harness.events, []);
  assert.equal(harness.pendingTasks().length, 1);

  harness.advanceTo(AUDIO_MOTION_SYNC_WAIT_MS - 1);
  assert.deepEqual(harness.events, []);

  harness.core.markMotionReady("msg-1", "turn-1", "orch-1", "motion-1", 100);
  assert.deepEqual(harness.events, [
    "text:msg-1:turn-1:orch-1",
    "motion:motion-1:msg-1:turn-1:orch-1",
    "audio:msg-1:turn-1:orch-1",
  ]);
}

function testAudioMotionWaitTimeoutReleasesTextAndAudio(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1", "orch-1");
  harness.core.markAudioReady("msg-1", "turn-1", "orch-1");
  harness.advanceTo(AUDIO_MOTION_SYNC_WAIT_MS);

  assert.deepEqual(harness.events, [
    "text:msg-1:turn-1:orch-1",
    "audio:msg-1:turn-1:orch-1",
  ]);
}

function testLateMotionAfterReleaseIsForwarded(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1", "orch-1");
  harness.core.markAudioReady("msg-1", "turn-1", "orch-1");
  harness.advanceTo(AUDIO_MOTION_SYNC_WAIT_MS);
  harness.core.markMotionReady("msg-1", "turn-1", "orch-1", "motion-1", 900);

  assert.deepEqual(harness.events, [
    "text:msg-1:turn-1:orch-1",
    "audio:msg-1:turn-1:orch-1",
    "motion:motion-1:msg-1:turn-1:orch-1",
  ]);
}

function testTextOnlyReleasesAfterShortWait(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1", "orch-1");
  harness.advanceTo(TEXT_ONLY_RELEASE_WAIT_MS);

  assert.deepEqual(harness.events, ["text:msg-1:turn-1:orch-1"]);
}

function testNoAudioWithMotionReleasesTextAndMotion(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1", "orch-1");
  harness.core.markMotionReady("msg-1", "turn-1", "orch-1", "motion-1", 20);
  harness.core.markNoAudioConfirmed("msg-1", "turn-1", "orch-1");

  assert.deepEqual(harness.events, [
    "text:msg-1:turn-1:orch-1",
    "motion:motion-1:msg-1:turn-1:orch-1",
  ]);
}

function testDifferentOrchestrationGroupsDoNotCrossRelease(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1", "orch-1");
  harness.core.markAudioReady("msg-2", "turn-1", "orch-2");
  harness.core.markMotionReady("msg-2", "turn-1", "orch-2", "motion-2", 10);

  assert.deepEqual(harness.events, []);
}

function testMissingIdentifiersDoNotShareUnknownGroup(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-text", null, null);
  harness.core.markAudioReady("msg-audio", null, null);
  harness.core.markMotionReady("msg-motion", null, null, "motion-anonymous", 10);

  assert.deepEqual(harness.events, []);
  assert.equal(harness.pendingTasks().length, 1);

  harness.advanceTo(TEXT_ONLY_RELEASE_WAIT_MS);
  assert.deepEqual(harness.events, ["text:msg-text::"]);
}

function testClearSegmentRemovesReleasedGroup(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1", "orch-1");
  assert.equal(harness.core.getGroupCount(), 1);

  harness.core.clearSegment("msg-1");
  assert.equal(harness.core.getGroupCount(), 0);

  harness.advanceTo(TEXT_ONLY_RELEASE_WAIT_MS);
  assert.deepEqual(harness.events, []);
}

function run(): void {
  testTextAudioMotionReadyReleaseTogether();
  testAudioWaitsForLateMotionWithinWindow();
  testAudioMotionWaitTimeoutReleasesTextAndAudio();
  testLateMotionAfterReleaseIsForwarded();
  testTextOnlyReleasesAfterShortWait();
  testNoAudioWithMotionReleasesTextAndMotion();
  testDifferentOrchestrationGroupsDoNotCrossRelease();
  testMissingIdentifiersDoNotShareUnknownGroup();
  testClearSegmentRemovesReleasedGroup();
  console.log("turnPlaybackOrchestratorCore tests passed");
}

run();
