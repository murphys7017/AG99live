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
} from "../contracts.js";
import type { ModelEngineSettings } from "../settings.js";

export type DynamicAxisValues = Record<string, number>;

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
