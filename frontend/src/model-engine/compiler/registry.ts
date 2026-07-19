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
export type ModelEngineCompilePhase = "semantic" | "model_parameter";

export interface ModelEngineCompileStageRegistration {
  id: string;
  stage: MotionCompileStage;
  phase: ModelEngineCompilePhase;
  order: number;
  kind: ModelEngineStageKind;
  enabled: (context: MotionCompileContext) => boolean;
}

export interface ModelEngineStageRegistry {
  resolve(
    context: MotionCompileContext,
    phase: ModelEngineCompilePhase,
  ): MotionCompileStage[];
  list(): ReadonlyArray<ModelEngineCompileStageRegistration>;
  register(registration: ModelEngineCompileStageRegistration): void;
  unregister(id: string): void;
  setEnabled(id: string, enabled: boolean): void;
}

export function createDefaultCompileStageRegistrations(): ModelEngineCompileStageRegistration[] {
  const always = () => true;
  return [
    { id: "intentValidator", stage: intentValidatorStage, phase: "semantic", order: 10, kind: "core", enabled: always },
    { id: "axisResolver", stage: axisResolverStage, phase: "semantic", order: 20, kind: "core", enabled: always },
    { id: "intensity", stage: intensityStage, phase: "semantic", order: 30, kind: "core", enabled: always },
    { id: "derivedCandidates", stage: couplingStage, phase: "semantic", order: 40, kind: "core", enabled: always },
    { id: "modeResolver", stage: modeResolverStage, phase: "semantic", order: 45, kind: "core", enabled: always },
    { id: "timing", stage: timingStage, phase: "semantic", order: 46, kind: "core", enabled: always },
    { id: "semanticAxisRelationGraph", stage: semanticAxisRelationGraphStage, phase: "semantic", order: 50, kind: "core", enabled: always },
    { id: "speechPose", stage: speechPoseStage, phase: "model_parameter", order: 60, kind: "extension", enabled: always },
    { id: "planBuilder", stage: planBuilderStage, phase: "model_parameter", order: 80, kind: "core", enabled: always },
    { id: "resourcePolicy", stage: resourcePolicyStage, phase: "model_parameter", order: 90, kind: "core", enabled: always },
  ];
}

export function createModelEngineStageRegistry(
  initial = createDefaultCompileStageRegistrations(),
): ModelEngineStageRegistry {
  const registrations = new Map<string, ModelEngineCompileStageRegistration>();
  const disabledExtensions = new Set<string>();
  for (const registration of initial) {
    addRegistration(registration);
  }

  function addRegistration(registration: ModelEngineCompileStageRegistration): void {
    const id = registration.id.trim();
    if (!id) {
      throw new Error("ModelEngine stage id must not be empty.");
    }
    if (!Number.isFinite(registration.order)) {
      throw new Error(`ModelEngine stage '${id}' requires a finite order.`);
    }
    if (registrations.has(id)) {
      throw new Error(`ModelEngine stage '${id}' is already registered.`);
    }
    registrations.set(id, { ...registration, id });
  }

  function requireExtension(id: string): ModelEngineCompileStageRegistration {
    const registration = registrations.get(id);
    if (!registration) {
      throw new Error(`ModelEngine stage '${id}' is not registered.`);
    }
    if (registration.kind === "core") {
      throw new Error(`ModelEngine core stage '${id}' cannot be modified at runtime.`);
    }
    return registration;
  }

  return {
    resolve(context, phase) {
      return Array.from(registrations.values())
        .filter((registration) =>
          registration.phase === phase
          && !disabledExtensions.has(registration.id)
          && registration.enabled(context),
        )
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
        .map((registration) => registration.stage);
    },
    list() {
      return Array.from(registrations.values())
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
        .map((registration) => ({ ...registration }));
    },
    register(registration) {
      if (registration.kind !== "extension") {
        throw new Error("Runtime stage registration only accepts extension stages.");
      }
      addRegistration(registration);
    },
    unregister(id) {
      requireExtension(id);
      registrations.delete(id);
      disabledExtensions.delete(id);
    },
    setEnabled(id, enabled) {
      requireExtension(id);
      if (enabled) {
        disabledExtensions.delete(id);
      } else {
        disabledExtensions.add(id);
      }
    },
  };
}

export function listCompileStageRegistrations(): ReadonlyArray<ModelEngineCompileStageRegistration> {
  return createDefaultCompileStageRegistrations();
}
