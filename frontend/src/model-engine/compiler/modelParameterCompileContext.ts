import type {
  CatalogMotionPayload,
  SemanticParameterPlan,
} from "../../types/protocol.js";
import type {
  SemanticAxisDefinition,
  SemanticAxisProfile,
} from "../../types/semantic-axis-profile.js";
import type { ModelEngineSettings } from "../settings.js";
import type {
  CompileOptions,
  CompiledSemanticMotion,
} from "./contracts.js";

export interface ResolvedMotionResource {
  resourceId: string;
  resourceType: "expression" | "motion";
  parameterIds: string[];
  expressionId?: string;
  motion?: CatalogMotionPayload;
}

export interface ModelParameterCompileState {
  profile: SemanticAxisProfile;
  axisById: Map<string, SemanticAxisDefinition>;
  parameters: SemanticParameterPlan["parameters"];
  pendingSpeechGestures: Record<string, {
    preset: NonNullable<SemanticParameterPlan["parameters"][number]["modulation"]>["preset"];
    amplitude: number;
    weight: number;
    delayMs: number;
    points: Array<{ at_ms: number; transition_ms: number; value: number }>;
  }>;
  resource: ResolvedMotionResource | null;
  warnings: string[];
}

export interface ModelParameterCompileContext {
  semanticMotion: Extract<CompiledSemanticMotion, { kind: "pose" }>;
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
    options,
    settings,
    state: {
      profile,
      axisById: new Map(profile.axes.map((axis) => [axis.id, axis])),
      parameters: [],
      pendingSpeechGestures: {},
      resource: null,
      warnings: [...(semanticMotion.diagnostics.warnings ?? [])],
    },
  };
}
