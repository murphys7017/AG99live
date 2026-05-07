import type { NormalizedMotionPayload } from "../model-engine/contracts.js";

// ── Phase ──────────────────────────────────────────────────────────

export type TurnPlaybackPhase =
  | "collecting"
  | "ready"
  | "playing"
  | "settling"
  | "completed"
  | "failed";

const VALID_PHASE_TRANSITIONS: Record<TurnPlaybackPhase, TurnPlaybackPhase[]> = {
  collecting: ["ready", "failed"],
  ready: ["playing", "failed"],
  playing: ["settling", "failed"],
  settling: ["completed", "failed"],
  completed: [],
  failed: [],
};

const TERMINAL_PHASES: ReadonlySet<TurnPlaybackPhase> = new Set([
  "completed",
  "failed",
]);

export function isTerminalPhase(phase: TurnPlaybackPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export function isValidPhaseTransition(
  from: TurnPlaybackPhase,
  to: TurnPlaybackPhase,
): boolean {
  if (isTerminalPhase(from)) {
    return false;
  }
  return VALID_PHASE_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Audio terminal ─────────────────────────────────────────────────

export type AudioTerminalState = "idle" | "completed" | "failed" | "absent";

// ── Text receive mode ──────────────────────────────────────────────

export type TextReceiveMode = "replace" | "append";

// ── Session sub-states ─────────────────────────────────────────────

export interface TurnPlaybackSessionText {
  content: string | null;
  receivedAtMs: number | null;
  receiveMode: TextReceiveMode;
  released: boolean;
  delivered: boolean;
}

export interface TurnPlaybackSessionAudio {
  url: string | null;
  receivedAtMs: number | null;
  started: boolean;
  startedAtMs: number | null;
  durationMs: number | null;
  terminal: AudioTerminalState;
  reason: string;
}

export interface TurnPlaybackSessionMotion {
  payload: NormalizedMotionPayload | null;
  receivedAtMs: number | null;
  started: boolean;
  completed: boolean;
}

export interface TurnPlaybackSessionBackend {
  turnStarted: boolean;
  turnFinished: boolean;
  success: boolean | null;
  reason: string;
}

export interface TurnPlaybackSession {
  id: string;
  turnId: string | null;
  interrupted: boolean;
  text: TurnPlaybackSessionText;
  audio: TurnPlaybackSessionAudio;
  motion: TurnPlaybackSessionMotion;
  backend: TurnPlaybackSessionBackend;
  phase: TurnPlaybackPhase;
}

// ── ID resolution ──────────────────────────────────────────────────

function normalizeId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve a stable session id from orchestrationId / turnId.
 *
 * Priority:
 *   1. orch:<orchestrationId>
 *   2. turn:<turnId>
 *   3. ""  (caller must supply an ephemeral id)
 */
export function resolveSessionId(
  orchestrationId: string | null,
  turnId: string | null,
): string {
  const normalizedOrch = normalizeId(orchestrationId);
  if (normalizedOrch) {
    return `orch:${normalizedOrch}`;
  }
  const normalizedTurn = normalizeId(turnId);
  if (normalizedTurn) {
    return `turn:${normalizedTurn}`;
  }
  return "";
}

/**
 * Derive the orchestrationId portion from a resolved session id.
 * Returns null for ephemeral or turn-only ids.
 */
export function orchestrationIdFromSessionId(sessionId: string): string | null {
  if (sessionId.startsWith("orch:")) {
    return sessionId.slice(5);
  }
  return null;
}

// ── Constructors ───────────────────────────────────────────────────

export function createTurnPlaybackSession(
  orchestrationId: string | null,
  turnId: string | null = null,
  id?: string,
): TurnPlaybackSession {
  const sessionId = id ?? resolveSessionId(orchestrationId, turnId);
  return {
    id: sessionId,
    turnId,
    interrupted: false,
    text: {
      content: null,
      receivedAtMs: null,
      receiveMode: "replace",
      released: false,
      delivered: false,
    },
    audio: {
      url: null,
      receivedAtMs: null,
      started: false,
      startedAtMs: null,
      durationMs: null,
      terminal: "idle",
      reason: "",
    },
    motion: {
      payload: null,
      receivedAtMs: null,
      started: false,
      completed: false,
    },
    backend: {
      turnStarted: false,
      turnFinished: false,
      success: null,
      reason: "",
    },
    phase: "collecting",
  };
}

// ── Utilities ──────────────────────────────────────────────────────

export function isSessionReadyForRelease(session: TurnPlaybackSession): boolean {
  return session.text.content !== null && session.phase !== "failed";
}

export function isSessionPlaybackComplete(session: TurnPlaybackSession): boolean {
  return session.phase === "completed";
}
