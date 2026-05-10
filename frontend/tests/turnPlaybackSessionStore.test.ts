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
import { useTurnPlaybackSessionStore } from "../src/composables/useTurnPlaybackSessionStore.js";
import type { NormalizedMotionPayload } from "../src/model-engine/contracts.js";

const motionPayload: NormalizedMotionPayload = {
  kind: "semantic_intent",
  intent: {} as never,
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
  const session = createTurnPlaybackSession("orch-1", "turn-1");
  assert.equal(session.id, "orch:orch-1");
  assert.equal(session.turnId, "turn-1");
  assert.equal(session.segments.size, 0);
  assert.deepEqual(session.segmentOrder, []);
  assert.equal("text" in session, false);
  assert.equal("audio" in session, false);
  assert.equal("motion" in session, false);
  assert.equal("currentSegmentId" in session, false);
}

function testSameMessageIdGroupsTextAudioMotion(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTextReceived("orch-1", "turn-1", "Hello", "msg-1");
  store.markAudioReceived("orch-1", "turn-1", "http://localhost/a.wav", "msg-1");
  store.markMotionReceived("orch-1", "turn-1", motionPayload, "msg-1");

  const session = getOnlySession(store);
  assert.equal(session.segments.size, 1);
  assert.deepEqual(session.segmentOrder, ["msg-1"]);

  const segment = getSegment(store, "msg-1");
  assert.equal(segment.text.content, "Hello");
  assert.equal(segment.audio.url, "http://localhost/a.wav");
  assert.deepEqual(segment.motion.payload, motionPayload);
}

function testMultipleMessageIdsKeepArrivalOrder(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTextReceived("orch-1", "turn-1", "First", "msg-1");
  store.markTextReceived("orch-1", "turn-1", "Second", "msg-2");
  store.markAudioReceived("orch-1", "turn-1", "http://localhost/second.wav", "msg-2");

  const session = getOnlySession(store);
  assert.deepEqual(session.segmentOrder, ["msg-1", "msg-2"]);
  assert.equal(session.segments.get("msg-1")?.text.content, "First");
  assert.equal(session.segments.get("msg-2")?.audio.url, "http://localhost/second.wav");
}

function testSelectorsOperateOnSegments(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTextReceived("orch-1", "turn-1", "Hello", "msg-1");
  store.markAudioReceived("orch-1", "turn-1", "http://localhost/a.wav", "msg-1");
  store.markMotionReceived("orch-1", "turn-1", motionPayload, "msg-1");

  const segment = getSegment(store, "msg-1");
  assert.equal(canReleaseText(segment), true);
  assert.equal(canReleaseAudio(segment), true);
  assert.equal(canReleaseMotion(segment), true);

  store.markTextReleased("orch-1", "turn-1", "msg-1");
  store.markAudioReleased("orch-1", "turn-1", "msg-1");
  store.markMotionReleased("orch-1", "turn-1", "msg-1");
  assert.equal(canReleaseText(segment), false);
  assert.equal(canReleaseAudio(segment), false);
  assert.equal(canReleaseMotion(segment), false);
}

function testSegmentSettlementAndTurnSettlement(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTextReceived("orch-1", "turn-1", "First", "msg-1");
  store.markTextReceived("orch-1", "turn-1", "Second", "msg-2");

  const session = getOnlySession(store);
  assert.equal(isPlaybackLocallySettled(session), false);

  store.markTextDelivered("orch-1", "turn-1", "msg-1");
  store.markAudioTerminal("orch-1", "turn-1", "absent", "msg-1", "no_audio");
  store.markMotionAbsent("orch-1", "turn-1", "msg-1");
  assert.equal(store.isSegmentSettled(session.id, "msg-1"), true);
  assert.equal(isSegmentLocallySettled(session.segments.get("msg-1")!), true);
  assert.equal(isPlaybackLocallySettled(session), false);

  store.markTextDelivered("orch-1", "turn-1", "msg-2");
  store.markAudioTerminal("orch-1", "turn-1", "absent", "msg-2", "no_audio");
  store.markMotionAbsent("orch-1", "turn-1", "msg-2");
  assert.equal(isPlaybackLocallySettled(session), true);
}

function testRequiredMessageIdIsEnforced(): void {
  const store = useTurnPlaybackSessionStore();
  assert.throws(
    () => store.markTextReceived("orch-1", "turn-1", "Hello", "   "),
    /messageId/,
  );
}

function testGetUnsettledSegmentsReturnsOnlyUnsettledSegments(): void {
  const store = useTurnPlaybackSessionStore();
  store.markTextReceived("orch-1", "turn-1", "First", "msg-1");
  store.markTextReceived("orch-1", "turn-1", "Second", "msg-2");
  store.markTextDelivered("orch-1", "turn-1", "msg-1");
  store.markAudioTerminal("orch-1", "turn-1", "absent", "msg-1", "no_audio");
  store.markMotionAbsent("orch-1", "turn-1", "msg-1");

  assert.deepEqual(
    store.getUnsettledSegments().map((segment) => segment.messageId),
    ["msg-2"],
  );
}

function run(): void {
  testSessionStartsWithoutTurnLevelPlaybackSlots();
  testSameMessageIdGroupsTextAudioMotion();
  testMultipleMessageIdsKeepArrivalOrder();
  testSelectorsOperateOnSegments();
  testSegmentSettlementAndTurnSettlement();
  testRequiredMessageIdIsEnforced();
  testGetUnsettledSegmentsReturnsOnlyUnsettledSegments();
  console.log("turnPlaybackSessionStore tests passed");
}

run();
