import { reactive, readonly } from "vue";
import type {
  TurnPlaybackSession,
  TurnPlaybackPhase,
  TextReceiveMode,
  AudioTerminalState,
  TurnPlaybackSegment,
} from "../turn-playback/session.js";
import {
  createTurnPlaybackSession,
  createTurnPlaybackSegment,
  resolveSessionId,
  isValidPhaseTransition,
  isSegmentLocallySettled,
} from "../turn-playback/session.js";
import { getActivePlaybackSegment } from "../turn-playback/selectors.js";
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

  function normalizeRequiredMessageId(messageId: string): string {
    const normalized = messageId.trim();
    if (!normalized) {
      throw new Error("Turn playback segment requires a non-empty messageId.");
    }
    return normalized;
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

    const turnOnlyKey = resolveSessionId(null, turnId);
    if (orchestrationId && turnOnlyKey && turnOnlyKey !== key) {
      const turnOnlySession = state.sessions.get(turnOnlyKey);
      if (turnOnlySession) {
        state.sessions.delete(turnOnlyKey);
        turnOnlySession.id = key;
        state.sessions.set(key, turnOnlySession);
        if (state.activeSessionId === turnOnlyKey) {
          state.activeSessionId = key;
        }
        for (const segment of turnOnlySession.segments.values()) {
          segment.orchestrationId = segment.orchestrationId ?? orchestrationId;
        }
        log("session promoted to orchestration id", {
          previousId: turnOnlyKey,
          id: key,
          orchestrationId,
          turnId,
        });
        return turnOnlySession;
      }
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

  // ── segments ────────────────────────────────────────────────────

  function ensureSegment(
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
  ): TurnPlaybackSegment {
    const session = ensureSession(orchestrationId, turnId);
    return ensureSegmentForSession(session, orchestrationId, turnId, messageId);
  }

  function ensureSegmentForSession(
    session: TurnPlaybackSession,
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
  ): TurnPlaybackSegment {
    const segmentId = normalizeRequiredMessageId(messageId);
    const existing = session.segments.get(segmentId);
    if (existing) {
      if (!existing.turnId && turnId) {
        existing.turnId = turnId;
      }
      if (!existing.orchestrationId && orchestrationId) {
        existing.orchestrationId = orchestrationId;
      }
      return existing;
    }

    const segment = createTurnPlaybackSegment(segmentId, orchestrationId, turnId);
    session.segments.set(segmentId, segment);
    session.segmentOrder.push(segmentId);
    log("segment created", {
      sessionId: session.id,
      messageId: segmentId,
      orchestrationId,
      turnId,
    });
    return segment;
  }

  function getSegmentSession(
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
  ): { session: TurnPlaybackSession; segment: TurnPlaybackSegment } {
    const session = ensureSession(orchestrationId, turnId);
    const segment = ensureSegmentForSession(session, orchestrationId, turnId, messageId);
    return { session, segment };
  }

  function getSegment(
    sessionId: string | null,
    messageId: string,
  ): TurnPlaybackSegment | undefined {
    const segmentId = normalizeRequiredMessageId(messageId);
    return getSessionById(sessionId)?.segments.get(segmentId);
  }

  function getUnsettledSegments(): TurnPlaybackSegment[] {
    const unsettled: TurnPlaybackSegment[] = [];
    for (const session of state.sessions.values()) {
      for (const segmentId of session.segmentOrder) {
        const segment = session.segments.get(segmentId);
        if (segment && !isSegmentLocallySettled(segment)) {
          unsettled.push(segment);
        }
      }
    }
    return unsettled;
  }

  function isSegmentSettled(sessionId: string | null, messageId: string): boolean {
    const segment = getSegment(sessionId, messageId);
    return Boolean(segment && isSegmentLocallySettled(segment));
  }

  function getActiveSegment(sessionId: string | null): TurnPlaybackSegment | null {
    const session = getSessionById(sessionId);
    return session ? getActivePlaybackSegment(session) : null;
  }

  // ── text ────────────────────────────────────────────────────────

  function markTextReceived(
    orchestrationId: string | null,
    turnId: string | null,
    text: string,
    messageId: string,
    mode: TextReceiveMode = "replace",
  ): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const { session, segment } = getSegmentSession(orchestrationId, turnId, messageId);
    if (mode === "append" && segment.text.content) {
      segment.text.content = segment.text.content + trimmed;
    } else {
      segment.text.content = trimmed;
    }
    segment.text.receiveMode = mode;
    segment.text.receivedAtMs = performance.now();
    if (!session.backend.turnStarted) {
      session.backend.turnStarted = true;
    }
  }

  function markTextReleased(
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(orchestrationId, turnId, messageId);
    segment.text.released = true;
  }

  function markTextDelivered(
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(orchestrationId, turnId, messageId);
    segment.text.delivered = true;
    segment.text.released = true; // delivery implies release
  }

  // ── audio ───────────────────────────────────────────────────────

  function markAudioReceived(
    orchestrationId: string | null,
    turnId: string | null,
    url: string,
    messageId: string,
  ): void {
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }
    const { segment } = getSegmentSession(orchestrationId, turnId, messageId);
    segment.audio.url = trimmed;
    segment.audio.receivedAtMs = performance.now();
    segment.audio.released = false;
    segment.audio.terminal = "idle";
    segment.audio.reason = "";
    segment.audio.started = false;
    segment.audio.startedAtMs = null;
    segment.audio.durationMs = null;
  }

  function markAudioStarted(
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
    startedAtMs?: number | null,
    durationMs?: number | null,
  ): void {
    const { segment } = getSegmentSession(orchestrationId, turnId, messageId);
    segment.audio.released = true;
    segment.audio.started = true;
    segment.audio.startedAtMs =
      typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
        ? startedAtMs
        : performance.now();
    segment.audio.durationMs =
      typeof durationMs === "number" && Number.isFinite(durationMs)
        ? durationMs
        : null;
  }

  function markAudioTerminal(
    orchestrationId: string | null,
    turnId: string | null,
    terminal: Exclude<AudioTerminalState, "idle">,
    messageId: string,
    reason = "",
  ): void {
    const { segment } = getSegmentSession(orchestrationId, turnId, messageId);
    segment.audio.released = true;
    segment.audio.terminal = terminal;
    segment.audio.reason = reason || segment.audio.reason;
  }

  function markAudioReleased(
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(orchestrationId, turnId, messageId);
    segment.audio.released = true;
  }

  // ── motion ──────────────────────────────────────────────────────

  function markMotionReceived(
    orchestrationId: string | null,
    turnId: string | null,
    payload: NormalizedMotionPayload,
    messageId: string,
  ): void {
    if (!payload) {
      return;
    }
    const { segment } = getSegmentSession(orchestrationId, turnId, messageId);
    segment.motion.payload = payload;
    segment.motion.receivedAtMs = performance.now();
    segment.motion.absent = false;
    segment.motion.released = false;
    segment.motion.started = false;
    segment.motion.completed = false;
  }

  function markMotionAbsent(
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(orchestrationId, turnId, messageId);
    segment.motion.payload = null;
    segment.motion.receivedAtMs = null;
    segment.motion.absent = true;
    segment.motion.released = false;
    segment.motion.started = false;
    segment.motion.completed = true;
  }

  function markMotionReleased(
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(orchestrationId, turnId, messageId);
    segment.motion.absent = false;
    segment.motion.released = true;
  }

  function markMotionStarted(
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(orchestrationId, turnId, messageId);
    segment.motion.absent = false;
    segment.motion.released = true;
    segment.motion.started = true;
  }

  function markMotionCompleted(
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(orchestrationId, turnId, messageId);
    segment.motion.absent = false;
    segment.motion.released = true;
    segment.motion.completed = true;
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
    ensureSegment,
    getSession,
    getSessionById,
    getSegment,
    getActiveSegment,
    getUnsettledSegments,
    isSegmentSettled,
    getSessions,
    getActiveSession,
    setActiveSession,
    markTextReceived,
    markTextReleased,
    markTextDelivered,
    markAudioReceived,
    markAudioReleased,
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
