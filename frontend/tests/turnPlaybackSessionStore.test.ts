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
  store.markTextReceived("turn-1", "Hello", "msg-1");
  store.markAudioReceived("turn-1", "http://localhost/a.wav", "msg-1");
  store.markMotionReceived("turn-1", motionPayload, "msg-1");

  const session = getOnlySession(store);
  assert.equal(session.segments.size, 1);
  assert.deepEqual(session.segmentOrder, ["msg-1"]);

  const segment = getSegment(store, "msg-1");
  assert.equal(segment.text.content, "Hello");
  assert.equal(segment.audio.url, "http://localhost/a.wav");
  assert.deepEqual(segment.motion.payload, motionPayload);
}

function testCatalogMotionPayloadCanBeStored(): void {
  const store = useTurnPlaybackSessionStore();
  store.markMotionReceived("turn-1", catalogMotionPayload, "msg-1");

  const segment = getSegment(store, "msg-1");
  assert.equal(segment.motion.payload?.kind, "catalog_motion");
}

function testPerformanceCurveHintCanBeStoredOnSegment(): void {
  const store = useTurnPlaybackSessionStore();
  store.markPerformanceCurveHintReceived("turn-1", curveHint, "msg-1");
  store.markMotionReceived("turn-1", motionPayload, "msg-1");

  const segment = getSegment(store, "msg-1");
  assert.deepEqual(segment.motion.performanceCurveHint, curveHint);
  assert.equal(typeof segment.motion.performanceCurveHintReceivedAtMs, "number");

  store.markMotionAbsent("turn-1", "msg-1");
  assert.equal(segment.motion.performanceCurveHint, null);
  assert.equal(segment.motion.performanceCurveHintReceivedAtMs, null);
  assert.equal(segment.motion.absent, true);
  assert.equal(segment.motion.completed, false);
}

function testMultipleMessageIdsKeepArrivalOrder(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTextReceived("turn-1", "First", "msg-1");
  store.markTextReceived("turn-1", "Second", "msg-2");
  store.markAudioReceived("turn-1", "http://localhost/second.wav", "msg-2");

  const session = getOnlySession(store);
  assert.deepEqual(session.segmentOrder, ["msg-1", "msg-2"]);
  assert.equal(session.segments.get("msg-1")?.text.content, "First");
  assert.equal(session.segments.get("msg-2")?.audio.url, "http://localhost/second.wav");
}

function testSelectorsOperateOnSegments(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTextReceived("turn-1", "Hello", "msg-1");
  store.markAudioReceived("turn-1", "http://localhost/a.wav", "msg-1");
  store.markMotionReceived("turn-1", motionPayload, "msg-1");

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
  store.markTextReceived("turn-1", "First", "msg-1");
  store.markTextReceived("turn-1", "Second", "msg-2");

  const session = getOnlySession(store);
  assert.equal(isPlaybackLocallySettled(session), false);

  store.markTextDelivered("turn-1", "msg-1");
  store.markAudioTerminal("turn-1", "absent", "msg-1", "no_audio");
  store.markMotionAbsent("turn-1", "msg-1");
  assert.equal(store.isSegmentSettled(session.id, "msg-1"), true);
  assert.equal(isSegmentLocallySettled(session.segments.get("msg-1")!), true);
  assert.equal(isPlaybackLocallySettled(session), false);

  store.markTextDelivered("turn-1", "msg-2");
  store.markAudioTerminal("turn-1", "absent", "msg-2", "no_audio");
  store.markMotionAbsent("turn-1", "msg-2");
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
  assert.throws(
    () => store.markTextReceived("turn-1", "Hello", "   "),
    /messageId/,
  );
}

function testTurnOnlySessionRemainsTurnScoped(): void {
  const store = useTurnPlaybackSessionStore();
  store.setActiveSession("turn-1");
  store.markTextReceived("turn-1", "Early", "msg-1");
  store.markAudioReceived("turn-1", "http://localhost/audio.wav", "msg-1");

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
  store.markTextReceived("turn-1", "First", "msg-1");
  store.markTextReceived("turn-1", "Second", "msg-2");
  store.markTextDelivered("turn-1", "msg-1");
  store.markAudioTerminal("turn-1", "absent", "msg-1", "no_audio");
  store.markMotionAbsent("turn-1", "msg-1");

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
  const result = store.markPhase("turn-1", "playing");
  assert.equal(result, false);
  assert.equal(store.getActiveSession()?.phase, "completed");
}

