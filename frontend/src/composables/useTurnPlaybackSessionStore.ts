import { reactive, readonly } from "vue";
import type {
  TurnPlaybackSession,
  TurnPlaybackPhase,
  TextReceiveMode,
  AudioTerminalState,
} from "../turn-playback/session.js";
import {
  createTurnPlaybackSession,
  resolveSessionId,
  isValidPhaseTransition,
} from "../turn-playback/session.js";
import type { NormalizedMotionPayload } from "../model-engine/contracts.js";

// ── Store state ────────────────────────────────────────────────────

interface SessionStoreState {
  sessions: Map<string, TurnPlaybackSession>;
  activeSessionId: string | null;
}

// ── Store ──────────────────────────────────────────────────────────

export function useTurnPlaybackSessionStore() {
  let ephemeralSerial = 0;

  const state = reactive<SessionStoreState>({
    sessions: new Map(),
    activeSessionId: null,
  });

  // ── helpers ─────────────────────────────────────────────────────

  function nextEphemeralId(): string {
    ephemeralSerial += 1;
    return `ephemeral:${ephemeralSerial}`;
  }

  function log(message: string, details?: Record<string, unknown>): void {
    console.info(`[TurnPlaybackSessionStore] ${message}.`, details ?? {});
  }

  // ── session lookup / creation ───────────────────────────────────

  function ensureSession(
    orchestrationId: string | null,
    turnId: string | null = null,
  ): TurnPlaybackSession {
    const resolvedKey = resolveSessionId(orchestrationId, turnId);
    const key = resolvedKey || nextEphemeralId();

    const existing = state.sessions.get(key);
    if (existing) {
      // Fill in turnId if it was missing on creation
      if (!existing.turnId && turnId) {
        const normalizedTurnId = typeof turnId === "string" ? turnId.trim() : "";
        if (normalizedTurnId) {
          existing.turnId = normalizedTurnId;
        }
      }
      return existing;
    }

    const session = createTurnPlaybackSession(orchestrationId, turnId, key);
    state.sessions.set(key, session);
    log("session created", {
      id: session.id,
      orchestrationId: orchestrationId ?? null,
      turnId: turnId ?? null,
      ephemeral: !resolvedKey,
    });
    return session;
  }

  function getSession(orchestrationId: string | null): TurnPlaybackSession | undefined {
    if (!orchestrationId) {
      return undefined;
    }
    const key = resolveSessionId(orchestrationId, null);
    if (!key) {
      return undefined;
    }
    return state.sessions.get(key);
  }

  function getActiveSession(): TurnPlaybackSession | undefined {
    if (!state.activeSessionId) {
      return undefined;
    }
    return state.sessions.get(state.activeSessionId);
  }

  function getSessionById(sessionId: string | null): TurnPlaybackSession | undefined {
    if (!sessionId) {
      return undefined;
    }
    return state.sessions.get(sessionId);
  }

  function getSessions(): TurnPlaybackSession[] {
    return Array.from(state.sessions.values());
  }

  function setActiveSession(
    orchestrationId: string | null,
    turnId: string | null = null,
  ): void {
    const key = resolveSessionId(orchestrationId, turnId);
    if (!key) {
      state.activeSessionId = null;
      return;
    }
    const session = ensureSession(orchestrationId, turnId);
    state.activeSessionId = session.id;
  }

  // ── text ────────────────────────────────────────────────────────

  function markTextReceived(
    orchestrationId: string | null,
    turnId: string | null,
    text: string,
    mode: TextReceiveMode = "replace",
  ): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const session = ensureSession(orchestrationId, turnId);
    if (mode === "append" && session.text.content) {
      session.text.content = session.text.content + trimmed;
    } else {
      session.text.content = trimmed;
    }
    session.text.receiveMode = mode;
    session.text.receivedAtMs = performance.now();
    if (!session.backend.turnStarted) {
      session.backend.turnStarted = true;
    }
  }

  function markTextReleased(
    orchestrationId: string | null,
    turnId: string | null,
  ): void {
    const session = ensureSession(orchestrationId, turnId);
    session.text.released = true;
  }

  function markTextDelivered(
    orchestrationId: string | null,
    turnId: string | null,
  ): void {
    const session = ensureSession(orchestrationId, turnId);
    session.text.delivered = true;
    session.text.released = true; // delivery implies release
  }

  // ── audio ───────────────────────────────────────────────────────

  function markAudioReceived(
    orchestrationId: string | null,
    turnId: string | null,
    url: string,
  ): void {
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }
    const session = ensureSession(orchestrationId, turnId);
    session.audio.url = trimmed;
    session.audio.receivedAtMs = performance.now();
    session.audio.terminal = "idle";
    session.audio.reason = "";
    session.audio.started = false;
    session.audio.startedAtMs = null;
    session.audio.durationMs = null;
  }

  function markAudioStarted(
    orchestrationId: string | null,
    turnId: string | null,
    startedAtMs?: number | null,
    durationMs?: number | null,
  ): void {
    const session = ensureSession(orchestrationId, turnId);
    session.audio.started = true;
    session.audio.startedAtMs =
      typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
        ? startedAtMs
        : performance.now();
    session.audio.durationMs =
      typeof durationMs === "number" && Number.isFinite(durationMs)
        ? durationMs
        : null;
  }

  function markAudioTerminal(
    orchestrationId: string | null,
    turnId: string | null,
    terminal: Exclude<AudioTerminalState, "idle">,
    reason = "",
  ): void {
    const session = ensureSession(orchestrationId, turnId);
    session.audio.terminal = terminal;
    session.audio.reason = reason || session.audio.reason;
  }

  // ── motion ──────────────────────────────────────────────────────

  function markMotionReceived(
    orchestrationId: string | null,
    turnId: string | null,
    payload: NormalizedMotionPayload,
  ): void {
    if (!payload) {
      return;
    }
    const session = ensureSession(orchestrationId, turnId);
    session.motion.payload = payload;
    session.motion.receivedAtMs = performance.now();
    session.motion.absent = false;
    session.motion.released = false;
    session.motion.started = false;
    session.motion.completed = false;
  }

  function markMotionAbsent(
    orchestrationId: string | null,
    turnId: string | null,
  ): void {
    const session = ensureSession(orchestrationId, turnId);
    session.motion.payload = null;
    session.motion.receivedAtMs = null;
    session.motion.absent = true;
    session.motion.released = false;
    session.motion.started = false;
    session.motion.completed = true;
  }

  function markMotionReleased(
    orchestrationId: string | null,
    turnId: string | null,
  ): void {
    const session = ensureSession(orchestrationId, turnId);
    session.motion.absent = false;
    session.motion.released = true;
  }

  function markMotionStarted(
    orchestrationId: string | null,
    turnId: string | null,
  ): void {
    const session = ensureSession(orchestrationId, turnId);
    session.motion.absent = false;
    session.motion.released = true;
    session.motion.started = true;
  }

  function markMotionCompleted(
    orchestrationId: string | null,
    turnId: string | null,
  ): void {
    const session = ensureSession(orchestrationId, turnId);
    session.motion.absent = false;
    session.motion.released = true;
    session.motion.completed = true;
  }

  // ── backend ─────────────────────────────────────────────────────

  function markTurnStarted(
    orchestrationId: string | null,
    turnId: string | null,
  ): void {
    const session = ensureSession(orchestrationId, turnId);
    session.backend.turnStarted = true;
  }

  function markTurnFinished(
    orchestrationId: string | null,
    turnId: string | null,
    success: boolean,
    reason = "",
  ): void {
    const session = ensureSession(orchestrationId, turnId);
    session.backend.turnFinished = true;
    session.backend.success = success;
    session.backend.reason = reason || session.backend.reason;
  }

  // ── interrupt ───────────────────────────────────────────────────

  /**
   * Mark the active session as interrupted.
   *
   * Per the design spec:
   *   - Does NOT create a new session
   *   - Marks interrupted = true, backend.reason = "interrupted", phase = "failed"
   *   - Falls back to ensureSession if no active session
   */
  function markInterrupt(
    orchestrationId: string | null,
    turnId: string | null,
  ): void {
    // Interrupt must not create a new session — only operate on the active one
    const session = getActiveSession();
    if (!session) {
      return;
    }
    session.interrupted = true;
    session.backend.reason = session.backend.reason || "interrupted";
    markPhaseInternal(session, "failed");
    log("session interrupted", {
      id: session.id,
      activeSessionId: state.activeSessionId,
    });
  }

  // ── phase ───────────────────────────────────────────────────────

  function markPhaseInternal(
    session: TurnPlaybackSession,
    phase: TurnPlaybackPhase,
  ): boolean {
    if (session.phase === phase) {
      return true; // idempotent
    }
    if (!isValidPhaseTransition(session.phase, phase)) {
      console.warn(
        `[TurnPlaybackSessionStore] illegal phase transition: ${session.phase} -> ${phase}`,
        { sessionId: session.id },
      );
      return false;
    }
    session.phase = phase;
    return true;
  }

  function markPhase(
    orchestrationId: string | null,
    turnId: string | null,
    phase: TurnPlaybackPhase,
  ): boolean {
    const session = ensureSession(orchestrationId, turnId);
    return markPhaseInternal(session, phase);
  }

  // ── finalize / prune ─────────────────────────────────────────────

  /**
   * Attempt to finalize the session — transition to "completed"
   * if the internal state warrants it.
   *
   * The caller (completion coordinator) is still responsible for
   * deciding *when* to call this.  This function only enforces
   * the phase transition rules.
   */
  function finalizeSession(
    orchestrationId: string | null,
    turnId: string | null,
  ): boolean {
    const session = ensureSession(orchestrationId, turnId);
    return markPhaseInternal(session, "completed");
  }

  /**
   * Remove sessions that have reached a terminal phase,
   * keeping only the active session plus a configurable number
   * of recent terminal sessions for debugging.
   */
  function pruneSessions(keepRecent = 3): void {
    const terminalSessions: TurnPlaybackSession[] = [];
    const toDelete: string[] = [];

    for (const [id, session] of state.sessions) {
      if (session.phase === "completed" || session.phase === "failed") {
        if (id === state.activeSessionId) {
          continue;
        }
        terminalSessions.push(session);
      }
    }

    // Keep the most recent terminal sessions (sorted by id stability —
    // ephemeral serials increase, orch/turn ids are stable).
    // A simple approach: drop oldest first.
    const deleteCount = Math.max(0, terminalSessions.length - keepRecent);
    for (let i = 0; i < deleteCount; i++) {
      const session = terminalSessions[i];
      toDelete.push(session.id);
    }

    for (const id of toDelete) {
      state.sessions.delete(id);
    }

    if (toDelete.length > 0) {
      log("pruned sessions", { deleted: toDelete.length, remaining: state.sessions.size });
    }
  }

  // ── public API ──────────────────────────────────────────────────

  return {
    state: readonly(state),
    ensureSession,
    getSession,
    getSessionById,
    getSessions,
    getActiveSession,
    setActiveSession,
    markTextReceived,
    markTextReleased,
    markTextDelivered,
    markAudioReceived,
    markAudioStarted,
    markAudioTerminal,
    markMotionReceived,
    markMotionAbsent,
    markMotionReleased,
    markMotionStarted,
    markMotionCompleted,
    markTurnStarted,
    markTurnFinished,
    markInterrupt,
    markPhase,
    finalizeSession,
    pruneSessions,
  };
}
