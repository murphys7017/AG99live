import assert from "node:assert/strict";
import {
  AUDIO_MOTION_SYNC_WAIT_MS,
  TEXT_ONLY_RELEASE_WAIT_MS,
  createTurnPlaybackOrchestratorCore,
  resolveTurnPlaybackGroupKey,
} from "../src/turn-playback/turnPlaybackOrchestratorCore.js";

function testGroupIdentityDoesNotCollideOnDelimiterText(): void {
  assert.notEqual(
    resolveTurnPlaybackGroupKey("a", "b:c"),
    resolveTurnPlaybackGroupKey("a:b", "c"),
  );
}

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
    releaseSegment: (job) => {
      if (job.text.release) {
        events.push(`text:${job.messageId}:${job.turnId ?? ""}`);
      }
      if (job.audio.release) {
        events.push(`audio:${job.messageId}:${job.turnId ?? ""}`);
      }
      if (job.motion.payload !== null) {
        events.push(
          `motion:${String(job.motion.payload)}:${job.messageId}:${job.turnId ?? ""}`,
        );
      }
      return {
        releasedText: job.text.release,
        releasedAudio: job.audio.release,
        releasedMotion: job.motion.payload !== null,
      };
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

  harness.core.markTextReady("msg-1", "turn-1");
  harness.core.markAudioReady("msg-1", "turn-1");
  harness.core.markMotionReady("msg-1", "turn-1", "motion-1", 42);

  assert.deepEqual(harness.events, [
    "text:msg-1:turn-1",
    "audio:msg-1:turn-1",
    "motion:motion-1:msg-1:turn-1",
  ]);
}

function testAudioWaitsForLateMotionWithinWindow(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1");
  harness.core.markAudioReady("msg-1", "turn-1");

  assert.deepEqual(harness.events, []);
  assert.equal(harness.pendingTasks().length, 1);

  harness.advanceTo(AUDIO_MOTION_SYNC_WAIT_MS - 1);
  assert.deepEqual(harness.events, []);

  harness.core.markMotionReady("msg-1", "turn-1", "motion-1", 100);
  assert.deepEqual(harness.events, [
    "text:msg-1:turn-1",
    "audio:msg-1:turn-1",
    "motion:motion-1:msg-1:turn-1",
  ]);
}

function testAudioMotionWaitTimeoutReleasesTextAndAudio(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1");
  harness.core.markAudioReady("msg-1", "turn-1");
  harness.advanceTo(AUDIO_MOTION_SYNC_WAIT_MS);

  assert.deepEqual(harness.events, [
    "text:msg-1:turn-1",
    "audio:msg-1:turn-1",
  ]);
}

function testLateMotionAfterReleaseIsForwarded(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1");
  harness.core.markAudioReady("msg-1", "turn-1");
  harness.advanceTo(AUDIO_MOTION_SYNC_WAIT_MS);
  harness.core.markMotionReady("msg-1", "turn-1", "motion-1", 900);

  assert.deepEqual(harness.events, [
    "text:msg-1:turn-1",
    "audio:msg-1:turn-1",
    "motion:motion-1:msg-1:turn-1",
  ]);
}

function testLateTextAfterAudioFailureIsStillReleased(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1", true);
  harness.core.markAudioReady("msg-1", "turn-1");
  harness.core.markMotionReady("msg-1", "turn-1", "motion-1", 900);
  harness.core.markAudioFailed("msg-1", "turn-1", "audio_playback_failed");
  harness.core.markTextReady("msg-1", "turn-1", false);

  assert.deepEqual(harness.events, [
    "audio:msg-1:turn-1",
    "motion:motion-1:msg-1:turn-1",
    "text:msg-1:turn-1",
  ]);
}

