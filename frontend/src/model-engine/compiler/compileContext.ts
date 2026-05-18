import type {
  SemanticMotionIntent,
  SemanticParameterPlan,
} from "../../types/protocol.js";
import type {
  SemanticAxisDefinition,
  SemanticAxisProfile,
} from "../../types/semantic-axis-profile.js";
import type {
  CompileDiagnostics,
  CompileOptions,
  MotionTimingResolution,
} from "./contracts.js";
import type { ModelEngineSettings } from "../settings.js";

export type DynamicAxisValues = Record<string, number>;
export type MotionAxisValueSource = "semantic_axis" | "coupling";
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

  warnings: string[];

  resolvedMode: "idle" | "expressive";
  timing: MotionTimingResolution | null;

  parameters: SemanticParameterPlan["parameters"];
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
    warnings: [],
    resolvedMode: "idle",
    timing: null,
    parameters: [],
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

export function mergeDerivedAxisValues(
  state: MotionCompileMutableState,
  nextDerivedValues: DynamicAxisValues,
  source: MotionAxisValueSource,
): void {
  const appliedAxisIds = Object.keys(nextDerivedValues);
  state.derivedValues = {
    ...state.derivedValues,
    ...nextDerivedValues,
  };
  state.axisValueSources = {
    ...state.axisValueSources,
    ...Object.fromEntries(
      appliedAxisIds.map((axisId) => [axisId, source]),
    ),
  };
  state.appliedDerivedAxes = Array.from(
    new Set([...state.appliedDerivedAxes, ...appliedAxisIds]),
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
