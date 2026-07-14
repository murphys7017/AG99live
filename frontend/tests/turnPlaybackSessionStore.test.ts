import assert from "node:assert/strict";
import {
  createTurnPlaybackSession,
  isSegmentLocallySettled,
} from "../src/turn-playback/session.js";
import {
  canReleaseAudio,
  canReleaseMotion,
  canReleaseText,
  isPlaybackLocallySettled,
} from "../src/turn-playback/selectors.js";
import { useTurnPlaybackSessionStore } from "../src/turn-playback/useTurnPlaybackSessionStore.js";
import type { NormalizedMotionPayload } from "../src/model-engine/contracts.js";
import type { PerformanceCurveHint } from "../src/types/protocol.js";

const motionPayload: NormalizedMotionPayload = {
  kind: "semantic_intent",
  intent: {} as never,
};

const catalogMotionPayload: NormalizedMotionPayload = {
  kind: "catalog_motion",
  motion: {
    schema_version: "engine.catalog_motion.v1",
    model_id: "model-1",
    motion_id: "happy_smile",
    group: "TapBody",
    index: 0,
    file: "Motions/微笑.motion3.json",
    label: "微笑",
    emotion_label: "happy",
    duration_ms: 3000,
    priority: 3,
  },
};

const curveHint: PerformanceCurveHint = {
  schema_version: "ag99.performance_curve_hint.v1",
  curve_family: "quick_in_hold_soft_out",
  entry: "quick",
  hold: "steady",
  exit: "soft",
  emphasis: "early",
  energy: "medium",
};

function getOnlySession(store: ReturnType<typeof useTurnPlaybackSessionStore>) {
  const session = store.getSessions()[0];
  assert.ok(session);
  return session;
}

function getSegment(
  store: ReturnType<typeof useTurnPlaybackSessionStore>,
  messageId: string,
) {
  const session = getOnlySession(store);
  const segment = session.segments.get(messageId);
  assert.ok(segment);
  return segment;
}

function commitSegment(
  store: ReturnType<typeof useTurnPlaybackSessionStore>,
  turnId: string,
  messageId: string,
  material: Parameters<typeof store.commitOutputSegment>[2],
): void {
  if (!store.getSession(turnId)) {
    store.markTurnStarted(turnId);
  }
  store.commitOutputSegment(turnId, messageId, material);
}

function testSessionStartsWithoutTurnLevelPlaybackSlots(): void {
  const session = createTurnPlaybackSession("turn-1");
  assert.equal(session.id, "turn:turn-1");
  assert.equal(session.turnId, "turn-1");
  assert.equal(session.segments.size, 0);
  assert.deepEqual(session.segmentOrder, []);
  assert.equal(session.backend.synthFinished, false);
  assert.equal("text" in session, false);
  assert.equal("audio" in session, false);
  assert.equal("motion" in session, false);
  assert.equal("currentSegmentId" in session, false);
}

function testSameMessageIdGroupsTextAudioMotion(): void {
  const store = useTurnPlaybackSessionStore();
  commitSegment(store, "turn-1", "msg-1", {
    text: { state: "present", content: "Hello" },
    audio: { state: "present", url: "http://localhost/a.wav" },
    motion: { state: "present", payload: motionPayload },
  });

  const session = getOnlySession(store);
  assert.equal(session.segments.size, 1);
  assert.deepEqual(session.segmentOrder, ["msg-1"]);

  const segment = getSegment(store, "msg-1");
  assert.equal(segment.text.content, "Hello");
  assert.equal(segment.audio.url, "http://localhost/a.wav");
  assert.deepEqual(segment.motion.payload, motionPayload);
}

function testAtomicOutputSegmentCommitsOnce(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTurnStarted("turn-atomic");
  store.commitOutputSegment("turn-atomic", "msg-atomic", {
    text: { state: "present", content: "Atomic reply" },
    audio: {
      state: "present",
      url: "http://localhost/atomic.wav",
    },
    motion: { state: "present", payload: motionPayload },
  });

  const segment = store.getSession("turn-atomic")?.segments.get("msg-atomic");
  assert.equal(segment?.text.content, "Atomic reply");
  assert.equal(segment?.audio.url, "http://localhost/atomic.wav");
  assert.deepEqual(segment?.motion.payload, motionPayload);
  assert.equal(store.getSession("turn-atomic")?.phase, "ready");

  assert.throws(
    () => store.commitOutputSegment("turn-atomic", "msg-atomic", {
      text: { state: "present", content: "Replacement" },
      audio: { state: "absent" },
      motion: { state: "absent" },
    }),
    /Duplicate output segment/,
  );
  assert.equal(segment?.text.content, "Atomic reply");
  assert.equal(store.getSession("turn-atomic")?.segmentOrder.length, 1);
}