function testAudioReleaseFailureKeepsGroupRetryable(): void {
  let nowMs = 0;
  const events: string[] = [];
  const core = createTurnPlaybackOrchestratorCore({
    now: () => nowMs,
    schedule: () => 1,
    clearSchedule: () => {},
    releaseSegment: (job) => {
      if (job.text.release) {
        events.push(`text:${job.messageId}`);
      }
      if (job.audio.release) {
        events.push(`audio:${job.messageId}`);
      }
      if (job.motion.payload !== null) {
        events.push(`motion:${String(job.motion.payload)}:${job.messageId}`);
      }
      return {
        releasedText: job.text.release,
        releasedAudio: false,
        releasedMotion: false,
      };
    },
  });

  core.markTextReady("msg-1", "turn-1");
  core.markAudioReady("msg-1", "turn-1");
  core.markMotionReady("msg-1", "turn-1", "motion-1", 42);
  nowMs = AUDIO_MOTION_SYNC_WAIT_MS;
  core.flush();
  core.flush();

  assert.deepEqual(events, [
    "text:msg-1",
    "audio:msg-1",
    "motion:motion-1:msg-1",
    "audio:msg-1",
    "motion:motion-1:msg-1",
    "audio:msg-1",
    "motion:motion-1:msg-1",
  ]);
}

function testTextOnlyReleasesAfterShortWait(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1");
  harness.advanceTo(TEXT_ONLY_RELEASE_WAIT_MS);

  assert.deepEqual(harness.events, ["text:msg-1:turn-1"]);
}

function testLateAudioAfterTextReleaseDoesNotReleaseTextAgain(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1");
  harness.advanceTo(TEXT_ONLY_RELEASE_WAIT_MS);
  harness.core.markTextReady("msg-1", "turn-1", true);
  harness.core.markAudioReady("msg-1", "turn-1");
  harness.advanceTo(TEXT_ONLY_RELEASE_WAIT_MS + AUDIO_MOTION_SYNC_WAIT_MS);

  assert.deepEqual(harness.events, [
    "text:msg-1:turn-1",
    "audio:msg-1:turn-1",
  ]);
}

function testNoAudioWithMotionReleasesTextAndMotion(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1");
  harness.core.markMotionReady("msg-1", "turn-1", "motion-1", 20);
  harness.core.markNoAudioConfirmed("msg-1", "turn-1");

  assert.deepEqual(harness.events, [
    "text:msg-1:turn-1",
    "motion:motion-1:msg-1:turn-1",
  ]);
}

function testDifferentMessageGroupsDoNotCrossRelease(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1");
  harness.core.markAudioReady("msg-2", "turn-1");
  harness.core.markMotionReady("msg-2", "turn-1", "motion-2", 10);

  assert.deepEqual(harness.events, []);
}

function testSameMessageIdDifferentTurnsDoNotShareGroup(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-a");
  harness.core.markAudioReady("msg-1", "turn-b");
  harness.core.markMotionReady("msg-1", "turn-b", "motion-b", 10);

  assert.deepEqual(harness.events, []);

  harness.core.markTextReady("msg-1", "turn-b");

  assert.deepEqual(harness.events, [
    "text:msg-1:turn-b",
    "audio:msg-1:turn-b",
    "motion:motion-b:msg-1:turn-b",
  ]);
}

function testMissingTurnIdIsRejected(): void {
  const harness = createHarness();

  assert.throws(
    () => harness.core.markTextReady("msg-text", null),
    /non-empty turnId/,
  );
}

function testClearSegmentRemovesReleasedGroup(): void {
  const harness = createHarness();

  harness.core.markTextReady("msg-1", "turn-1");
  assert.equal(harness.core.getGroupCount(), 1);

  harness.core.clearSegment("turn-1", "msg-1");
  assert.equal(harness.core.getGroupCount(), 0);

  harness.advanceTo(TEXT_ONLY_RELEASE_WAIT_MS);
  assert.deepEqual(harness.events, []);
}

function run(): void {
  testGroupIdentityDoesNotCollideOnDelimiterText();
  testTextAudioMotionReadyReleaseTogether();
  testAudioWaitsForLateMotionWithinWindow();
  testAudioMotionWaitTimeoutReleasesTextAndAudio();
  testLateMotionAfterReleaseIsForwarded();
  testLateTextAfterAudioFailureIsStillReleased();
  testAudioReleaseFailureKeepsGroupRetryable();
  testTextOnlyReleasesAfterShortWait();
  testLateAudioAfterTextReleaseDoesNotReleaseTextAgain();
  testNoAudioWithMotionReleasesTextAndMotion();
  testDifferentMessageGroupsDoNotCrossRelease();
  testSameMessageIdDifferentTurnsDoNotShareGroup();
testMissingTurnIdIsRejected();
  testClearSegmentRemovesReleasedGroup();
  console.log("turnPlaybackOrchestratorCore tests passed");
}

run();
