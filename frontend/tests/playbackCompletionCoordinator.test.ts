// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { reactive, nextTick, ref } from "vue";
import { useTurnPlaybackSessionStore } from "../src/turn-playback/useTurnPlaybackSessionStore.js";
import { usePlaybackCompletionCoordinator } from "../src/turn-playback/usePlaybackCompletionCoordinator.js";

interface PlaybackFinishedCall {
  turnId: string | null;
  success: boolean;
  reason?: string;
}

function createHarness() {
  const sessionStore = useTurnPlaybackSessionStore();
  const playbackFinishedCalls: PlaybackFinishedCall[] = [];
  const clearContextCalls: Array<{ turnId: string | null }> = [];
  const audioStarted: Array<{ turnId: string | null; messageId: string }> = [];
  const scheduledTimers = new Map<number, () => void>();
  let nextTimerId = 1;

  const mockMotionPlayer = {
    state: reactive({ status: "idle" as string }),
  };

  const mockAdapter = {
    state: { lastAssistantText: "Hello from assistant" },
    sendPlaybackFinishedForCurrentGroup(
      turnId: string | null,
      success: boolean,
      reason?: string,
    ): Promise<void> {
      playbackFinishedCalls.push({ turnId, success, reason });
      return Promise.resolve();
    },
    clearPlaybackGroupContext(
      turnId: string | null,
    ): void {
      clearContextCalls.push({ turnId });
    },
  };

  const coordinator = usePlaybackCompletionCoordinator({
    sessionStore,
    playbackAck: {
      sendPlaybackFinishedForCurrentGroup:
        mockAdapter.sendPlaybackFinishedForCurrentGroup,
      clearPlaybackGroupContext: mockAdapter.clearPlaybackGroupContext,
    },
    motionRecord: {
      getLastAssistantText: () => mockAdapter.state.lastAssistantText,
      getSelectedModel: () => ref(null),
    },
    motionPlayer: mockMotionPlayer as never,
    onAudioPlaybackStarted: (turnId, messageId) => {
      audioStarted.push({ turnId, messageId });
    },
    schedule: (_delayMs, fn) => {
      const timerId = nextTimerId++;
      scheduledTimers.set(timerId, fn);
      return timerId;
    },
    clearSchedule: (timer) => {
      scheduledTimers.delete(timer as number);
    },
    initialMotionPlaybackRecords: [],
  });

  sessionStore.setActiveSession("turn-1");
  sessionStore.markTurnStarted("turn-1");
  sessionStore.markPhase("turn-1", "ready");
  sessionStore.markPhase("turn-1", "playing");

  return {
    sessionStore,
    coordinator,
    mockMotionPlayer,
    playbackFinishedCalls,
    clearContextCalls,
    audioStarted,
    scheduledTimers,
    runScheduledTimer: (timerId: number) => {
      const fn = scheduledTimers.get(timerId);
      assert.ok(fn, `timer ${timerId} should exist`);
      scheduledTimers.delete(timerId);
      fn();
    },
    flush: () => nextTick(),
  };
}

async function testSegmentCompletionDoesNotFinishTurnEarly(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markTextReceived("turn-1", "B", "msg-b");

  h.sessionStore.markTextDelivered("turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("turn-1", "absent", "msg-a", "no_audio");
  h.sessionStore.markMotionAbsent("turn-1", "msg-a");
  h.sessionStore.markSynthFinished("turn-1");
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 0);
  assert.equal(h.sessionStore.getActiveSession()?.phase, "playing");
}