function testFailedSessionCannotTransition(): void {
  const store = useTurnPlaybackSessionStore();
  store.setActiveSession("turn-1");
  store.markTurnStarted("turn-1");
  store.markPhase("turn-1", "failed");
  assert.equal(store.getActiveSession()?.phase, "failed");
  assert.equal(store.markPhase("turn-1", "completed"), false);
  assert.equal(store.getActiveSession()?.phase, "failed");
}

function testInterruptMarksSessionFailed(): void {
  const store = useTurnPlaybackSessionStore();
  store.setActiveSession("turn-1");
  store.markTurnStarted("turn-1");
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
  store.setActiveSession("turn-1");
  store.markTextReceived("turn-1", "Hello", "msg-1");

  store.markAudioTerminal("turn-1", "completed", "msg-1", "ok");
  assert.equal(store.getSession("turn-1")?.segments.get("msg-1")?.audio.terminal, "completed");

  store.markAudioTerminal("turn-1", "failed", "msg-1", "error");
  assert.equal(store.getSession("turn-1")?.segments.get("msg-1")?.audio.terminal, "failed");
  assert.equal(store.getSession("turn-1")?.segments.get("msg-1")?.audio.reason, "error");
}

function testDuplicateAudioReceiveDoesNotResetCompletedSegment(): void {
  const store = useTurnPlaybackSessionStore();
  store.setActiveSession("turn-1");
  store.markTextReceived("turn-1", "Hello", "msg-1");

  assert.equal(store.markAudioReceived("turn-1", "http://localhost/a.wav", "msg-1"), true);
  store.markAudioReleased("turn-1", "msg-1");
  store.markAudioStarted("turn-1", "msg-1", 100, 1000);
  store.markAudioTerminal("turn-1", "completed", "msg-1", "ok");

  assert.equal(store.markAudioReceived("turn-1", "http://localhost/a.wav", "msg-1"), false);
  const segment = store.getSession("turn-1")?.segments.get("msg-1");
  assert.equal(segment?.audio.terminal, "completed");
  assert.equal(segment?.audio.started, true);
}

function testDifferentAudioUrlDoesNotResetCompletedSegment(): void {
  const store = useTurnPlaybackSessionStore();
  store.setActiveSession("turn-1");
  store.markTextReceived("turn-1", "Hello", "msg-1");

  assert.equal(store.markAudioReceived("turn-1", "http://localhost/a.wav", "msg-1"), true);
  store.markAudioReleased("turn-1", "msg-1");
  store.markAudioStarted("turn-1", "msg-1", 100, 1000);
  store.markAudioTerminal("turn-1", "completed", "msg-1", "ok");

  assert.equal(store.markAudioReceived("turn-1", "http://localhost/a-v2.wav", "msg-1"), false);
  const segment = store.getSession("turn-1")?.segments.get("msg-1");
  assert.equal(segment?.audio.url, "http://localhost/a.wav");
  assert.equal(segment?.audio.terminal, "completed");
  assert.equal(segment?.audio.started, true);
}

function testDuplicateMotionReceiveDoesNotResetReleasedSegment(): void {
  const store = useTurnPlaybackSessionStore();
  store.setActiveSession("turn-1");
  store.markTextReceived("turn-1", "Hello", "msg-1");
  store.markMotionReceived("turn-1", motionPayload, "msg-1");
  store.markMotionReleased("turn-1", "msg-1");

  store.markMotionReceived("turn-1", catalogMotionPayload, "msg-1");
  const segment = store.getSession("turn-1")?.segments.get("msg-1");
  assert.deepEqual(segment?.motion.payload, motionPayload);
  assert.equal(segment?.motion.released, true);
}

function run(): void {
  testSessionStartsWithoutTurnLevelPlaybackSlots();
  testSameMessageIdGroupsTextAudioMotion();
  testCatalogMotionPayloadCanBeStored();
  testPerformanceCurveHintCanBeStoredOnSegment();
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
  testFailedSessionCannotTransition();
  testInterruptMarksSessionFailed();
  testInterruptDoesNotCreateNewSession();
  testInterruptTargetsRequestedSession();
  testAudioTerminalHandlesAllStates();
  testDuplicateAudioReceiveDoesNotResetCompletedSegment();
  testDifferentAudioUrlDoesNotResetCompletedSegment();
  testDuplicateMotionReceiveDoesNotResetReleasedSegment();
  console.log("turnPlaybackSessionStore tests passed");
}

run();
