import type { MotionCompileContext, MotionCompileStage } from "./compileContext.js";
import { intentValidatorStage } from "./stages/intentValidator.js";
import { axisResolverStage } from "./stages/axisResolver.js";
import { intensityStage } from "./stages/intensityStage.js";
import { couplingStage } from "./stages/couplingStage.js";
import { semanticAxisRelationGraphStage } from "./stages/semanticAxisRelationGraphStage.js";
import { speechPoseStage } from "./stages/speechPoseStage.js";
import { modeResolverStage } from "./stages/modeResolverStage.js";
import { timingStage } from "./stages/timingStage.js";
import { planBuilderStage } from "./stages/planBuilder.js";
import { resourcePolicyStage } from "./stages/resourcePolicyStage.js";

export type ModelEngineStageKind = "core" | "extension";

export interface ModelEngineCompileStageRegistration {
  id: string;
  stage: MotionCompileStage;
  order: number;
  kind: ModelEngineStageKind;
  enabled: (context: MotionCompileContext) => boolean;
}

const registrations: ModelEngineCompileStageRegistration[] = [
  {
    id: "intentValidator",
    stage: intentValidatorStage,
    order: 10,
    kind: "core",
    enabled: () => true,
  },
  {
    id: "axisResolver",
    stage: axisResolverStage,
    order: 20,
    kind: "core",
    enabled: () => true,
  },
  {
    id: "intensity",
    stage: intensityStage,
    order: 30,
    kind: "core",
    enabled: () => true,
  },
  {
    id: "derivedCandidates",
    stage: couplingStage,
    order: 40,
    kind: "core",
    enabled: () => true,
  },
  {
    id: "speechPose",
    stage: speechPoseStage,
    order: 45,
    kind: "extension",
    enabled: () => true,
  },
  {
    id: "semanticAxisRelationGraph",
    stage: semanticAxisRelationGraphStage,
    order: 50,
    kind: "core",
    enabled: () => true,
  },
  {
    id: "modeResolver",
    stage: modeResolverStage,
    order: 60,
    kind: "core",
    enabled: () => true,
  },
  {
    id: "timing",
    stage: timingStage,
    order: 70,
    kind: "core",
    enabled: () => true,
  },
  {
    id: "planBuilder",
    stage: planBuilderStage,
    order: 80,
    kind: "core",
    enabled: () => true,
  },
  {
    id: "resourcePolicy",
    stage: resourcePolicyStage,
    order: 90,
    kind: "core",
    enabled: () => true,
  },
];

export function resolveCompileStages(
  context: MotionCompileContext,
): MotionCompileStage[] {
  return registrations
    .filter((reg) => reg.enabled(context))
    .sort((a, b) => a.order - b.order)
    .map((reg) => reg.stage);
}

export function listCompileStageRegistrations(): ReadonlyArray<ModelEngineCompileStageRegistration> {
  return registrations;
}
