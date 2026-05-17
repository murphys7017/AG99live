import type { DesktopHistoryEntry } from "../types/desktop";
import type {
  DirectParameterPlanTiming,
  ModelSummary,
  MotionPlanPayload,
  SemanticMotionIntent,
  SemanticParameterPlan,
} from "../types/protocol";
import type { ModelEngineSettings } from "./settings";

export type ModelEngineStatus =
  | "idle"
  | "pending"
  | "compiling"
  | "playing"
  | "failed";

export type NormalizedMotionPayload =
  | { kind: "semantic_intent"; intent: SemanticMotionIntent }
  | { kind: "semantic_plan"; plan: SemanticParameterPlan };

export interface MotionTimingResolution {
  timing: DirectParameterPlanTiming;
  resolvedDurationMs: number;
  timingSource: "hint" | "audio_sync" | "default";
}

export interface SupplementaryBuildDiagnostics {
  usedActionLibrary: boolean;
  selectedFrom: "parameter_action_library" | "base_action_library" | "none";
}

export interface SupplementaryBuildResult {
  params: { parameter_id: string; target_value: number; weight: number; source_atom_id: string; channel: string }[];
  diagnostics: SupplementaryBuildDiagnostics;
}

export interface CompileOptions {
  model: ModelSummary;
  targetDurationMs?: number | null;
  source?: string;
  settings?: ModelEngineSettings;
}

export interface CompileDiagnostics {
  usedActionLibrary: boolean;
  compiledParameterCount: number;
  timingSource: "hint" | "audio_sync" | "default";
  resolvedMode: "idle" | "expressive";
  source?: string;
  warnings?: string[];
  primaryAxes?: string[];
  hintAxes?: string[];
  derivedAxes?: string[];
  runtimeAxes?: string[];
  missingAxes?: string[];
  forbiddenAxes?: string[];
  invalidAxes?: string[];
  axisErrorCount?: number;
  axisErrorLimit?: number;
  compiledParameters?: string[];
  intensityApplied: boolean;
  motionIntensityScale: number;
  axisIntensityScale: Record<string, number>;
}

export interface CompileResult {
  ok: boolean;
  plan: MotionPlanPayload | null;
  reason: string;
  diagnostics: CompileDiagnostics;
}

export interface InboundPayloadContext {
  messageId: string;
  turnId: string | null;
  playbackTurnId?: string | null;
  receivedAtMs: number;
}

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

export interface ModelEngineDependencies
  extends MotionRuntimeSchedulerDependencies, MotionStartDependencies {
  stopPlan: (reason?: string) => void;
  pushHistory?: (
    role: ModelEngineHistoryRole,
    text: string,
  ) => void;
}
