import assert from "node:assert/strict";
import {
  createTurnPlaybackSession,
  resolveSessionId,
  isValidPhaseTransition,
  isTerminalPhase,
  orchestrationIdFromSessionId,
  isSessionReadyForRelease,
  type TurnPlaybackSession,
  type TurnPlaybackPhase,
} from "../src/turn-playback/session.js";
import {
  canReleaseText,
  canReleaseAudio,
  canReleaseMotion,
  shouldWaitForLateMotion,
  isPlaybackLocallySettled,
} from "../src/turn-playback/selectors.js";
import { useTurnPlaybackSessionStore } from "../src/composables/useTurnPlaybackSessionStore.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeSession(overrides: Partial<TurnPlaybackSession> = {}): TurnPlaybackSession {
  const base = createTurnPlaybackSession("orch-1", "turn-1");
  return { ...base, ...overrides };
}

function makeTextDeliveredSession(): TurnPlaybackSession {
  return makeSession({
    text: {
      content: "Hello",
      receivedAtMs: 100,
      receiveMode: "replace",
      released: true,
      delivered: true,
    },
    audio: {
      url: null,
      receivedAtMs: null,
      started: false,
      startedAtMs: null,
      durationMs: null,
      terminal: "absent",
      reason: "no_audio",
    },
    motion: {
      payload: null,
      receivedAtMs: null,
      released: false,
      started: false,
      completed: false,
      absent: true,
    },
    backend: {
      turnStarted: true,
      turnFinished: true,
      success: true,
      reason: "",
    },
    phase: "settling",
  });
}

// ── session.ts: ID resolution ─────────────────────────────────────

function testResolveSessionIdOrchPriority(): void {
  assert.equal(resolveSessionId("orch-abc", "turn-xyz"), "orch:orch-abc");
  assert.equal(resolveSessionId("orch-abc", null), "orch:orch-abc");
}

function testResolveSessionIdTurnFallback(): void {
  assert.equal(resolveSessionId(null, "turn-xyz"), "turn:turn-xyz");
  assert.equal(resolveSessionId("", "turn-xyz"), "turn:turn-xyz");
}

function testResolveSessionIdEmpty(): void {
  assert.equal(resolveSessionId(null, null), "");
  assert.equal(resolveSessionId("", ""), "");
}

function testOrchestrationIdFromSessionId(): void {
  assert.equal(orchestrationIdFromSessionId("orch:abc"), "abc");
  assert.equal(orchestrationIdFromSessionId("turn:xyz"), null);
  assert.equal(orchestrationIdFromSessionId("ephemeral:1"), null);
}

// ── session.ts: phase transitions ─────────────────────────────────

function testValidPhaseTransitions(): void {
  // Main path
  assert.equal(isValidPhaseTransition("collecting", "ready"), true);
  assert.equal(isValidPhaseTransition("ready", "playing"), true);
  assert.equal(isValidPhaseTransition("playing", "settling"), true);
  assert.equal(isValidPhaseTransition("settling", "completed"), true);

  // Failure paths
  assert.equal(isValidPhaseTransition("collecting", "failed"), true);
  assert.equal(isValidPhaseTransition("ready", "failed"), true);
  assert.equal(isValidPhaseTransition("playing", "failed"), true);
  assert.equal(isValidPhaseTransition("settling", "failed"), true);
}

function testInvalidPhaseTransitions(): void {
  // Terminal phases cannot transition
  assert.equal(isValidPhaseTransition("completed", "ready"), false);
  assert.equal(isValidPhaseTransition("failed", "collecting"), false);

  // Skipping phases
  assert.equal(isValidPhaseTransition("collecting", "playing"), false);
  assert.equal(isValidPhaseTransition("ready", "settling"), false);

  // Backwards
  assert.equal(isValidPhaseTransition("playing", "ready"), false);
  assert.equal(isValidPhaseTransition("settling", "collecting"), false);
}

function testIsTerminalPhase(): void {
  assert.equal(isTerminalPhase("completed"), true);
  assert.equal(isTerminalPhase("failed"), true);
  assert.equal(isTerminalPhase("playing"), false);
  assert.equal(isTerminalPhase("collecting"), false);
}

