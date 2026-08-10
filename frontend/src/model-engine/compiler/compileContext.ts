import type {
  SemanticMotionIntent,
} from "../../types/protocol.js";
import type {
  SemanticAxisDefinition,
  SemanticAxisProfile,
} from "../../types/semantic-axis-profile.js";
import type {
  CompileDiagnostics,
  MotionAxisSamplingTrace,
  MotionAxisRelationAdjustment,
  MotionAxisRelationEvaluation,
  MotionTimingResolution,
} from "../../types/compiledSemanticMotion.js";
import type {
  CompileOptions,
  MotionAxisValueSource,
} from "./contracts.js";
import type { ModelEngineSettings } from "../settings.js";

export type DynamicAxisValues = Record<string, number>;
export type MotionAxisValueSourceMap = Record<string, MotionAxisValueSource>;

export interface ResolvedAxisRoleBuckets {
  primaryAxes: string[];
  hintAxes: string[];
  derivedAxes: string[];
  runtimeAxes: string[];
}

export interface MotionCompileMutableState {
  profile: SemanticAxisProfile | null;
  axisById: Map<string, SemanticAxisDefinition>;

  roleAxisIds: ResolvedAxisRoleBuckets;

  controlledValues: DynamicAxisValues;
  derivedValues: DynamicAxisValues;
  allAxisValues: DynamicAxisValues;
  axisValueSources: MotionAxisValueSourceMap;
  appliedDerivedAxes: string[];

  missingAxes: string[];
  forbiddenAxes: string[];
  invalidAxes: string[];

  axisErrorCount: number;
  axisErrorLimit: number;

  relationAdjustments: MotionAxisRelationAdjustment[];
  relationEvaluations: MotionAxisRelationEvaluation[];
  axisSampling: MotionAxisSamplingTrace | null;

  warnings: string[];

  resolvedMode: "idle" | "expressive";
  timing: MotionTimingResolution | null;

}

export interface MotionCompileContext {
  intent: SemanticMotionIntent;
  options: CompileOptions;
  settings: ModelEngineSettings;

  baseDiagnostics: CompileDiagnostics;
  state: MotionCompileMutableState;
}

export type MotionStageResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface MotionCompileStage {
  id: string;
  run(context: MotionCompileContext): MotionStageResult;
}

export function createInitialCompileState(): MotionCompileMutableState {
  return {
    profile: null,
    axisById: new Map(),
    roleAxisIds: {
      primaryAxes: [],
      hintAxes: [],
      derivedAxes: [],
      runtimeAxes: [],
    },
    controlledValues: {},
    derivedValues: {},
    allAxisValues: {},
    axisValueSources: {},
    appliedDerivedAxes: [],
    missingAxes: [],
    forbiddenAxes: [],
    invalidAxes: [],
    axisErrorCount: 0,
    axisErrorLimit: 0,
    relationAdjustments: [],
    relationEvaluations: [],
    axisSampling: null,
    warnings: [],
    resolvedMode: "idle",
    timing: null,
  };
}

export function replaceControlledAxisValues(
  state: MotionCompileMutableState,
  nextControlledValues: DynamicAxisValues,
): void {
  state.controlledValues = nextControlledValues;
  state.axisValueSources = Object.fromEntries(
    Object.keys(nextControlledValues).map((axisId) => [axisId, "semantic_axis"]),
  );
}

export function refreshAllAxisValues(
  state: MotionCompileMutableState,
): void {
  state.allAxisValues = {
    ...state.controlledValues,
    ...state.derivedValues,
  };
}
