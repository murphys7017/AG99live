import type {
  DirectParameterPlanTiming,
  MotionAxisLevelMap,
  MotionAxisLevelStep,
  PerformanceCurveHint,
} from "./protocol.js";

export const SEMANTIC_MOTION_TRANSFORM_VERSION = "semantic_motion_transform.v5";
export const PERFORMANCE_SCHEDULE_TRACE_VERSION = "performance_schedule_trace.v7";

export type CompiledSemanticAxisSource = "semantic_axis" | "relation_graph";

export interface MotionTimingResolution {
  timing: DirectParameterPlanTiming;
  resolvedDurationMs: number;
  timingSource: "hint" | "audio_sync" | "default";
  performanceCurveFamily?: string;
  performanceCurvePreset?: string;
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
  forbiddenAxes?: string[];
  invalidAxes?: string[];
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
  failureStage?: string;
  relationSkippedExplicitTargets?: string[];
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
  candidateValue?: number;
  targetBefore?: number;
  targetAfter?: number;
  limit?: number;
  constraintReasons?: string[];
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
  performanceSchedule?: PerformanceScheduleTrace;
  sequenceSteps?: Array<{
    index: number;
    durationWeight: number;
    resolvedAxes: Record<string, number>;
    constrainedAxes: Record<string, number>;
    axisSampling?: MotionAxisSamplingTrace;
  }>;
}

export interface PerformanceScheduleTrace {
  version: typeof PERFORMANCE_SCHEDULE_TRACE_VERSION;
  durationMs: number;
  textSource: "assistant_text" | "duration_only";
  phrases: Array<{
    index: number;
    sourcePhraseIndex: number;
    text: string;
    boundary: "strong" | "soft" | "none";
    weight: number;
    emphasis: number;
    startRatio: number;
    endRatio: number;
  }>;
  semanticSteps: Array<{
    index: number;
    durationWeight: number;
    startMs: number;
    endMs: number;
    startRatio: number;
    endRatio: number;
  }>;
  estimatedAlignments: Array<{
    kind: "estimated_time_overlap";
    phraseIndex: number;
    stepIndex: number;
    overlapRatio: number;
    phraseCoverageRatio: number;
    stepCoverageRatio: number;
    primaryForPhrase: boolean;
  }>;
  speechCueMappings: Array<{
    cueIndex: number;
    kind: "breath" | "sigh" | "laugh" | "chuckle" | "hesitate" | "emphasis";
    sourcePhraseIndex: number;
    position: "before" | "after";
    targetPhraseIndices: number[];
    status: "mapped" | "ignored";
    reason: string;
  }>;
  decisions: string[];
  events: PerformanceTimingEventTrace[];
  parameterNodes: PerformanceParameterNodeTrace[];
}

export interface PerformanceTimingEventTrace {
  id: string;
  kind:
    | "semantic_transition"
    | "speech_start"
    | "speech_phrase"
    | "speech_release"
    | "gaze_lead"
    | "gaze_dwell"
    | "gaze_transfer"
    | "gaze_release"
    | "face_enter"
    | "face_settle"
    | "face_transfer"
    | "face_release"
    | "hesitation_hold"
    | "hesitation_resume";
  source:
    | "semantic_step"
    | "speech_track"
    | "speech_phrase"
    | "speech_release"
    | "gaze_strategy"
    | "face_strategy"
    | "hesitation_strategy";
  timingSource:
    | "semantic_group_policy"
    | "voice_following_profile"
    | "gaze_schedule_policy"
    | "face_schedule_policy"
    | "hesitation_schedule_policy";
  semanticAxisId: string;
  semanticGroup: string;
  atMs: number;
  localAtMs?: number;
  windowStartMs?: number;
  windowEndMs?: number;
  transitionMs: number;
  holdMs: number;
  residualMs: number;
  transitionOffsetMs: number;
  compressed: boolean;
  compressionReason?: "transition_window_short";
  stepIndex?: number;
  phraseIndices?: number[];
  channelId?: string;
  gesturePreset?: string;
  hesitationReason?:
    | "ellipsis"
    | "dash"
    | "transition"
    | "soft_boundary"
    | "intent_tag"
    | "speech_cue";
}

export interface PerformanceParameterNodeTrace {
  parameterId: string;
  axisId: string;
  trackKind: "keyframe" | "speech_modulation";
  nodeIndex: number;
  eventId: string;
  atMs: number;
  transitionMs: number;
}

export interface MotionAxisSamplingTrace {
  seed: string;
  sharedRandom: number;
  perAxisRandom: Record<string, number>;
  sampledValues: Record<string, number>;
  sampleBounds: Record<string, { min: number; max: number }>;
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
  intentTags: string[];
  performanceCurveHint?: PerformanceCurveHint;
  expressionResourceId?: string;
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