// ── session.ts: construction ──────────────────────────────────────

function testCreateTurnPlaybackSessionDefaults(): void {
  const s = createTurnPlaybackSession("orch-1", "turn-1");
  assert.equal(s.id, "orch:orch-1");
  assert.equal(s.turnId, "turn-1");
  assert.equal(s.interrupted, false);
  assert.equal(s.phase, "collecting");
  assert.equal(s.text.content, null);
  assert.equal(s.text.released, false);
  assert.equal(s.text.delivered, false);
  assert.equal(s.audio.terminal, "idle");
  assert.equal(s.audio.url, null);
  assert.equal(s.motion.payload, null);
  assert.equal(s.motion.released, false);
  assert.equal(s.motion.started, false);
  assert.equal(s.motion.absent, false);
  assert.equal(s.backend.turnStarted, false);
  assert.equal(s.backend.turnFinished, false);
}

function testCreateSessionWithoutTurnId(): void {
  const s = createTurnPlaybackSession("orch-1", null);
  assert.equal(s.id, "orch:orch-1");
  assert.equal(s.turnId, null);
}

function testCreateSessionEphemeral(): void {
  const s = createTurnPlaybackSession(null, null, "ephemeral:99");
  assert.equal(s.id, "ephemeral:99");
  assert.equal(s.turnId, null);
}

function testIsSessionReadyForRelease(): void {
  assert.equal(
    isSessionReadyForRelease(makeSession({
      text: { content: "hi", receivedAtMs: 1, receiveMode: "replace", released: false, delivered: false },
    })),
    true,
  );
  assert.equal(
    isSessionReadyForRelease(makeSession({
      text: { content: null, receivedAtMs: null, receiveMode: "replace", released: false, delivered: false },
    })),
    false,
  );
  assert.equal(
    isSessionReadyForRelease(makeSession({ phase: "failed" })),
    false,
  );
}

// ── selectors.ts ──────────────────────────────────────────────────

function testCanReleaseText(): void {
  const s = makeSession({
    text: { content: "Hello", receivedAtMs: 100, receiveMode: "replace", released: false, delivered: false },
  });
  assert.equal(canReleaseText(s), true);

  s.text.released = true;
  assert.equal(canReleaseText(s), false);

  s.text.released = false;
  s.text.content = "";
  assert.equal(canReleaseText(s), false);

  s.text.content = null;
  assert.equal(canReleaseText(s), false);
}

function testCanReleaseAudio(): void {
  const s = makeSession({
    audio: { url: "http://x/audio.wav", receivedAtMs: 100, started: false, startedAtMs: null, durationMs: null, terminal: "idle", reason: "" },
  });
  assert.equal(canReleaseAudio(s), true);

  s.audio.terminal = "completed";
  assert.equal(canReleaseAudio(s), false);

  s.audio.terminal = "idle";
  s.audio.url = "";
  assert.equal(canReleaseAudio(s), false);
}

function testCanReleaseMotion(): void {
  const s = makeSession({
    motion: {
      payload: { kind: "semantic_intent", intent: {} } as never,
      receivedAtMs: 100,
      released: false,
      started: false,
      completed: false,
      absent: false,
    },
  });
  assert.equal(canReleaseMotion(s), true);

  s.motion.released = true;
  assert.equal(canReleaseMotion(s), false);

  s.motion.released = false;
  s.motion.payload = null;
  assert.equal(canReleaseMotion(s), false);
}

function testShouldWaitForLateMotion(): void {
  const s = makeSession({
    motion: {
      payload: { kind: "semantic_intent" } as never,
      receivedAtMs: 100,
      released: false,
      started: false,
      completed: false,
      absent: false,
    },
  });
  assert.equal(shouldWaitForLateMotion(s, 0), true);

  s.motion.released = true;
  assert.equal(shouldWaitForLateMotion(s, 0), false);

  s.motion.released = false;
  s.motion.absent = true;
  assert.equal(shouldWaitForLateMotion(s, 0), false);
}