async function testAllSegmentsAndSynthFinishedAckOnce(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markTextReceived("turn-1", "B", "msg-b");

  for (const messageId of ["msg-a", "msg-b"]) {
    h.sessionStore.markTextDelivered("turn-1", messageId);
    h.sessionStore.markAudioTerminal("turn-1", "absent", messageId, "no_audio");
    h.sessionStore.markMotionAbsent("turn-1", messageId);
  }
  await h.flush();
  assert.equal(h.playbackFinishedCalls.length, 0, "backend synth_finished is required");

  h.sessionStore.markSynthFinished("turn-1");
  await h.flush();
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 1);
  assert.deepEqual(h.playbackFinishedCalls[0], {
    turnId: "turn-1",
    success: true,
    reason: "text_delivered",
  });
  assert.equal(h.sessionStore.getActiveSession()?.phase, "settling");

  h.sessionStore.markSynthFinished("turn-1");
  await h.flush();
  assert.equal(h.playbackFinishedCalls.length, 1);

  h.sessionStore.markTurnFinished("turn-1", true);
  await h.flush();
  assert.equal(h.sessionStore.getActiveSession()?.phase, "completed");

  h.sessionStore.markSynthFinished("turn-1");
  await h.flush();
  assert.equal(h.playbackFinishedCalls.length, 1);
}

