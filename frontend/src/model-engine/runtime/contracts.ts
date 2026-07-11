import type { DesktopHistoryEntry } from "../../types/desktop.js";
import type {
  CatalogMotionPayload,
  ModelSummary,
  MotionPlanPayload,
  SemanticMotionIntent,
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
  onStarted: (plan: MotionPlanPayload, runId: string) => void;
  onFinished?: (event: { runId: string; status: string; reason?: string }) => void;
}

export interface PlayCatalogMotionOptions {
  onStarted: (motion: CatalogMotionPayload, runId: string) => void;
  onFinished?: (event: { runId: string; status: string; reason?: string }) => void;
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
  /** SDK 分配给本次动作计划的唯一 runId，用于完成事件归属校验。 */
  runId: string;
}

export type ModelEnginePlanStartedEvent =
  | (ModelEnginePlanStartedEventBase & {
    payloadKind: "semantic_intent";
    intent: SemanticMotionIntent;
    plan: MotionPlanPayload;
    motion?: null;
  })
  | (ModelEnginePlanStartedEventBase & {
    payloadKind: "semantic_plan";
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
  markMotionFailed?: (
    turnId: string | null,
    messageId: string,
    reason?: string,
  ) => void;
}

export interface MotionRuntimeSchedulerDependencies {
  getCurrentTurnId: () => string | null;
  sessionStore?: ModelEngineSessionStorePort;
}

export interface MotionStartDependencies {
  getSelectedModel: () => ModelSummary | null;
  getSettings: () => Partial<ModelEngineSettings>;
  playPlan: (
    plan: unknown,
    model: ModelSummary | null,
    options: PlayPlanOptions,
  ) => boolean;
  playCatalogMotion: (
    motion: CatalogMotionPayload,
    model: ModelSummary | null,
    options: PlayCatalogMotionOptions,
  ) => boolean;
  getPlayerMessage?: () => string;
  onPlanStarted: (event: ModelEnginePlanStartedEvent) => void;
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
  markMotionTimelineTerminal: (
    turnId: string | null,
    messageId: string,
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ) => void;
  canStartSpeechOnlyMotion: (
    turnId: string | null,
    messageId: string,
  ) => boolean;
  pushHistory?: (
    role: ModelEngineHistoryRole,
    text: string,
  ) => void;
}

export type { InboundPayloadContext };
