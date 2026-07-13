import assert from "node:assert/strict";
import { nextTick } from "vue";
import { usePlaybackCompletionCoordinator } from "../src/turn-playback/usePlaybackCompletionCoordinator.js";
import { useTurnPlaybackSessionStore } from "../src/turn-playback/useTurnPlaybackSessionStore.js";

interface Harness {
  sessionStore: ReturnType<typeof useTurnPlaybackSessionStore>;
  playbackFinishedCalls: Array<{ turnId: string | null; success: boolean; reason?: string }>;
  coordinator: ReturnType<typeof usePlaybackCompletionCoordinator>;
}

function createHarness(sendResult: boolean | "reject" | Promise<boolean> = true): Harness {
  const sessionStore = useTurnPlaybackSessionStore();
  const playbackFinishedCalls: Harness["playbackFinishedCalls"] = [];
  const coordinator = usePlaybackCompletionCoordinator({
    sessionStore,
    playbackAck: {
      sendPlaybackFinishedForCurrentGroup: async (turnId, success, reason) => {
        playbackFinishedCalls.push({ turnId, success, reason });
        if (sendResult === "reject") {
          throw new Error("socket_send_failed");
        }
        return await sendResult;
      },
      clearPlaybackGroupContext: () => undefined,
    },
  });
  sessionStore.setActiveSession("turn-1");
  sessionStore.markTurnStarted("turn-1");
  sessionStore.markPhase("turn-1", "ready");
  sessionStore.markPhase("turn-1", "playing");
  return { sessionStore, playbackFinishedCalls, coordinator };
}

function commitSettledReply(
  h: Harness,
  audio: { state: "absent" } | { state: "failed"; reason: string } = { state: "absent" },
): void {
  h.sessionStore.commitOutputSegment("turn-1", "msg-1", {
    text: { state: "present", content: "hello" },
    audio,
    motion: { state: "absent" },
  });
  h.sessionStore.markTextDelivered("turn-1", "msg-1");
}

async function testLateAckDoesNotCompleteInterruptedSession(): Promise<void> {
  let resolveSend!: (sent: boolean) => void;
  const sendResult = new Promise<boolean>((resolve) => {
    resolveSend = resolve;
  });
  const h = createHarness(sendResult);
  commitSettledReply(h);
  h.sessionStore.markSynthFinished("turn-1");
  h.sessionStore.markTurnFinished("turn-1", true);
  await nextTick();

  assert.equal(h.sessionStore.getActiveSession()?.phase, "settling");
  h.sessionStore.markInterrupt("turn-1");
  resolveSend(true);
  await flush();

  assert.equal(h.sessionStore.getActiveSession()?.phase, "failed");
}

async function testSendFailureFailsSessionInsteadOfAcknowledging(): Promise<void> {
  const h = createHarness(false);
  commitSettledReply(h);
  h.sessionStore.markSynthFinished("turn-1");
  await flush();

  const session = h.sessionStore.getActiveSession();
  assert.equal(session?.phase, "failed");
  assert.equal(session?.backend.reason, "playback_finished_send_failed");
}

async function testSendExceptionFailsSessionInsteadOfHanging(): Promise<void> {
  const h = createHarness("reject");
  commitSettledReply(h);
  h.sessionStore.markSynthFinished("turn-1");
  await flush();

  assert.equal(h.sessionStore.getActiveSession()?.phase, "failed");
}

async function flush(): Promise<void> {
  await nextTick();
  await nextTick();
}

async function testAcknowledgesOnlyAfterAllRequiredSignals(): Promise<void> {
  const h = createHarness();
  commitSettledReply(h);

  await flush();
  assert.equal(h.playbackFinishedCalls.length, 0);

  h.sessionStore.markSynthFinished("turn-1");
  await flush();
  assert.deepEqual(h.playbackFinishedCalls, [{
    turnId: "turn-1",
    success: true,
    reason: "text_delivered",
  }]);
  assert.equal(h.sessionStore.getActiveSession()?.phase, "settling");
}

async function testBackendTurnFinishedFinalizesAckedSession(): Promise<void> {
  const h = createHarness();
  commitSettledReply(h);
  h.sessionStore.markSynthFinished("turn-1");
  await flush();

  h.sessionStore.markTurnFinished("turn-1", true);
  await flush();
  assert.equal(h.sessionStore.getActiveSession()?.phase, "completed");
  assert.equal(h.playbackFinishedCalls.length, 1);
}

async function testFailedSegmentProducesFailedPlaybackAck(): Promise<void> {
  const h = createHarness();
  commitSettledReply(h, { state: "failed", reason: "audio_error" });
  h.sessionStore.markSynthFinished("turn-1");
  await flush();

  assert.equal(h.playbackFinishedCalls[0]?.success, false);
}

async function testFailedTextProducesFailedPlaybackAck(): Promise<void> {
  const h = createHarness();
  h.sessionStore.commitOutputSegment("turn-1", "msg-text-failed", {
    text: { state: "failed", reason: "text_invalid" },
    audio: { state: "absent" },
    motion: { state: "absent" },
  });
  h.sessionStore.markSynthFinished("turn-1");
  await flush();

  assert.equal(h.playbackFinishedCalls[0]?.success, false);
}

async function testResetAllowsASecondAcknowledgementCycle(): Promise<void> {
  const h = createHarness();
  commitSettledReply(h);
  h.sessionStore.markSynthFinished("turn-1");
  await flush();
  assert.equal(h.playbackFinishedCalls.length, 1);

  h.coordinator.resetPlaybackCoordination();
  h.sessionStore.markPhase("turn-1", "playing");
  await flush();
  assert.equal(h.playbackFinishedCalls.length, 2);
}

await testAcknowledgesOnlyAfterAllRequiredSignals();
await testBackendTurnFinishedFinalizesAckedSession();
await testFailedSegmentProducesFailedPlaybackAck();
await testFailedTextProducesFailedPlaybackAck();
await testResetAllowsASecondAcknowledgementCycle();
await testSendFailureFailsSessionInsteadOfAcknowledging();
await testSendExceptionFailsSessionInsteadOfHanging();
await testLateAckDoesNotCompleteInterruptedSession();
console.log("playbackCompletionCoordinator tests passed");
