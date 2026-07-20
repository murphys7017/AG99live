import type {
  DirectParameterPlanTiming,
  ModelSummary,
  MotionAxisLevelMap,
  MotionAxisLevelStep,
  MotionPlanPayload,
} from "../../types/protocol.js";
import type { ModelEngineSettings } from "../settings.js";

export const SEMANTIC_MOTION_TRANSFORM_VERSION = "semantic_motion_transform.v4";

export type MotionAxisValueSource =
  | "semantic_axis"
  | "coupling"
  | "speech_pose"
  | "expression"
  | "continuity";

export type CompiledSemanticAxisSource = Extract<
  MotionAxisValueSource,
  "semantic_axis" | "coupling"
>;

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
  samplingIdentity?: {
    turnId: string;
    messageId: string;
  };
  allowNeutralAxisPose?: boolean;
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
  activeGroups?: string[];
  skeletonGroups?: string[];
  missingSkeletonGroups?: string[];
  maxDeltaFromNeutral?: number;
  neutralishAxisCount?: number;
  expressiveAxisCount?: number;
  semanticAxisCount?: number;
  couplingSkippedExplicitTargets?: string[];
  relationAdjustments?: MotionAxisRelationAdjustment[];
  relationEvaluations?: MotionAxisRelationEvaluation[];
  transformTrace?: MotionTransformTrace;
}

export interface MotionAxisRelationAdjustment {
  ruleId: string;
  sourceAxisId?: string;
  targetAxisId: string;
  before: number;
  after: number;
  reason: string;
}

export interface MotionAxisRelationEvaluation {
  ruleId: string;
  kind: "axis_range" | "derive" | "bounded_ratio";
  status: "within_limit" | "derived" | "constrained" | "skipped";
  sourceAxisId?: string;
  targetAxisId: string;
  sourceValue?: number;
  targetBefore?: number;
  targetAfter?: number;
  limit?: number;
  reason: string;
}

export interface MotionTransformTrace {
  transformVersion: typeof SEMANTIC_MOTION_TRANSFORM_VERSION;
  profileRevision: number;
  profileHash: string;
  rawAxes: Record<string, number>;
  rawAxisLevels?: MotionAxisLevelMap;
  rawMotionSteps?: MotionAxisLevelStep[];
  axisSampling?: MotionAxisSamplingTrace;
  expressionResourceId?: string;
  motionResourceId?: string;
  resolvedResource?: {
    resourceId: string;
    resourceType: "expression" | "motion";
    parameterIds: string[];
  };
  resolvedAxes: Record<string, number>;
  derivedAxes: Record<string, number>;
  constrainedAxes: Record<string, number>;
  relationAdjustments: MotionAxisRelationAdjustment[];
  relationEvaluations: MotionAxisRelationEvaluation[];
  compiledParameters: string[];
  sequenceSteps?: Array<{
    index: number;
    durationWeight: number;
    resolvedAxes: Record<string, number>;
    constrainedAxes: Record<string, number>;
    axisSampling?: MotionAxisSamplingTrace;
  }>;
}

export interface MotionAxisSamplingTrace {
  seed: string;
  sharedRandom: number;
  perAxisRandom: Record<string, number>;
  sampledValues: Record<string, number>;
  sampleBounds: Record<string, { min: number; max: number }>;
}

export interface MotionFeedback {
  code: string;
  message: string;
  fields: string[];
}

export interface CompileResult {
  ok: boolean;
  plan: MotionPlanPayload | null;
  reason: string;
  diagnostics: CompileDiagnostics;
  feedback?: MotionFeedback;
}

export interface CompiledSemanticAxis {
  axisId: string;
  value: number;
  neutralValue: number;
  source: CompiledSemanticAxisSource;
}

export interface CompiledSemanticMotionStep {
  durationWeight: number;
  axes: CompiledSemanticAxis[];
  diagnostics: CompileDiagnostics;
}

interface CompiledSemanticMotionBase {
  schemaVersion: "engine.compiled_semantic_motion.v1";
  profileId: string;
  profileRevision: number;
  modelId: string;
  mode: "idle" | "expressive";
  emotionLabel: string;
  timing: MotionTimingResolution;
  diagnostics: CompileDiagnostics;
}

export type CompiledSemanticMotion = CompiledSemanticMotionBase & (
  | {
    kind: "pose";
    axes: CompiledSemanticAxis[];
  }
  | {
    kind: "sequence";
    steps: CompiledSemanticMotionStep[];
  }
);

export type CompileSemanticMotionResult =
  | {
    ok: true;
    motion: CompiledSemanticMotion;
    reason: "";
  }
  | {
    ok: false;
    motion: null;
    reason: string;
    diagnostics: CompileDiagnostics;
    feedback: MotionFeedback;
  };