function testAtomicOutputSegmentRejectsClosedQueueWithoutCreatingSegment(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTurnStarted("turn-closed");
  store.markSynthFinished("turn-closed");

  assert.throws(
    () => store.commitOutputSegment("turn-closed", "msg-late", {
      text: { state: "present", content: "Late reply" },
      audio: { state: "absent" },
      motion: { state: "absent" },
    }),
    /after synth_finished/,
  );
  assert.equal(store.getSession("turn-closed")?.segments.size, 0);
}

function testCatalogMotionPayloadCanBeStored(): void {
  const store = useTurnPlaybackSessionStore();
  commitSegment(store, "turn-1", "msg-1", {
    text: { state: "absent" },
    audio: { state: "absent" },
    motion: { state: "present", payload: catalogMotionPayload },
  });

  const segment = getSegment(store, "msg-1");
  assert.equal(segment.motion.payload?.kind, "catalog_motion");
}

function testPerformanceCurveHintStaysAttachedToMotionPayload(): void {
  const store = useTurnPlaybackSessionStore();
  if (motionPayload.kind !== "semantic_intent") {
    throw new Error("expected semantic_intent fixture");
  }
  commitSegment(store, "turn-1", "msg-1", {
    text: { state: "absent" },
    audio: { state: "absent" },
    motion: {
      state: "present",
      payload: {
        kind: "semantic_intent",
        intent: {
          ...motionPayload.intent,
          performance_curve_hint: curveHint,
        },
      },
    },
  });

  const segment = getSegment(store, "msg-1");
  assert.equal(segment.motion.payload?.kind, "semantic_intent");
  if (segment.motion.payload?.kind !== "semantic_intent") {
    throw new Error("expected semantic_intent payload");
  }
  assert.deepEqual(segment.motion.payload.intent.performance_curve_hint, curveHint);

  store.markMotionAbsent("turn-1", "msg-1");
  assert.equal(segment.motion.payload, null);
  assert.equal(segment.motion.absent, true);
  assert.equal(segment.motion.completed, false);
}

function testMultipleMessageIdsKeepArrivalOrder(): void {
  const store = useTurnPlaybackSessionStore();
  commitSegment(store, "turn-1", "msg-1", {
    text: { state: "present", content: "First" },
    audio: { state: "absent" },
    motion: { state: "absent" },
  });
  commitSegment(store, "turn-1", "msg-2", {
    text: { state: "present", content: "Second" },
    audio: { state: "present", url: "http://localhost/second.wav" },
    motion: { state: "absent" },
  });

  const session = getOnlySession(store);
  assert.deepEqual(session.segmentOrder, ["msg-1", "msg-2"]);
  assert.equal(session.segments.get("msg-1")?.text.content, "First");
  assert.equal(session.segments.get("msg-2")?.audio.url, "http://localhost/second.wav");
}

function testSelectorsOperateOnSegments(): void {
  const store = useTurnPlaybackSessionStore();
  commitSegment(store, "turn-1", "msg-1", {
    text: { state: "present", content: "Hello" },
    audio: { state: "present", url: "http://localhost/a.wav" },
    motion: { state: "present", payload: motionPayload },
  });

  const segment = getSegment(store, "msg-1");
  assert.equal(canReleaseText(segment), true);
  assert.equal(canReleaseAudio(segment), true);
  assert.equal(canReleaseMotion(segment), true);

  store.markTextReleased("turn-1", "msg-1");
  store.markAudioReleased("turn-1", "msg-1");
  store.markMotionReleased("turn-1", "msg-1");
  assert.equal(canReleaseText(segment), false);
  assert.equal(canReleaseAudio(segment), false);
  assert.equal(canReleaseMotion(segment), false);
}

function testSegmentSettlementAndTurnSettlement(): void {
  const store = useTurnPlaybackSessionStore();
  commitSegment(store, "turn-1", "msg-1", {
    text: { state: "present", content: "First" },
    audio: { state: "absent" },
    motion: { state: "absent" },
  });
  commitSegment(store, "turn-1", "msg-2", {
    text: { state: "present", content: "Second" },
    audio: { state: "absent" },
    motion: { state: "absent" },
  });

  const session = getOnlySession(store);
  assert.equal(isPlaybackLocallySettled(session), false);

  store.markTextDelivered("turn-1", "msg-1");
  assert.equal(store.isSegmentSettled(session.id, "msg-1"), true);
  assert.equal(isSegmentLocallySettled(session.segments.get("msg-1")!), true);
  assert.equal(isPlaybackLocallySettled(session), false);

  store.markTextDelivered("turn-1", "msg-2");
  assert.equal(isPlaybackLocallySettled(session), true);
}

