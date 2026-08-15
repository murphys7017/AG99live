import type { DesktopHistoryEntry } from "../../types/desktop.js";
import type {
  DirectParameterPlanTerminalEvent,
  MotionPlaybackStartResult,
} from "../../types/live2d-runtime.d.ts";
import type {
  CatalogMotionPayload,
  ModelSummary,
  MotionPlanPayload,
  SemanticMotionIntent,
} from "../../types/protocol.js";
import type {
  InboundPayloadContext,
  MotionPlaybackClockReader,
} from "../contracts.js";
import type { NormalizedMotionPayload } from "../../types/motion.js";
import type {
  CompileDiagnostics,
  CompiledSemanticMotion,
} from "../../types/compiledSemanticMotion.js";
import type { MotionFeedback } from "../compiler/contracts.js";
import type { ModelEngineSettings } from "../settings.js";
import type { ModelEngineStageRegistry } from "../compiler/registry.js";
import type { SpeechOnlyMotionRequest } from "./speechOnlyMotion.js";

export type ModelEngineStatus =
  | "idle"
  | "pending"
  | "compiling"
  | "playing"
  | "failed";

export type ModelEnginePlaybackOrigin = "conversation" | "manual_preview";

export interface ModelEngineActivePlaybackRun {
  runId: string;
  origin: ModelEnginePlaybackOrigin;
  turnId: string | null;
  messageId: string;
  payloadKind: NormalizedMotionPayload["kind"] | "speech_only" | "compiled_semantic_motion";
}

export type ModelEnginePlaybackTerminalEvent = DirectParameterPlanTerminalEvent;

export interface PlayPlanOptions {
  playbackClockReader?: MotionPlaybackClockReader | null;
  requiresPlaybackClock?: boolean;
  onStarted: (plan: MotionPlanPayload, runId: string) => void;
  onFinished?: (event: DirectParameterPlanTerminalEvent) => void;
}

export interface PlayCatalogMotionOptions {
  playbackClockReader?: MotionPlaybackClockReader | null;
  requiresPlaybackClock?: boolean;
  onStarted: (motion: CatalogMotionPayload, runId: string) => void;
  onFinished?: (event: DirectParameterPlanTerminalEvent) => void;
}

interface ModelEnginePlanStartedEventBase {
  model: ModelSummary | null;
  messageId: string;
  turnId: string | null;
  playbackTurnId: string | null;
  playbackOrigin: ModelEnginePlaybackOrigin;
  startReason: string;
  queuedDelayMs: number;
  payloadKind: NormalizedMotionPayload["kind"] | "speech_only" | "compiled_semantic_motion";
  diagnostics: CompileDiagnostics | null;
  playerMessage: string;
  /** SDK 分配给本次动作计划的唯一 runId，用于完成事件归属校验。 */
  runId: string;
}

export type ModelEnginePlanStartedEvent =
  | (ModelEnginePlanStartedEventBase & {
    payloadKind: "compiled_semantic_motion";
    executionKind: "parameter_plan";
    semanticMotion: CompiledSemanticMotion;
    plan: MotionPlanPayload;
    motion?: null;
  })
  | (ModelEnginePlanStartedEventBase & {
    payloadKind: "semantic_intent";
    executionKind: "parameter_plan";
    intent: SemanticMotionIntent;
    semanticMotion: CompiledSemanticMotion;
    plan: MotionPlanPayload;
    motion?: null;
  })
  | (ModelEnginePlanStartedEventBase & {
    payloadKind: "semantic_intent";
    executionKind: "motion_resource";
    intent: SemanticMotionIntent;
    motion: CatalogMotionPayload;
    plan?: null;
    semanticMotion?: null;
  })
  | (ModelEnginePlanStartedEventBase & {
    payloadKind: "speech_only";
    executionKind: "parameter_plan";
    request: SpeechOnlyMotionRequest;
    semanticMotion: CompiledSemanticMotion;
    plan: MotionPlanPayload;
    motion?: null;
  })
  | (ModelEnginePlanStartedEventBase & {
    payloadKind: "catalog_motion";
    executionKind: "catalog_motion";
    motion: CatalogMotionPayload;
    plan?: null;
  });

export type ModelEngineHistoryRole =
  Extract<DesktopHistoryEntry["role"], "system" | "error">;

export interface MotionStartDependencies {
  getSelectedModel: () => ModelSummary | null;
  getSettings: () => Partial<ModelEngineSettings>;
  playPlan: (
    plan: unknown,
    model: ModelSummary | null,
    options: PlayPlanOptions,
  ) => MotionPlaybackStartResult;
  playCatalogMotion: (
    motion: CatalogMotionPayload,
    model: ModelSummary | null,
    options: PlayCatalogMotionOptions,
  ) => MotionPlaybackStartResult;
  getPlayerMessage?: () => string;
  onPlanStarted: (event: ModelEnginePlanStartedEvent) => void;
  onMotionRejected: (event: {
    turnId: string;
    messageId: string;
    reason: string;
  }) => void;
  onCompileFailed?: (event: ModelEngineCompileFailedEvent) => void;
  stageRegistry?: ModelEngineStageRegistry;
}

interface ModelEngineCompileFailedEventBase {
  model: ModelSummary | null;
  messageId: string;
  turnId: string | null;
  playbackTurnId: string | null;
  playbackOrigin: ModelEnginePlaybackOrigin;
  startReason: string;
  queuedDelayMs: number;
  reason: string;
  diagnostics: CompileDiagnostics;
  feedback: MotionFeedback | null;
}

export type ModelEngineCompileFailedEvent =
  | (ModelEngineCompileFailedEventBase & {
    payloadKind: "semantic_intent";
    intent: SemanticMotionIntent;
  })
  | (ModelEngineCompileFailedEventBase & {
    payloadKind: "speech_only";
    request: SpeechOnlyMotionRequest;
  });

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

export interface ModelEngineDependencies extends MotionStartDependencies {
  stopPlan: (reason?: string) => void;
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
