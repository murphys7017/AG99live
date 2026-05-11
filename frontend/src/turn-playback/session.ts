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
  released: boolean;
  started: boolean;
  startedAtMs: number | null;
  durationMs: number | null;
  terminal: AudioTerminalState;
  reason: string;
}

export interface TurnPlaybackSessionMotion {
  payload: NormalizedMotionPayload | null;
  receivedAtMs: number | null;
  released: boolean;
  started: boolean;
  completed: boolean;
  absent: boolean;
}

export interface TurnPlaybackSessionBackend {
  turnStarted: boolean;
  synthFinished: boolean;
  turnFinished: boolean;
  success: boolean | null;
  reason: string;
}

export interface TurnPlaybackSegment {
  id: string;
  messageId: string;
  turnId: string | null;
  orchestrationId: string | null;
  text: TurnPlaybackSessionText;
  audio: TurnPlaybackSessionAudio;
  motion: TurnPlaybackSessionMotion;
}

export interface TurnPlaybackSession {
  id: string;
  turnId: string | null;
  interrupted: boolean;
  segments: Map<string, TurnPlaybackSegment>;
  segmentOrder: string[];
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

export function createEmptyTextState(): TurnPlaybackSessionText {
  return {
    content: null,
    receivedAtMs: null,
    receiveMode: "replace",
    released: false,
    delivered: false,
  };
}

export function createEmptyAudioState(): TurnPlaybackSessionAudio {
  return {
    url: null,
    receivedAtMs: null,
    released: false,
    started: false,
    startedAtMs: null,
    durationMs: null,
    terminal: "idle",
    reason: "",
  };
}

export function createEmptyMotionState(): TurnPlaybackSessionMotion {
  return {
    payload: null,
    receivedAtMs: null,
    released: false,
    started: false,
    completed: false,
    absent: false,
  };
}

export function createTurnPlaybackSegment(
  messageId: string,
  orchestrationId: string | null,
  turnId: string | null,
): TurnPlaybackSegment {
  return {
    id: messageId,
    messageId,
    turnId,
    orchestrationId,
    text: createEmptyTextState(),
    audio: createEmptyAudioState(),
    motion: createEmptyMotionState(),
  };
}

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
    segments: new Map(),
    segmentOrder: [],
    backend: {
      turnStarted: false,
      synthFinished: false,
      turnFinished: false,
      success: null,
      reason: "",
    },
    phase: "collecting",
  };
}

// ── Utilities ──────────────────────────────────────────────────────

export function isSessionPlaybackComplete(session: TurnPlaybackSession): boolean {
  return session.phase === "completed";
}

export function isSegmentLocallySettled(segment: TurnPlaybackSegment): boolean {
  if (!segment.text.delivered) {
    return false;
  }
  const terminal = segment.audio.terminal;
  if (terminal !== "completed" && terminal !== "failed" && terminal !== "absent") {
    return false;
  }
  if (!segment.motion.absent && !segment.motion.completed) {
    return false;
  }
  return true;
}
