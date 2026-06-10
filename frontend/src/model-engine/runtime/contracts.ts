import type { DesktopHistoryEntry } from "../../types/desktop.js";
import type {
  CatalogMotionPayload,
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

interface ModelEnginePlanStartedEventBase {
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

export type ModelEnginePlanStartedEvent =
  | (ModelEnginePlanStartedEventBase & {
    payloadKind: "semantic_intent" | "semantic_plan";
    plan: MotionPlanPayload;
    motion?: null;
  })
  | (ModelEnginePlanStartedEventBase & {
    payloadKind: "catalog_motion";
    motion: CatalogMotionPayload;
    plan?: null;
  });

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
    terminal: "idle" | "completed" | "failed" | "absent";
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
  getSessionByTurnId?: (
    turnId: string | null,
  ) => ModelEnginePlaybackSession | undefined;
  markMotionAbsent?: (
    turnId: string | null,
    messageId: string,
  ) => void;
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
  playCatalogMotion: (
    motion: CatalogMotionPayload,
    model: ModelSummary | null,
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
