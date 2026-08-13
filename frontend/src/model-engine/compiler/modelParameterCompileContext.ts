import type { SemanticParameterPlan } from "../../types/protocol.js";
import type {
  SemanticAxisDefinition,
  SemanticAxisProfile,
} from "../../types/semantic-axis-profile.js";
import type { ModelEngineSettings } from "../settings.js";
import type { CompiledSemanticMotion } from "../../types/compiledSemanticMotion.js";
import type {
  CompileOptions,
} from "./contracts.js";
import type { PerformanceSchedule } from "./performanceSchedule.js";

export interface ModelParameterCompileState {
  profile: SemanticAxisProfile;
  axisById: Map<string, SemanticAxisDefinition>;
  parameters: SemanticParameterPlan["parameters"];
  pendingSpeechGestures: Record<string, {
    preset: NonNullable<SemanticParameterPlan["parameters"][number]["modulation"]>["preset"];
    amplitudeRatio: number;
    delayMs: number;
    points: Array<{ at_ms: number; transition_ms: number; value: number }>;
  }>;
  expressionResource: {
    resourceId: string;
    expressionId: string;
    parameterIds: string[];
  } | null;
  warnings: string[];
}

export interface ModelParameterCompileContext {
  semanticMotion: Extract<CompiledSemanticMotion, { kind: "pose" }>;
  performanceSchedule: PerformanceSchedule;
  options: CompileOptions;
  settings: ModelEngineSettings;
  state: ModelParameterCompileState;
}

export type ModelParameterStageResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface ModelParameterCompileStage {
  id: string;
  run(context: ModelParameterCompileContext): ModelParameterStageResult;
}

export function createModelParameterCompileContext(
  semanticMotion: Extract<CompiledSemanticMotion, { kind: "pose" }>,
  performanceSchedule: PerformanceSchedule,
  options: CompileOptions,
  settings: ModelEngineSettings,
): ModelParameterCompileContext {
  const profile = options.model.semantic_axis_profile;
  if (
    !profile
    || profile.profile_id !== semanticMotion.profileId
    || profile.revision !== semanticMotion.profileRevision
    || profile.model_id !== semanticMotion.modelId
  ) {
    throw new Error("model_parameter_semantic_profile_mismatch");
  }
  return {
    semanticMotion,
    performanceSchedule,
    options,
    settings,
    state: {
      profile,
      axisById: new Map(profile.axes.map((axis) => [axis.id, axis])),
      parameters: [],
      pendingSpeechGestures: {},
      expressionResource: null,
      warnings: [...(semanticMotion.diagnostics.warnings ?? [])],
    },
  };
}
