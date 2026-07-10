import type {
  DirectParameterPlanTiming,
  ModelSummary,
  MotionPlanPayload,
} from "../../types/protocol.js";
import type { ModelEngineSettings } from "../settings.js";

export interface MotionTimingResolution {
  timing: DirectParameterPlanTiming;
  resolvedDurationMs: number;
  timingSource: "hint" | "audio_sync" | "default";
  performanceCurveFamily?: string;
  performanceCurvePreset?: string;
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
  speechActive?: boolean;
  source?: string;
  settings?: Partial<ModelEngineSettings>;
  runtimeWarnings?: readonly string[];
}

export interface CompileDiagnostics {
  usedActionLibrary: boolean;
  compiledParameterCount: number;
  timingSource: "hint" | "audio_sync" | "default";
  resolvedMode: "idle" | "expressive";
  speechActive?: boolean;
  source?: string;
  warnings?: string[];
  primaryAxes?: string[];
  hintAxes?: string[];
  derivedAxes?: string[];
  availableDerivedAxes?: string[];
  appliedDerivedAxes?: string[];
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
  activeGroups?: string[];
  skeletonGroups?: string[];
  missingSkeletonGroups?: string[];
  maxDeltaFromNeutral?: number;
  neutralishAxisCount?: number;
  expressiveAxisCount?: number;
  semanticAxisCount?: number;
  couplingSkippedExplicitTargets?: string[];
}

export interface CompileResult {
  ok: boolean;
  plan: MotionPlanPayload | null;
  reason: string;
  diagnostics: CompileDiagnostics;
}