async function testTurnFinishedBeforeSynthFinishedDoesNotAck(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markTextDelivered("turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("turn-1", "absent", "msg-a", "no_audio");
  h.sessionStore.markMotionAbsent("turn-1", "msg-a");

  h.sessionStore.markTurnFinished("turn-1", true);
  await h.flush();
  assert.equal(h.playbackFinishedCalls.length, 0);
  assert.equal(h.sessionStore.getActiveSession()?.phase, "playing");

  h.sessionStore.markSynthFinished("turn-1");
  await h.flush();
  await h.flush();
  assert.equal(h.playbackFinishedCalls.length, 1);
  assert.equal(h.sessionStore.getActiveSession()?.phase, "completed");
}

async function testAudioStartedNotificationIsSegmentScoped(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markAudioReceived("turn-1", "http://localhost/a.wav", "msg-a");
  h.sessionStore.markAudioStarted("turn-1", "msg-a", 100, 1000);
  await h.flush();

  assert.deepEqual(h.audioStarted, [{ turnId: "turn-1", messageId: "msg-a" }]);
}

async function testMotionCompletionWritesCorrectSegment(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markTextReceived("turn-1", "B", "msg-b");
  h.sessionStore.markMotionReceived(
    "turn-1",
    { kind: "semantic_intent", intent: {} as never },
    "msg-b",
  );

  h.coordinator.recordMotionPlayback({
    messageId: "msg-b",
    turnId: "turn-1",
    playbackTurnId: "turn-1",
    model: null,
    payloadKind: "semantic_intent",
    startReason: "test",
    queuedDelayMs: 0,
    diagnostics: null,
    playerMessage: "playing",
    runId: "test-run-msg-b",
    plan: {
      schema_version: "semantic_parameter_plan.v1",
      parameters: [],
      mode: "idle",
      emotion_label: "",
      timing: { duration_ms: 1000 },
    } as never,
  });

  h.coordinator.completeMotionPlayback({ runId: "test-run-msg-b", status: "completed" });
  await h.flush();

  const session = h.sessionStore.getActiveSession();
  assert.equal(session?.segments.get("msg-a")?.motion.completed, false);
  assert.equal(session?.segments.get("msg-b")?.motion.completed, true);
}

async function testMotionHandoffCompletesPreviousSegmentAndFinishesCurrent(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markTextReceived("turn-1", "B", "msg-b");
  h.sessionStore.markMotionReceived(
    "turn-1",
    { kind: "semantic_intent", intent: {} as never },
    "msg-a",
  );
  h.sessionStore.markMotionReceived(
    "turn-1",
    { kind: "semantic_intent", intent: {} as never },
    "msg-b",
  );

  const baseEvent = {
    turnId: "turn-1",
    playbackTurnId: "turn-1",
    model: null,
    payloadKind: "semantic_intent" as const,
    startReason: "test",
    queuedDelayMs: 0,
    diagnostics: null,
    playerMessage: "playing",
    plan: {
      schema_version: "semantic_parameter_plan.v1",
      parameters: [],
      mode: "idle",
      emotion_label: "",
      timing: { duration_ms: 1000 },
    } as never,
  };

  h.coordinator.recordMotionPlayback({ ...baseEvent, messageId: "msg-a" });
  h.mockMotionPlayer.state.status = "playing";
  await h.flush();

  h.coordinator.recordMotionPlayback({ ...baseEvent, runId: "handoff-msg-b", messageId: "msg-b" });
  await h.flush();
  assert.equal(h.sessionStore.getActiveSession()?.segments.get("msg-a")?.motion.completed, true);
  assert.equal(h.sessionStore.getActiveSession()?.segments.get("msg-b")?.motion.completed, false);

  h.coordinator.completeMotionPlayback({ runId: "handoff-msg-b", status: "completed" });
  await h.flush();
  assert.equal(h.sessionStore.getActiveSession()?.segments.get("msg-b")?.motion.completed, true);
}

async function testCatalogMotionCompletionWritesSegmentAndHistory(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markMotionReceived(
    "turn-1",
    {
      kind: "catalog_motion",
      motion: {
        schema_version: "engine.catalog_motion.v1",
        model_id: "model-1",
        motion_id: "serious_explain",
        group: "TapBody",
        index: 0,
        file: "Motions/serious.motion3.json",
        label: "认真说明",
        emotion_label: "explain",
        duration_ms: 3000,
        priority: 3,
      },
    },
    "msg-a",
  );

  h.coordinator.recordMotionPlayback({
    messageId: "msg-a",
    turnId: "turn-1",
    playbackTurnId: "turn-1",
    model: null,
    payloadKind: "catalog_motion",
    startReason: "test",
    queuedDelayMs: 0,
    diagnostics: null,
    playerMessage: "playing",
    runId: "cat-run-1",
    motion: {
      schema_version: "engine.catalog_motion.v1",
      model_id: "model-1",
      motion_id: "serious_explain",
      group: "TapBody",
      index: 0,
      file: "Motions/serious.motion3.json",
      label: "认真说明",
      emotion_label: "explain",
      duration_ms: 3000,
      priority: 3,
    },
  });

  h.coordinator.completeMotionPlayback({ runId: "cat-run-1", status: "completed" });
  await h.flush();

  const segment = h.sessionStore.getActiveSession()?.segments.get("msg-a");
  assert.equal(segment?.motion.started, true);
  assert.equal(segment?.motion.completed, true);
  assert.equal(h.coordinator.motionPlaybackRecords.value[0]?.payloadKind, "catalog_motion");
  assert.equal(h.coordinator.motionPlaybackRecords.value[0]?.emotionLabel, "explain");
}

async function testPreviewMotionPlaybackDoesNotCreateSessionSegmentOrHistory(): Promise<void> {
  const h = createHarness();
  const beforeSessionCount = h.sessionStore.getSessions().length;
  const beforeRecordCount = h.coordinator.motionPlaybackRecords.value.length;

  h.coordinator.recordMotionPlayback({
    messageId: "preview",
    turnId: null,
    playbackTurnId: null,
    model: null,
    payloadKind: "semantic_plan",
    startReason: "preview",
    queuedDelayMs: 0,
    diagnostics: null,
    playerMessage: "preview playing",
    plan: {
      schema_version: "semantic_parameter_plan.v1",
      parameters: [],
      mode: "idle",
      emotion_label: "",
      timing: { duration_ms: 1000 },
    } as never,
  });

  await h.flush();

  assert.equal(h.sessionStore.getSessions().length, beforeSessionCount);
  assert.equal(
    h.sessionStore.getSessions().some((session) => session.segments.has("preview")),
    false,
  );
  assert.equal(h.coordinator.motionPlaybackRecords.value.length, beforeRecordCount);
}

async function testDuplicateMotionPlaybackRecordIsDeduped(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  const event = {
    messageId: "msg-a",
    turnId: "turn-1",
    playbackTurnId: "turn-1",
    model: null,
    payloadKind: "semantic_intent" as const,
    startReason: "test",
    queuedDelayMs: 0,
    diagnostics: null,
    playerMessage: "playing",
    plan: {
      schema_version: "semantic_parameter_plan.v1",
      parameters: [
        {
          axis_id: "head_yaw",
          parameter_id: "ParamAngleX",
          target_value: 12,
          weight: 1,
          input_value: 72,
          source: "semantic_axis",
        },
      ],
      mode: "expressive",
      emotion_label: "neutral",
      timing: { duration_ms: 1000 },
    } as never,
  };

  h.coordinator.recordMotionPlayback(event);
  h.coordinator.recordMotionPlayback(event);

  assert.equal(h.coordinator.motionPlaybackRecords.value.length, 1);
  assert.equal(h.coordinator.motionPlaybackRecords.value[0]?.messageId, "msg-a");
}

async function testMixedAudioStatesRequireAllSettled(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markTextReceived("turn-1", "B", "msg-b");

  // msg-a: has audio, completed
  h.sessionStore.markTextDelivered("turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("turn-1", "completed", "msg-a", "ok");
  h.sessionStore.markMotionAbsent("turn-1", "msg-a");

  // msg-b: no audio, still idle
  h.sessionStore.markTextDelivered("turn-1", "msg-b");
  h.sessionStore.markMotionAbsent("turn-1", "msg-b");

  h.sessionStore.markSynthFinished("turn-1");
  await h.flush();
  // msg-b audio still idle, should NOT ack
  assert.equal(h.playbackFinishedCalls.length, 0);

  h.sessionStore.markAudioTerminal("turn-1", "absent", "msg-b", "no_audio");
  await h.flush();
  await h.flush();
  assert.equal(h.playbackFinishedCalls.length, 1);
  assert.equal(h.sessionStore.getActiveSession()?.phase, "settling");
}

async function testSegmentWithAudioFailureStillSettles(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markTextDelivered("turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("turn-1", "failed", "msg-a", "playback_error");
  h.sessionStore.markMotionAbsent("turn-1", "msg-a");
  h.sessionStore.markSynthFinished("turn-1");
  await h.flush();
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 1);
  // audio failure sets success=false
  assert.equal(h.playbackFinishedCalls[0].success, false);
}

async function testSynthFinishedAfterTurnFinishedStillAcks(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markTextDelivered("turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("turn-1", "absent", "msg-a", "no_audio");
  h.sessionStore.markMotionAbsent("turn-1", "msg-a");

  // turn_finished before synth_finished (out-of-order delivery)
  h.sessionStore.markTurnFinished("turn-1", true);
  await h.flush();
  assert.equal(h.playbackFinishedCalls.length, 0);

  h.sessionStore.markSynthFinished("turn-1");
  await h.flush();
  await h.flush();
  assert.equal(h.playbackFinishedCalls.length, 1);
  // should go straight to completed since turn_finished already arrived
  assert.equal(h.sessionStore.getActiveSession()?.phase, "completed");
}

async function testCompletionCoordinatorIgnoresStaleSession(): Promise<void> {
  const h = createHarness();

  // Create and settle session A
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markTextDelivered("turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("turn-1", "absent", "msg-a", "no_audio");
  h.sessionStore.markMotionAbsent("turn-1", "msg-a");
  h.sessionStore.markSynthFinished("turn-1");
  await h.flush();
  await h.flush();
  assert.equal(h.playbackFinishedCalls.length, 1);

  h.sessionStore.markTurnFinished("turn-1", true);
  await h.flush();
  assert.equal(h.sessionStore.getActiveSession()?.phase, "completed");

  // Start new session B
  h.sessionStore.setActiveSession("turn-2");
  h.sessionStore.markTurnStarted("turn-2");
  h.sessionStore.markPhase("turn-2", "ready");
  h.sessionStore.markPhase("turn-2", "playing");
  h.sessionStore.markTextReceived("turn-2", "B", "msg-b");
  h.sessionStore.markTextDelivered("turn-2", "msg-b");
  h.sessionStore.markAudioTerminal("turn-2", "absent", "msg-b", "no_audio");
  h.sessionStore.markMotionAbsent("turn-2", "msg-b");
  h.sessionStore.markSynthFinished("turn-2");
  await h.flush();
  await h.flush();

  // Should ack session B, not re-ack session A
  assert.equal(h.playbackFinishedCalls.length, 2);
  assert.equal(h.playbackFinishedCalls[1].turnId, "turn-2");
}

async function testSettlementWindowUsesInjectedTimer(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markTextDelivered("turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("turn-1", "completed", "msg-a", "ok");
  h.sessionStore.markSynthFinished("turn-1");
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 0);
  assert.equal(h.scheduledTimers.size, 1);

  h.runScheduledTimer(1);
  await h.flush();

  assert.equal(h.sessionStore.getActiveSession()?.segments.get("msg-a")?.motion.absent, true);
  assert.equal(h.playbackFinishedCalls.length, 1);
  assert.equal(h.playbackFinishedCalls[0].reason, "audio_and_motion_settled");
  assert.equal(h.scheduledTimers.size, 0);
}

async function testMotionStartFailureMarkedFailedAllowsAck(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markTextDelivered("turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("turn-1", "completed", "msg-a", "ok");
  h.sessionStore.markMotionFailed("turn-1", "msg-a", "motion_start_failed");
  h.sessionStore.markSynthFinished("turn-1");
  await h.flush();
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 1);
  assert.deepEqual(h.playbackFinishedCalls[0], {
    turnId: "turn-1",
    success: true,
    reason: "text_delivered",
  });
}

async function testLateAudioAfterNoAudioAckReopensSettlingSession(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markTextDelivered("turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("turn-1", "absent", "msg-a", "no_audio");
  h.sessionStore.markMotionAbsent("turn-1", "msg-a");
  h.sessionStore.markSynthFinished("turn-1");
  await h.flush();
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 1);
  assert.equal(h.sessionStore.getActiveSession()?.phase, "settling");

  assert.equal(h.sessionStore.markAudioReceived("turn-1", "http://localhost/late.wav", "msg-a"), true);
  await h.flush();

  assert.equal(h.sessionStore.getActiveSession()?.phase, "playing");
  assert.equal(h.playbackFinishedCalls.length, 1);

  h.sessionStore.markAudioReleased("turn-1", "msg-a");
  h.sessionStore.markAudioStarted("turn-1", "msg-a", 100, 1000);
  h.sessionStore.markAudioTerminal("turn-1", "completed", "msg-a", "audio_playback_completed");
  await h.flush();
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 2);
  assert.deepEqual(h.playbackFinishedCalls[1], {
    turnId: "turn-1",
    success: true,
    reason: "text_delivered",
  });
  assert.equal(h.sessionStore.getActiveSession()?.phase, "settling");
}

async function run(): Promise<void> {
  await testSegmentCompletionDoesNotFinishTurnEarly();
  await testAllSegmentsAndSynthFinishedAckOnce();
  await testTurnFinishedBeforeSynthFinishedDoesNotAck();
  await testAudioStartedNotificationIsSegmentScoped();
  await testMotionCompletionWritesCorrectSegment();
  await testMotionHandoffCompletesPreviousSegmentAndFinishesCurrent();
  await testCatalogMotionCompletionWritesSegmentAndHistory();
  await testPreviewMotionPlaybackDoesNotCreateSessionSegmentOrHistory();
  await testDuplicateMotionPlaybackRecordIsDeduped();
  await testMixedAudioStatesRequireAllSettled();
  await testSegmentWithAudioFailureStillSettles();
  await testSynthFinishedAfterTurnFinishedStillAcks();
  await testCompletionCoordinatorIgnoresStaleSession();
  await testSettlementWindowUsesInjectedTimer();
  await testMotionStartFailureMarkedFailedAllowsAck();
  await testLateAudioAfterNoAudioAckReopensSettlingSession();
  console.log("playbackCompletionCoordinator tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
