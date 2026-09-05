import type { MotionCompileStage } from "./compileContext.js";
import type { ModelParameterCompileStage } from "./modelParameterCompileContext.js";
import { intentValidatorStage } from "./stages/intentValidator.js";
import { axisResolverStage } from "./stages/axisResolver.js";
import { intensityStage } from "./stages/intensityStage.js";
import { semanticAxisRelationGraphStage } from "./stages/semanticAxisRelationGraphStage.js";
import { speechPoseStage } from "./stages/speechPoseStage.js";
import { modeResolverStage } from "./stages/modeResolverStage.js";
import { timingStage } from "./stages/timingStage.js";
import { modelParameterBindingStage } from "./stages/modelParameterBindingStage.js";
import { parameterTrackGraphStage } from "./stages/parameterTrackGraphStage.js";
import { resourcePolicyStage } from "./stages/resourcePolicyStage.js";

// Execution order is part of the compiler contract.
export const semanticStages: readonly MotionCompileStage[] = Object.freeze([
  intentValidatorStage,
  axisResolverStage,
  intensityStage,
  semanticAxisRelationGraphStage,
  modeResolverStage,
  timingStage,
]);

export const modelParameterStages: readonly ModelParameterCompileStage[] = Object.freeze([
  speechPoseStage,
  modelParameterBindingStage,
  parameterTrackGraphStage,
  resourcePolicyStage,
]);