function testIsPlaybackLocallySettled(): void {
  // Full readiness
  const s = makeTextDeliveredSession();
  assert.equal(isPlaybackLocallySettled(s), true);

  // Missing text.delivered
  const sNoText = makeTextDeliveredSession();
  sNoText.text.delivered = false;
  assert.equal(isPlaybackLocallySettled(sNoText), false);

  // Audio still idle
  const sAudioIdle = makeTextDeliveredSession();
  sAudioIdle.audio.terminal = "idle";
  assert.equal(isPlaybackLocallySettled(sAudioIdle), false);

  // Audio failed — still ack-able
  const sAudioFailed = makeTextDeliveredSession();
  sAudioFailed.audio.terminal = "failed";
  sAudioFailed.audio.reason = "decode_error";
  assert.equal(isPlaybackLocallySettled(sAudioFailed), true);

  // Motion payload exists but not completed
  const sMotionPending = makeTextDeliveredSession();
  sMotionPending.motion = {
    payload: { kind: "semantic_intent" } as never,
    receivedAtMs: 200,
    released: true,
    started: true,
    completed: false,
    absent: false,
  };
  assert.equal(isPlaybackLocallySettled(sMotionPending), false);

  // Motion completed — ack-able
  sMotionPending.motion.completed = true;
  assert.equal(isPlaybackLocallySettled(sMotionPending), true);
}

// ── store: text scenarios ─────────────────────────────────────────

function testStoreTextReplaceMode(): void {
  const store = useTurnPlaybackSessionStore();

  store.markTextReceived("orch-1", "turn-1", "First message");
  const s1 = store.getSession("orch-1")!;
  assert.equal(s1.text.content, "First message");
  assert.equal(s1.text.receiveMode, "replace");

  // Replace with new text
  store.markTextReceived("orch-1", "turn-1", "Updated message");
  const s2 = store.getSession("orch-1")!;
  assert.equal(s2.text.content, "Updated message");

  // Empty text does nothing
  store.markTextReceived("orch-1", "turn-1", "   ");
  const s3 = store.getSession("orch-1")!;
  assert.equal(s3.text.content, "Updated message");
}

function testStoreTextAppendMode(): void {
  const store = useTurnPlaybackSessionStore();

  store.markTextReceived("orch-1", "turn-1", "Hello", "append");
  store.markTextReceived("orch-1", "turn-1", "World", "append");
  const s = store.getSession("orch-1")!;
  assert.equal(s.text.content, "HelloWorld");
}

function testStoreTextMarkers(): void {
  const store = useTurnPlaybackSessionStore();

  store.markTextReceived("orch-1", "turn-1", "Hello");
  store.markTextReleased("orch-1", "turn-1");
  let s = store.getSession("orch-1")!;
  assert.equal(s.text.released, true);
  assert.equal(s.text.delivered, false);

  store.markTextDelivered("orch-1", "turn-1");
  s = store.getSession("orch-1")!;
  assert.equal(s.text.delivered, true);
  assert.equal(s.text.released, true); // delivery implies release
}

// ── store: audio scenarios ────────────────────────────────────────

function testStoreAudioFlow(): void {
  const store = useTurnPlaybackSessionStore();

  store.markAudioReceived("orch-1", "turn-1", "http://localhost/audio.wav");
  let s = store.getSession("orch-1")!;
  assert.equal(s.audio.url, "http://localhost/audio.wav");
  assert.equal(s.audio.terminal, "idle");

  store.markAudioStarted("orch-1", "turn-1", 1234, 5000);
  s = store.getSession("orch-1")!;
  assert.equal(s.audio.started, true);
  assert.equal(s.audio.startedAtMs, 1234);
  assert.equal(s.audio.durationMs, 5000);

  store.markAudioTerminal("orch-1", "turn-1", "completed");
  s = store.getSession("orch-1")!;
  assert.equal(s.audio.terminal, "completed");
}

