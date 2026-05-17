import type { DesktopHistoryEntry } from "../../types/desktop.js";
import type {
  ModelSummary,
  MotionPlanPayload,
} from "../../types/protocol.js";
import type {
  InboundPayloadContext,
  NormalizedMotionPayload,
} from "../contracts.js";
import type {
  CompileDiagnostics,
} from "../compiler/contracts.js";
import type { ModelEngineSettings } from "../settings.js";

export type ModelEngineStatus =
  | "idle"
  | "pending"
  | "compiling"
  | "playing"
  | "failed";

export interface PlayPlanOptions {
  softHandoff?: boolean;
  targetDurationMs?: number | null;
  onStarted?: (plan: MotionPlanPayload) => void;
}

export interface ModelEnginePlanStartedEvent {
  plan: MotionPlanPayload;
  model: ModelSummary | null;
  messageId: string;
  turnId: string | null;
  playbackTurnId: string | null;
  startReason: string;
  queuedDelayMs: number;
  payloadKind: NormalizedMotionPayload["kind"];
  diagnostics: CompileDiagnostics | null;
  playerMessage: string;
}

export type ModelEngineHistoryRole =
  Extract<DesktopHistoryEntry["role"], "system" | "error">;

export interface ModelEnginePlaybackSegment {
  messageId: string;
  turnId: string | null;
  audio: {
    released: boolean;
    started: boolean;
    startedAtMs: number | null;
    durationMs: number | null;
  };
}

export interface ModelEnginePlaybackSession {
  id: string;
  turnId: string | null;
  segmentOrder: string[];
  segments: Map<string, ModelEnginePlaybackSegment>;
}

export interface ModelEngineSessionStorePort {
  getActiveSession: () => ModelEnginePlaybackSession | undefined;
  getSessionById?: (
    playbackSessionId: string | null,
  ) => ModelEnginePlaybackSession | undefined;
}

export interface MotionRuntimeSchedulerDependencies {
  getCurrentTurnId: () => string | null;
  sessionStore?: ModelEngineSessionStorePort;
}

export interface MotionStartDependencies {
  getSelectedModel: () => ModelSummary | null;
  getSettings: () => ModelEngineSettings;
  playPlan: (
    plan: unknown,
    model: ModelSummary | null,
    options: PlayPlanOptions,
  ) => boolean;
  getPlayerMessage?: () => string;
  onPlanStarted?: (event: ModelEnginePlanStartedEvent) => void;
}

export interface MotionRuntimeStateController {
  setState: (
    status: ModelEngineStatus,
    message: string,
    diagnostics?: CompileDiagnostics | null,
  ) => void;
  setLastCompileReason: (reason: string) => void;
  setLastCompileDiagnostics: (diagnostics: CompileDiagnostics | null) => void;
  setLastStartReason: (reason: string) => void;
  pushHistory: (
    role: ModelEngineHistoryRole,
    text: string,
  ) => void;
}

export interface ModelEngineDependencies
  extends MotionRuntimeSchedulerDependencies, MotionStartDependencies {
  stopPlan: (reason?: string) => void;
  pushHistory?: (
    role: ModelEngineHistoryRole,
    text: string,
  ) => void;
}

export type { InboundPayloadContext };