function testBackendCompletionSignalsAreSeparate(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTurnStarted("turn-1");
  let session = getOnlySession(store);
  assert.equal(session.backend.turnStarted, true);
  assert.equal(session.backend.synthFinished, false);
  assert.equal(session.backend.turnFinished, false);

  store.markSynthFinished("turn-1");
  session = getOnlySession(store);
  assert.equal(session.backend.synthFinished, true);
  assert.equal(session.backend.turnFinished, false);

  store.markTurnFinished("turn-1", true);
  assert.equal(session.backend.turnFinished, true);
  assert.equal(session.backend.success, true);
}

function testSynthFinishedRequiresExistingSession(): void {
  const store = useTurnPlaybackSessionStore();
  assert.throws(
    () => store.markSynthFinished("turn-missing"),
    /does not exist/,
  );
}

function testTurnFinishedRequiresExistingSession(): void {
  const store = useTurnPlaybackSessionStore();
  assert.throws(
    () => store.markTurnFinished("turn-missing", true),
    /does not exist/,
  );
}

function testRequiredMessageIdIsEnforced(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTurnStarted("turn-1");
  assert.throws(
    () => store.commitOutputSegment("turn-1", "   ", {
      text: { state: "present", content: "Hello" },
      audio: { state: "absent" },
      motion: { state: "absent" },
    }),
    /messageId/,
  );
}

function testTurnOnlySessionRemainsTurnScoped(): void {
  const store = useTurnPlaybackSessionStore();
  store.setActiveSession("turn-1");
  commitSegment(store, "turn-1", "msg-1", {
    text: { state: "present", content: "Early" },
    audio: { state: "present", url: "http://localhost/audio.wav" },
    motion: { state: "absent" },
  });

  const session = store.getSession("turn-1");
  assert.ok(session);
  assert.equal(session.id, "turn:turn-1");
  assert.equal(store.state.activeSessionId, "turn:turn-1");
  assert.equal(session.segments.get("msg-1")?.text.content, "Early");
  assert.equal(
    session.segments.get("msg-1")?.audio.url,
    "http://localhost/audio.wav",
  );
}

function testGetUnsettledSegmentsReturnsOnlyUnsettledSegments(): void {
  const store = useTurnPlaybackSessionStore();
  commitSegment(store, "turn-1", "msg-1", {
    text: { state: "present", content: "First" },
    audio: { state: "absent" },
    motion: { state: "absent" },
  });
  commitSegment(store, "turn-1", "msg-2", {
    text: { state: "present", content: "Second" },
    audio: { state: "absent" },
    motion: { state: "absent" },
  });
  store.markTextDelivered("turn-1", "msg-1");

  assert.deepEqual(
    store.getUnsettledSegments().map((segment) => segment.messageId),
    ["msg-2"],
  );
}

function testIllegalPhaseTransitionIsRejected(): void {
  const store = useTurnPlaybackSessionStore();
  store.setActiveSession("turn-1");
  store.markTurnStarted("turn-1");
  // transition through valid phases to completed
  store.markPhase("turn-1", "ready");
  store.markPhase("turn-1", "playing");
  store.markPhase("turn-1", "settling");
  store.markPhase("turn-1", "completed");
  assert.equal(store.getActiveSession()?.phase, "completed");
  // completed -> playing is illegal
  assert.throws(
    () => store.markPhase("turn-1", "playing"),
    /illegal phase transition/,
  );
  assert.equal(store.getActiveSession()?.phase, "completed");
}

function testReadySessionCanSettleWithoutPlaybackSinks(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTurnStarted("turn-no-sinks");
  store.commitOutputSegment("turn-no-sinks", "msg-no-sinks", {
    text: { state: "absent" },
    audio: { state: "absent" },
    motion: { state: "absent" },
  });
  assert.equal(store.getSession("turn-no-sinks")?.phase, "ready");
  assert.equal(store.markPhase("turn-no-sinks", "settling"), true);
}

function testSynthFinishedRejectsTurnWithoutAtomicSegment(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTurnStarted("turn-empty");

  assert.throws(
    () => store.assertOutputSegmentsResolved("turn-empty"),
    /Atomic output segment missing/,
  );
}

function testLifecycleUpdateRejectsMissingCommittedSegment(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTurnStarted("turn-missing-segment");

  assert.throws(
    () => store.markTextDelivered("turn-missing-segment", "msg-missing"),
    /requires committed segment/,
  );
  assert.equal(store.getSession("turn-missing-segment")?.segments.size, 0);
}