function testStoreAudioFailed(): void {
  const store = useTurnPlaybackSessionStore();

  store.markAudioReceived("orch-1", "turn-1", "http://localhost/bad.wav");
  store.markAudioTerminal("orch-1", "turn-1", "failed", "decode_error");
  const s = store.getSession("orch-1")!;
  assert.equal(s.audio.terminal, "failed");
  assert.equal(s.audio.reason, "decode_error");
}

function testStoreAudioAbsent(): void {
  const store = useTurnPlaybackSessionStore();

  store.markTextReceived("orch-1", "turn-1", "No audio this turn");
  store.markAudioTerminal("orch-1", "turn-1", "absent", "synth_finished_without_audio");
  const s = store.getSession("orch-1")!;
  assert.equal(s.audio.terminal, "absent");
  assert.equal(s.audio.url, null);
}

// ── store: motion scenarios ───────────────────────────────────────

function testStoreMotionFlow(): void {
  const store = useTurnPlaybackSessionStore();

  const payload = { kind: "semantic_intent" as const, intent: {} as never };
  store.markMotionReceived("orch-1", "turn-1", payload);
  let s = store.getSession("orch-1")!;
  assert.deepStrictEqual(s.motion.payload, payload);
  assert.equal(s.motion.released, false);
  assert.equal(s.motion.started, false);
  assert.equal(s.motion.completed, false);
  assert.equal(s.motion.absent, false);

  store.markMotionReleased("orch-1", "turn-1");
  s = store.getSession("orch-1")!;
  assert.equal(s.motion.released, true);
  assert.equal(s.motion.started, false);

  store.markMotionStarted("orch-1", "turn-1");
  s = store.getSession("orch-1")!;
  assert.equal(s.motion.started, true);

  store.markMotionCompleted("orch-1", "turn-1");
  s = store.getSession("orch-1")!;
  assert.equal(s.motion.completed, true);
}

function testStoreMotionAbsent(): void {
  const store = useTurnPlaybackSessionStore();

  store.markMotionAbsent("orch-1", "turn-1");
  const s = store.getSession("orch-1")!;
  assert.equal(s.motion.payload, null);
  assert.equal(s.motion.absent, true);
  assert.equal(s.motion.completed, true);
  assert.equal(s.motion.started, false);
}

// ── store: backend scenarios ──────────────────────────────────────

function testStoreBackendFlow(): void {
  const store = useTurnPlaybackSessionStore();

  store.markTurnStarted("orch-1", "turn-1");
  let s = store.getSession("orch-1")!;
  assert.equal(s.backend.turnStarted, true);
  assert.equal(s.backend.turnFinished, false);

  store.markTurnFinished("orch-1", "turn-1", true, "ok");
  s = store.getSession("orch-1")!;
  assert.equal(s.backend.turnFinished, true);
  assert.equal(s.backend.success, true);
  assert.equal(s.backend.reason, "ok");
}

// ── store: interrupt ──────────────────────────────────────────────

function testStoreInterrupt(): void {
  const store = useTurnPlaybackSessionStore();

  // Set active session first
  store.setActiveSession("orch-1");
  store.markTextReceived("orch-1", "turn-1", "Processing...");

  store.markInterrupt("orch-1", "turn-1");
  const s = store.getSession("orch-1")!;
  assert.equal(s.interrupted, true);
  assert.equal(s.phase, "failed");
  assert.equal(s.backend.reason, "interrupted");
}

// ── store: phase marking ──────────────────────────────────────────

function testStorePhaseTransition(): void {
  const store = useTurnPlaybackSessionStore();

  let s = store.ensureSession("orch-1", "turn-1");
  assert.equal(s.phase, "collecting");

  assert.equal(store.markPhase("orch-1", "turn-1", "ready"), true);
  s = store.getSession("orch-1")!;
  assert.equal(s.phase, "ready");

  assert.equal(store.markPhase("orch-1", "turn-1", "playing"), true);
  assert.equal(store.markPhase("orch-1", "turn-1", "settling"), true);
  assert.equal(store.markPhase("orch-1", "turn-1", "completed"), true);
}

