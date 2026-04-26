import type { DesktopHistoryEntry } from "../types/desktop";
import type {
  DirectParameterAxisName,
  DirectParameterPlan,
  DirectParameterPlanSupplementaryParam,
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

export interface MotionIntentAxisValue {
  value: number;
}

export interface MotionIntent {
  schema_version: "engine.motion_intent.v1";
  mode: "idle" | "expressive";
  emotion_label: string;
  duration_hint_ms?: number | null;
  key_axes: Record<DirectParameterAxisName, MotionIntentAxisValue>;
  summary?: {
    key_axes_count?: number;
  };
}

export type NormalizedMotionPayload =
  | { kind: "intent"; intent: MotionIntent }
  | { kind: "semantic_intent"; intent: SemanticMotionIntent }
  | { kind: "plan"; plan: DirectParameterPlan }
  | { kind: "semantic_plan"; plan: SemanticParameterPlan };

export interface MotionTimingResolution {
  timing: DirectParameterPlanTiming;
  resolvedDurationMs: number;
  timingSource: "hint" | "audio_sync" | "default";
}

export interface SupplementaryBuildDiagnostics {
  usedFallbackLibrary: boolean;
  selectedFrom: "parameter_action_library" | "base_action_library" | "none";
}

export interface SupplementaryBuildResult {
  params: DirectParameterPlanSupplementaryParam[];
  diagnostics: SupplementaryBuildDiagnostics;
}

export interface CompileOptions {
  model: ModelSummary;
  targetDurationMs?: number | null;
  source?: string;
  settings?: ModelEngineSettings;
}

export interface CompileDiagnostics {
  usedFallbackLibrary: boolean;
  supplementaryCount: number;
  timingSource: "hint" | "audio_sync" | "default";
  resolvedMode: DirectParameterPlan["mode"];
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
  axisIntensityScale: Record<DirectParameterAxisName, number>;
}

export interface CompileResult {
  ok: boolean;
  plan: MotionPlanPayload | null;
  reason: string;
  diagnostics: CompileDiagnostics;
}

export interface InboundPayloadContext {
  turnId: string | null;
  receivedAtMs: number;
}

export interface AudioPlaybackInfo {
  turnId: string | null;
  startedAtMs: number;
  durationMs: number | null;
}

export interface PlayPlanOptions {
  softHandoff?: boolean;
  targetDurationMs?: number | null;
  onStarted?: (plan: MotionPlanPayload) => void;
}

export interface ModelEnginePlanStartedEvent {
  plan: MotionPlanPayload;
  model: ModelSummary | null;
  turnId: string | null;
  startReason: string;
  queuedDelayMs: number;
  payloadKind: NormalizedMotionPayload["kind"];
  diagnostics: CompileDiagnostics | null;
  playerMessage: string;
}

export interface ModelEngineDependencies {
  getSelectedModel: () => ModelSummary | null;
  getSettings: () => ModelEngineSettings;
  playPlan: (
    plan: unknown,
    model: ModelSummary | null,
    options: PlayPlanOptions,
  ) => boolean;
  stopPlan: (reason?: string) => void;
  getCurrentTurnId: () => string | null;
  getAudioPlaybackInfo: () => AudioPlaybackInfo;
  pushHistory?: (
    role: Extract<DesktopHistoryEntry["role"], "system" | "error">,
    text: string,
  ) => void;
  getPlayerMessage?: () => string;
  onPlanStarted?: (event: ModelEnginePlanStartedEvent) => void;
}
