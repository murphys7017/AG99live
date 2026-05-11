// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { reactive, nextTick } from "vue";
import { useTurnPlaybackSessionStore } from "../src/composables/useTurnPlaybackSessionStore.js";
import { usePlaybackCompletionCoordinator } from "../src/composables/usePlaybackCompletionCoordinator.js";

interface PlaybackFinishedCall {
  turnId: string | null;
  orchestrationId: string | null;
  success: boolean;
  reason?: string;
}

function createHarness() {
  const sessionStore = useTurnPlaybackSessionStore();
  const playbackFinishedCalls: PlaybackFinishedCall[] = [];
  const clearContextCalls: Array<{ turnId: string | null; orchestrationId: string | null }> = [];
  const audioStarted: Array<{ turnId: string | null; messageId: string }> = [];

  const mockMotionPlayer = {
    state: reactive({ status: "idle" as string }),
  };

  const mockAdapter = {
    state: { lastAssistantText: "Hello from assistant" },
    sendPlaybackFinishedForCurrentGroup(
      turnId: string | null,
      orchestrationId: string | null,
      success: boolean,
      reason?: string,
    ): Promise<void> {
      playbackFinishedCalls.push({ turnId, orchestrationId, success, reason });
      return Promise.resolve();
    },
    clearPlaybackGroupContext(
      turnId: string | null,
      orchestrationId: string | null,
    ): void {
      clearContextCalls.push({ turnId, orchestrationId });
    },
  };

  const coordinator = usePlaybackCompletionCoordinator({
    sessionStore,
    adapter: mockAdapter as never,
    motionPlayer: mockMotionPlayer as never,
    selectedModel: { value: null } as never,
    onAudioPlaybackStarted: (turnId, messageId) => {
      audioStarted.push({ turnId, messageId });
    },
    initialMotionPlaybackRecords: [],
  });

  sessionStore.setActiveSession("orch-1", "turn-1");
  sessionStore.markTurnStarted("orch-1", "turn-1");
  sessionStore.markPhase("orch-1", "turn-1", "ready");
  sessionStore.markPhase("orch-1", "turn-1", "playing");

  return {
    sessionStore,
    coordinator,
    mockMotionPlayer,
    playbackFinishedCalls,
    clearContextCalls,
    audioStarted,
    flush: () => nextTick(),
  };
}

async function testSegmentCompletionDoesNotFinishTurnEarly(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("orch-1", "turn-1", "A", "msg-a");
  h.sessionStore.markTextReceived("orch-1", "turn-1", "B", "msg-b");

  h.sessionStore.markTextDelivered("orch-1", "turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("orch-1", "turn-1", "absent", "msg-a", "no_audio");
  h.sessionStore.markMotionAbsent("orch-1", "turn-1", "msg-a");
  h.sessionStore.markSynthFinished("orch-1", "turn-1");
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 0);
  assert.equal(h.sessionStore.getActiveSession()?.phase, "playing");
}

async function testAllSegmentsAndSynthFinishedAckOnce(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("orch-1", "turn-1", "A", "msg-a");
  h.sessionStore.markTextReceived("orch-1", "turn-1", "B", "msg-b");

  for (const messageId of ["msg-a", "msg-b"]) {
    h.sessionStore.markTextDelivered("orch-1", "turn-1", messageId);
    h.sessionStore.markAudioTerminal("orch-1", "turn-1", "absent", messageId, "no_audio");
    h.sessionStore.markMotionAbsent("orch-1", "turn-1", messageId);
  }
  await h.flush();
  assert.equal(h.playbackFinishedCalls.length, 0, "backend synth_finished is required");

  h.sessionStore.markSynthFinished("orch-1", "turn-1");
  await h.flush();
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 1);
  assert.deepEqual(h.playbackFinishedCalls[0], {
    turnId: "turn-1",
    orchestrationId: "orch-1",
    success: true,
    reason: "text_delivered",
  });
  assert.equal(h.sessionStore.getActiveSession()?.phase, "settling");

  h.sessionStore.markSynthFinished("orch-1", "turn-1");
  await h.flush();
  assert.equal(h.playbackFinishedCalls.length, 1);

  h.sessionStore.markTurnFinished("orch-1", "turn-1", true);
  await h.flush();
  assert.equal(h.sessionStore.getActiveSession()?.phase, "completed");
}

async function testTurnFinishedBeforeSynthFinishedDoesNotAck(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("orch-1", "turn-1", "A", "msg-a");
  h.sessionStore.markTextDelivered("orch-1", "turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("orch-1", "turn-1", "absent", "msg-a", "no_audio");
  h.sessionStore.markMotionAbsent("orch-1", "turn-1", "msg-a");

  h.sessionStore.markTurnFinished("orch-1", "turn-1", true);
  await h.flush();
  assert.equal(h.playbackFinishedCalls.length, 0);
  assert.equal(h.sessionStore.getActiveSession()?.phase, "playing");

  h.sessionStore.markSynthFinished("orch-1", "turn-1");
  await h.flush();
  await h.flush();
  assert.equal(h.playbackFinishedCalls.length, 1);
  assert.equal(h.sessionStore.getActiveSession()?.phase, "completed");
}

async function testAudioStartedNotificationIsSegmentScoped(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("orch-1", "turn-1", "A", "msg-a");
  h.sessionStore.markAudioReceived("orch-1", "turn-1", "http://localhost/a.wav", "msg-a");
  h.sessionStore.markAudioStarted("orch-1", "turn-1", "msg-a", 100, 1000);
  await h.flush();

  assert.deepEqual(h.audioStarted, [{ turnId: "turn-1", messageId: "msg-a" }]);
}

async function testMotionCompletionWritesCorrectSegment(): Promise<void> {
  const h = createHarness();
  h.sessionStore.markTextReceived("orch-1", "turn-1", "A", "msg-a");
  h.sessionStore.markTextReceived("orch-1", "turn-1", "B", "msg-b");
  h.sessionStore.markMotionReceived(
    "orch-1",
    "turn-1",
    { kind: "semantic_intent", intent: {} as never },
    "msg-b",
  );

  h.coordinator.recordMotionPlayback({
    messageId: "msg-b",
    turnId: "turn-1",
    orchestrationId: "orch-1",
    model: null,
    payloadKind: "semantic_intent",
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
  });

  h.mockMotionPlayer.state.status = "playing";
  await h.flush();
  h.mockMotionPlayer.state.status = "finished";
  await h.flush();

  const session = h.sessionStore.getActiveSession();
  assert.equal(session?.segments.get("msg-a")?.motion.completed, false);
  assert.equal(session?.segments.get("msg-b")?.motion.completed, true);
}

async function testPreviewMotionPlaybackDoesNotCreateSessionSegment(): Promise<void> {
  const h = createHarness();
  const beforeSessionCount = h.sessionStore.getSessions().length;

  h.coordinator.recordMotionPlayback({
    messageId: "preview",
    turnId: null,
    orchestrationId: null,
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
  assert.equal(h.coordinator.motionPlaybackRecords.value[0]?.startReason, "preview");
}

async function run(): Promise<void> {
  await testSegmentCompletionDoesNotFinishTurnEarly();
  await testAllSegmentsAndSynthFinishedAckOnce();
  await testTurnFinishedBeforeSynthFinishedDoesNotAck();
  await testAudioStartedNotificationIsSegmentScoped();
  await testMotionCompletionWritesCorrectSegment();
  await testPreviewMotionPlaybackDoesNotCreateSessionSegment();
  console.log("playbackCompletionCoordinator tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
