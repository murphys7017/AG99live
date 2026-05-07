// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { reactive, nextTick } from "vue";
import { useTurnPlaybackSessionStore } from "../src/composables/useTurnPlaybackSessionStore.js";
import { usePlaybackCompletionCoordinator } from "../src/composables/usePlaybackCompletionCoordinator.js";
import { orchestrationIdFromSessionId } from "../src/turn-playback/session.js";

// ── Harness ───────────────────────────────────────────────────────

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
  let audioStartedTurnId: string | null = null;

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
    onAudioPlaybackStarted: (turnId) => {
      audioStartedTurnId = turnId;
    },
    initialMotionPlaybackRecords: [],
  });

  return {
    sessionStore,
    coordinator,
    mockMotionPlayer,
    playbackFinishedCalls,
    clearContextCalls,
    audioStartedTurnId: () => audioStartedTurnId,
    /** Flush Vue watchers */
    flush: () => nextTick(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function setupActiveSession(
  sessionStore: ReturnType<typeof useTurnPlaybackSessionStore>,
  orchId: string,
  turnId: string,
) {
  sessionStore.setActiveSession(orchId);
  const s = sessionStore.ensureSession(orchId, turnId);
  // Simulate orchestrator: advance phase to "playing" (ready → playing)
  // The orchestrator would do this after releasing text/motion.
  sessionStore.markPhase(orchId, turnId, "ready");
  sessionStore.markPhase(orchId, turnId, "playing");
  return s;
}

// ── Tests ─────────────────────────────────────────────────────────

async function testFullCompletion(): Promise<void> {
  const h = createHarness();
  const s = setupActiveSession(h.sessionStore, "orch-1", "turn-1");

  // Text delivered
  s.text.content = "Hello";
  s.text.delivered = true;
  s.text.released = true;
  await h.flush();

  // Motion already completed (avoids settlement window)
  s.motion.payload = { kind: "semantic_intent" as const, intent: {} as never };
  s.motion.started = true;
  s.motion.completed = true;
  await h.flush();

  // Audio completed
  s.audio.url = "http://x/audio.wav";
  s.audio.started = true;
  s.audio.terminal = "completed";
  await h.flush();

  // Backend turn finished — this should trigger the ack
  s.backend.turnFinished = true;
  s.backend.success = true;
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 1, "should send playback_finished");
  assert.equal(h.playbackFinishedCalls[0].success, true);
  assert.equal(h.playbackFinishedCalls[0].turnId, "turn-1");

  // Phase should be "completed"
  const orchId = orchestrationIdFromSessionId(s.id);
  assert.equal(s.phase, "completed");
  assert.equal(h.clearContextCalls.length, 1);
}

async function testAudioFailedStillAcks(): Promise<void> {
  const h = createHarness();
  const s = setupActiveSession(h.sessionStore, "orch-1", "turn-1");

  s.text.content = "Hello";
  s.text.delivered = true;
  s.text.released = true;
  s.motion.payload = { kind: "semantic_intent" as const, intent: {} as never };
  s.motion.started = true;
  s.motion.completed = true;
  s.audio.terminal = "failed";
  s.audio.reason = "decode_error";
  await h.flush();

  s.backend.turnFinished = true;
  s.backend.success = true;
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 1, "should send playback_finished even on audio failure");
  assert.equal(h.playbackFinishedCalls[0].success, false, "should report success=false on audio failure");
  assert.equal(s.phase, "completed");
}

async function testNoAudioWithMotion(): Promise<void> {
  const h = createHarness();
  const s = setupActiveSession(h.sessionStore, "orch-1", "turn-1");

  s.text.content = "No audio this time";
  s.text.delivered = true;
  s.text.released = true;
  s.motion.payload = { kind: "semantic_intent" as const, intent: {} as never };
  s.motion.started = true;
  s.motion.completed = true;
  s.audio.terminal = "absent";
  await h.flush();

  s.backend.turnFinished = true;
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 1, "should send playback_finished for no-audio turn");
  assert.equal(s.phase, "completed");
}

async function testNoAudioNoMotion(): Promise<void> {
  const h = createHarness();
  const s = setupActiveSession(h.sessionStore, "orch-1", "turn-1");

  // Text-only turn — no motion, no audio
  s.text.content = "Text only";
  s.text.delivered = true;
  s.text.released = true;
  s.audio.terminal = "absent";
  s.backend.turnFinished = true;
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 1, "text-only turn should still ack");
  assert.equal(s.phase, "completed");
}

async function testAudioStartedNotifiesModelEngine(): Promise<void> {
  const h = createHarness();
  const s = setupActiveSession(h.sessionStore, "orch-1", "turn-1");

  s.audio.url = "http://x/audio.wav";
  s.audio.started = true;
  await h.flush();

  assert.equal(h.audioStartedTurnId(), "turn-1", "should notify model engine on audio start");
}

async function testTurnSwitchResetsCompletion(): Promise<void> {
  const h = createHarness();
  const s1 = setupActiveSession(h.sessionStore, "orch-1", "turn-1");

  // Partially complete turn 1
  s1.text.content = "Turn 1";
  s1.text.delivered = true;
  s1.text.released = true;
  s1.audio.terminal = "completed";
  await h.flush();

  // Switch to turn 2 — should reset internal state
  h.sessionStore.setActiveSession("orch-2");
  await h.flush();

  const s2 = setupActiveSession(h.sessionStore, "orch-2", "turn-2");
  s2.text.content = "Turn 2";
  s2.text.delivered = true;
  s2.text.released = true;
  s2.audio.terminal = "completed";
  s2.motion.payload = null;
  s2.backend.turnFinished = true;
  await h.flush();

  // Turn 2 should complete
  assert.equal(h.playbackFinishedCalls.length, 1, "turn 2 should ack");
  assert.equal(h.playbackFinishedCalls[0].turnId, "turn-2");

  // Turn 1 should NOT have acked (reset on switch)
  // Check phase: turn 1 should still be in collecting/ready (not completed)
  assert.notEqual(s1.phase, "completed", "turn 1 should not be completed after switch");
}

async function testCompletionNotSentTwice(): Promise<void> {
  const h = createHarness();
  const s = setupActiveSession(h.sessionStore, "orch-1", "turn-1");

  s.text.content = "Hello";
  s.text.delivered = true;
  s.text.released = true;
  s.motion.payload = null;
  s.audio.terminal = "absent";
  s.backend.turnFinished = true;
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 1);

  // Modify session again — should not trigger another ack
  s.text.content = "Updated";
  await h.flush();

  assert.equal(h.playbackFinishedCalls.length, 1, "should not send duplicate playback_finished");
}

// ── Run ───────────────────────────────────────────────────────────

async function run(): Promise<void> {
  await testFullCompletion();
  await testAudioFailedStillAcks();
  await testNoAudioWithMotion();
  await testNoAudioNoMotion();
  await testAudioStartedNotifiesModelEngine();
  await testTurnSwitchResetsCompletion();
  await testCompletionNotSentTwice();

  console.log("playbackCompletionCoordinator tests passed");
}

run().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