function testStoreIllegalPhaseTransitionRejected(): void {
  const store = useTurnPlaybackSessionStore();

  // Skip directly to completed — illegal, phase stays at collecting
  assert.equal(store.markPhase("orch-1", "turn-1", "completed"), false);
  let s = store.getSession("orch-1")!;
  assert.equal(s.phase, "collecting");

  // Now do valid transitions
  assert.equal(store.markPhase("orch-1", "turn-1", "ready"), true);
  assert.equal(store.markPhase("orch-1", "turn-1", "playing"), true);
  assert.equal(store.markPhase("orch-1", "turn-1", "settling"), true);
  assert.equal(store.markPhase("orch-1", "turn-1", "completed"), true);

  // Cannot leave terminal state
  assert.equal(store.markPhase("orch-1", "turn-1", "playing"), false);
  s = store.getSession("orch-1")!;
  assert.equal(s.phase, "completed");
}

// ── store: idempotency ────────────────────────────────────────────

function testStoreIdempotentMarks(): void {
  const store = useTurnPlaybackSessionStore();

  store.markTextReceived("orch-1", "turn-1", "Hello");
  store.markTextReceived("orch-1", "turn-1", "Hello"); // same again
  const s = store.getSession("orch-1")!;
  assert.equal(s.text.content, "Hello");

  store.markAudioTerminal("orch-1", "turn-1", "completed", "ok");
  store.markAudioTerminal("orch-1", "turn-1", "completed", "ok"); // same again
  assert.equal(s.audio.terminal, "completed");
  assert.equal(s.audio.reason, "ok");
}

// ── store: event order independence ───────────────────────────────

function testStoreEventOrderIndependence(): void {
  // Order A: text → audio → motion
  const storeA = useTurnPlaybackSessionStore();
  storeA.markTextReceived("orch-1", "turn-1", "A");
  storeA.markAudioReceived("orch-1", "turn-1", "http://a/1.wav");
  storeA.markMotionReceived("orch-1", "turn-1", { kind: "semantic_intent" as const, intent: {} as never });

  // Order B: motion → audio → text
  const storeB = useTurnPlaybackSessionStore();
  storeB.markMotionReceived("orch-1", "turn-1", { kind: "semantic_intent" as const, intent: {} as never });
  storeB.markAudioReceived("orch-1", "turn-1", "http://a/1.wav");
  storeB.markTextReceived("orch-1", "turn-1", "A");

  const sA = storeA.getSession("orch-1")!;
  const sB = storeB.getSession("orch-1")!;
  assert.equal(sA.text.content, sB.text.content);
  assert.equal(sA.audio.url, sB.audio.url);
  assert.equal(!!sA.motion.payload, !!sB.motion.payload);
}

// ── store: pruning ────────────────────────────────────────────────

function testStorePruneSessions(): void {
  const store = useTurnPlaybackSessionStore();

  // Create and move sessions to completed through valid phase transitions
  function completeSession(orch: string, turn: string): void {
    store.markPhase(orch, turn, "ready");
    store.markPhase(orch, turn, "playing");
    store.markPhase(orch, turn, "settling");
    store.markPhase(orch, turn, "completed");
  }

  completeSession("orch-1", "turn-1");
  completeSession("orch-2", "turn-2");
  completeSession("orch-3", "turn-3");
  completeSession("orch-4", "turn-4");
  completeSession("orch-5", "turn-5");

  assert.equal(store.state.sessions.size, 5);

  store.pruneSessions(2);
  // Should keep 2 most recent terminal sessions
  assert.equal(store.state.sessions.size, 2);
}

// ── store: active session ─────────────────────────────────────────

function testStoreActiveSession(): void {
  const store = useTurnPlaybackSessionStore();

  store.setActiveSession("orch-1");
  assert.equal(store.state.activeSessionId, "orch:orch-1");

  const active = store.getActiveSession();
  assert.notEqual(active, undefined);
  assert.equal(active!.id, "orch:orch-1");

  store.setActiveSession(null);
  assert.equal(store.state.activeSessionId, null);
  assert.equal(store.getActiveSession(), undefined);
}