function testFailedTextMaterialRemainsAnExplicitFailure(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTurnStarted("turn-text-failed");
  store.commitOutputSegment("turn-text-failed", "msg-text-failed", {
    text: { state: "failed", reason: "text_material_invalid" },
    audio: { state: "absent" },
    motion: { state: "absent" },
  });

  const segment = store.getSession("turn-text-failed")?.segments.get("msg-text-failed");
  assert.equal(segment?.text.delivered, true);
  assert.equal(segment?.text.failed, true);
  assert.equal(segment?.text.reason, "text_material_invalid");
}

function testFailedSessionCannotTransition(): void {
  const store = useTurnPlaybackSessionStore();
  store.setActiveSession("turn-1");
  store.markTurnStarted("turn-1");
  store.markPhase("turn-1", "failed");
  assert.equal(store.getActiveSession()?.phase, "failed");
  assert.throws(
    () => store.markPhase("turn-1", "completed"),
    /illegal phase transition/,
  );
  assert.equal(store.getActiveSession()?.phase, "failed");
}

function testInterruptMarksSessionFailed(): void {
  const store = useTurnPlaybackSessionStore();
  store.setActiveSession("turn-1");
  store.markTurnStarted("turn-1");
  store.markPhase("turn-1", "ready");
  store.markPhase("turn-1", "playing");
  store.markInterrupt("turn-1");

  const session = store.getActiveSession();
  assert.ok(session);
  assert.equal(session.interrupted, true);
  assert.equal(session.phase, "failed");
  assert.equal(session.backend.reason, "interrupted");
}

function testInterruptDoesNotCreateNewSession(): void {
  const store = useTurnPlaybackSessionStore();
  assert.throws(
    () => store.markInterrupt("turn-nonexistent"),
    /Turn playback session does not exist/,
  );
  assert.equal(store.getSessions().length, 0);
}

function testInterruptTargetsRequestedSession(): void {
  const store = useTurnPlaybackSessionStore();
  store.setActiveSession("turn-active");
  store.markTurnStarted("turn-active");
  store.markPhase("turn-active", "ready");
  store.markPhase("turn-active", "playing");
  store.setActiveSession("turn-target");
  store.markTurnStarted("turn-target");
  store.markPhase("turn-target", "ready");
  store.markPhase("turn-target", "playing");
  store.setActiveSession("turn-active");

  store.markInterrupt("turn-target");

  assert.equal(store.getSession("turn-target")?.interrupted, true);
  assert.equal(store.getSession("turn-target")?.phase, "failed");
  assert.equal(store.getSession("turn-active")?.interrupted, false);
  assert.equal(store.getSession("turn-active")?.phase, "playing");
}

function testAudioTerminalHandlesAllStates(): void {
  const store = useTurnPlaybackSessionStore();
  commitSegment(store, "turn-1", "msg-1", {
    text: { state: "present", content: "Hello" },
    audio: { state: "present", url: "http://localhost/a.wav" },
    motion: { state: "absent" },
  });

  store.markAudioTerminal("turn-1", "completed", "msg-1", "ok");
  assert.equal(store.getSession("turn-1")?.segments.get("msg-1")?.audio.terminal, "completed");

  store.markAudioTerminal("turn-1", "failed", "msg-1", "error");
  assert.equal(store.getSession("turn-1")?.segments.get("msg-1")?.audio.terminal, "failed");
  assert.equal(store.getSession("turn-1")?.segments.get("msg-1")?.audio.reason, "error");
}

function run(): void {
  testSessionStartsWithoutTurnLevelPlaybackSlots();
  testSameMessageIdGroupsTextAudioMotion();
  testAtomicOutputSegmentCommitsOnce();
  testAtomicOutputSegmentRejectsClosedQueueWithoutCreatingSegment();
  testCatalogMotionPayloadCanBeStored();
  testPerformanceCurveHintStaysAttachedToMotionPayload();
  testMultipleMessageIdsKeepArrivalOrder();
  testSelectorsOperateOnSegments();
  testSegmentSettlementAndTurnSettlement();
  testBackendCompletionSignalsAreSeparate();
  testSynthFinishedRequiresExistingSession();
  testTurnFinishedRequiresExistingSession();
  testRequiredMessageIdIsEnforced();
  testTurnOnlySessionRemainsTurnScoped();
  testGetUnsettledSegmentsReturnsOnlyUnsettledSegments();
  testIllegalPhaseTransitionIsRejected();
  testReadySessionCanSettleWithoutPlaybackSinks();
  testSynthFinishedRejectsTurnWithoutAtomicSegment();
  testLifecycleUpdateRejectsMissingCommittedSegment();
  testFailedTextMaterialRemainsAnExplicitFailure();
  testFailedSessionCannotTransition();
  testInterruptMarksSessionFailed();
  testInterruptDoesNotCreateNewSession();
  testInterruptTargetsRequestedSession();
  testAudioTerminalHandlesAllStates();
  console.log("turnPlaybackSessionStore tests passed");
}

run();
