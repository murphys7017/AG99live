import type { DeepReadonly } from "vue";
import type {
  AudioTerminalState,
  OutputSegmentCommitResult,
  OutputSegmentMaterial,
  OutputSegmentMotionMaterial,
  TurnPlaybackPhase,
  TurnPlaybackSegment,
  TurnPlaybackSession,
} from "./session.js";
import type {
  IncrementalIdentity,
  IncrementalResource,
  IncrementalStatus,
} from "./incrementalSegments.js";

/** Explicit cross-layer contract for the canonical Turn/Segment owner. */
export interface TurnPlaybackSessionPort {
  ensureSession(turnId?: string | null): TurnPlaybackSession;
  getSession(turnId: string | null): DeepReadonly<TurnPlaybackSession> | undefined;
  getSessionById(sessionId: string | null): DeepReadonly<TurnPlaybackSession> | undefined;
  getSessions(): readonly DeepReadonly<TurnPlaybackSession>[];
  getActiveSession(): DeepReadonly<TurnPlaybackSession> | undefined;
  getSegment(
    turnId: string | null,
    messageId: string,
  ): DeepReadonly<TurnPlaybackSegment> | undefined;
  getActiveSegment(sessionId: string | null): DeepReadonly<TurnPlaybackSegment> | null;
  getUnsettledSegments(): readonly DeepReadonly<TurnPlaybackSegment>[];
  setActiveSession(turnId?: string | null): void;
  commitOutputSegment(
    turnId: string | null,
    messageId: string,
    material: OutputSegmentMaterial,
  ): OutputSegmentCommitResult;
  resolveDeferredMotion(
    turnId: string,
    messageId: string,
    material: Exclude<OutputSegmentMotionMaterial, { state: "pending" }>,
  ): void;
  assertOutputSegmentsResolved(turnId: string | null): void;
  markTextDelivered(turnId: string | null, messageId: string): void;
  markTextFailed(turnId: string | null, messageId: string, reason: string): void;
  markAudioReleased(turnId: string | null, messageId: string): void;
  markAudioStarted(
    turnId: string | null,
    messageId: string,
    startedAtMs?: number | null,
    durationMs?: number | null,
  ): void;
  markAudioDuration(turnId: string | null, messageId: string, durationMs: number | null): void;
  markAudioTerminal(
    turnId: string | null,
    terminal: Exclude<AudioTerminalState, "idle">,
    messageId: string,
    reason?: string,
  ): void;
  markMotionAbsent(turnId: string | null, messageId: string, reason?: string): void;
  markMotionReleased(turnId: string | null, messageId: string): void;
  markMotionStarted(turnId: string | null, messageId: string): void;
  markMotionCompleted(turnId: string | null, messageId: string): void;
  markMotionFailed(turnId: string | null, messageId: string, reason?: string): void;
  markTurnStarted(turnId: string): void;
  markSynthFinished(turnId: string | null, success: boolean, reason: string): void;
  markTurnFinished(turnId: string | null, success: boolean, reason?: string): boolean;
  markInterrupt(turnId: string | null): boolean;
  markSessionFailed(turnId: string | null, reason: string): boolean;
  markPhase(turnId: string | null, phase: TurnPlaybackPhase): boolean;
  startIncrementalStream(resource: IncrementalResource, id: IncrementalIdentity): void;
  appendIncrementalText(id: IncrementalIdentity, text: string): string;
  updateIncrementalMotion(id: IncrementalIdentity, payload: unknown): void;
  acceptIncrementalAudio(id: IncrementalIdentity, offset: number, byteLength: number): void;
  endIncrementalStream(
    resource: IncrementalResource,
    id: IncrementalIdentity,
    status: IncrementalStatus,
    reason: string,
    length?: number,
  ): void;
}