function testStoreActiveSessionTurnFallback(): void {
  const store = useTurnPlaybackSessionStore();

  store.setActiveSession(null, "turn-only-1");
  assert.equal(store.state.activeSessionId, "turn:turn-only-1");
  assert.equal(store.getActiveSession()?.turnId, "turn-only-1");
}

// ── store: missing orchestrationId fallback ───────────────────────

function testStoreMissingOrchIdFallback(): void {
  const store = useTurnPlaybackSessionStore();

  // No orchestrationId, only turnId — resolves to turn: prefix
  store.markTextReceived(null, "turn-ephemeral", "Text with only turnId");
  const sessions = Array.from(store.state.sessions.values());
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "turn:turn-ephemeral");
  assert.equal(sessions[0].turnId, "turn-ephemeral");
  assert.equal(sessions[0].text.content, "Text with only turnId");
}

function testStoreFullyEphemeralSession(): void {
  const store = useTurnPlaybackSessionStore();

  // Both orchestrationId and turnId missing — uses ephemeral prefix
  store.markTextReceived(null, null, "Anonymous text");
  const sessions = Array.from(store.state.sessions.values());
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id.startsWith("ephemeral:"), true);
  assert.equal(sessions[0].turnId, null);
  assert.equal(sessions[0].text.content, "Anonymous text");
}

// ── store: new turn overrides old ─────────────────────────────────

function testStoreNewTurnOverridesOld(): void {
  const store = useTurnPlaybackSessionStore();

  store.markTextReceived("orch-1", "turn-1", "Turn 1 text");
  store.setActiveSession("orch-1");
  // Simulate interrupt
  store.markInterrupt("orch-1", "turn-1");

  // New turn with different orchestrationId
  store.markTextReceived("orch-2", "turn-2", "Turn 2 text");
  store.setActiveSession("orch-2");

  const s1 = store.getSession("orch-1")!;
  const s2 = store.getSession("orch-2")!;
  assert.equal(s1.phase, "failed");
  assert.equal(s1.interrupted, true);
  assert.equal(s2.text.content, "Turn 2 text");
  assert.equal(store.state.activeSessionId, "orch:orch-2");
}

// ── Run ───────────────────────────────────────────────────────────

function run(): void {
  // ID resolution
  testResolveSessionIdOrchPriority();
  testResolveSessionIdTurnFallback();
  testResolveSessionIdEmpty();
  testOrchestrationIdFromSessionId();

  // Phase transitions
  testValidPhaseTransitions();
  testInvalidPhaseTransitions();
  testIsTerminalPhase();

  // Construction
  testCreateTurnPlaybackSessionDefaults();
  testCreateSessionWithoutTurnId();
  testCreateSessionEphemeral();
  testIsSessionReadyForRelease();

  // Selectors
  testCanReleaseText();
  testCanReleaseAudio();
  testCanReleaseMotion();
  testShouldWaitForLateMotion();
  testIsPlaybackLocallySettled();

  // Store: text
  testStoreTextReplaceMode();
  testStoreTextAppendMode();
  testStoreTextMarkers();

  // Store: audio
  testStoreAudioFlow();
  testStoreAudioFailed();
  testStoreAudioAbsent();

  // Store: motion
  testStoreMotionFlow();
  testStoreMotionAbsent();

  // Store: backend
  testStoreBackendFlow();

  // Store: interrupt
  testStoreInterrupt();

  // Store: phase
  testStorePhaseTransition();
  testStoreIllegalPhaseTransitionRejected();

  // Store: idempotency & ordering
  testStoreIdempotentMarks();
  testStoreEventOrderIndependence();

  // Store: pruning & active session
  testStorePruneSessions();
  testStoreActiveSession();
  testStoreActiveSessionTurnFallback();

  // Store: edge cases
  testStoreMissingOrchIdFallback();
  testStoreFullyEphemeralSession();
  testStoreNewTurnOverridesOld();

  console.log("turnPlaybackSessionStore tests passed");
}

run();
