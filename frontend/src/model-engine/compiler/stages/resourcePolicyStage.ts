import type {
  ExpressionConstraint,
  ModelSummary,
  MotionConstraint,
  MotionResourceComponent,
} from "../../../types/protocol.js";
import type {
  MotionCompileContext,
  MotionCompileStage,
  MotionStageResult,
} from "../compileContext.js";

// Resource intent is validated after parameter compilation so the policy can
// compare the resource-owned parameters with the final semantic plan.
export const resourcePolicyStage: MotionCompileStage = {
  id: "resourcePolicy",
  run: runResourcePolicyStage,
};

export function runResourcePolicyStage(
  context: MotionCompileContext,
): MotionStageResult {
  const resourceId = context.intent.resource_id?.trim();
  if (!resourceId) {
    return { ok: true };
  }

  const candidates = collectResourceCandidates(context.options.model);
  const matches = candidates.filter(
    (candidate) => candidate.resourceId.toLowerCase() === resourceId.toLowerCase(),
  );
  if (matches.length === 0) {
    return { ok: false, reason: `resource_not_found:${resourceId}` };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `resource_ambiguous:${resourceId}` };
  }

  const resource = matches[0];
  if (resource.parameterIds.length === 0) {
    return {
      ok: false,
      reason: `resource_parameter_ownership_missing:${resourceId}`,
    };
  }
  context.state.resource = resource;

  const planParameterIds = new Set(
    context.state.parameters.map((parameter) => parameter.parameter_id),
  );
  const conflicts = resource.parameterIds.filter((parameterId) =>
    planParameterIds.has(parameterId),
  );
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: `resource_parameter_conflict:${resourceId}:${conflicts.join(",")}`,
    };
  }

  return { ok: true };
}

interface ResourceCandidate {
  resourceId: string;
  resourceType: "expression" | "motion";
  parameterIds: string[];
}

function collectResourceCandidates(model: ModelSummary): ResourceCandidate[] {
  const expressionCandidates = (model.constraints.expressions ?? [])
    .filter((item) => item.catalog_expose_as_resource === true)
    .map((item) => buildExpressionCandidate(item))
    .filter(isResourceCandidate);
  const motionCandidates = (model.constraints.motions ?? [])
    .filter((item) => item.catalog_expose_as_resource === true)
    .map((item) => buildMotionCandidate(item, model))
    .filter(isResourceCandidate);
  return [...expressionCandidates, ...motionCandidates];
}

function buildExpressionCandidate(item: ExpressionConstraint): ResourceCandidate | null {
  const resourceId = normalizeResourceId(item.catalog_id || item.name || item.file);
  if (!resourceId) {
    return null;
  }
  return {
    resourceId,
    resourceType: "expression",
    parameterIds: uniqueStrings(item.parameter_ids),
  };
}

function buildMotionCandidate(
  item: MotionConstraint,
  model: ModelSummary,
): ResourceCandidate | null {
  const resourceId = normalizeResourceId(item.catalog_id || item.name || item.file);
  if (!resourceId) {
    return null;
  }
  const componentIds = uniqueStrings([
    ...item.component_ids,
    ...item.driver_component_ids,
  ]);
  const componentsById = new Map<string, MotionResourceComponent>();
  for (const component of [
    ...model.motion_resource_pool.components,
    ...model.motion_resource_pool.driver_components,
  ]) {
    componentsById.set(component.id, component);
  }
  return {
    resourceId,
    resourceType: "motion",
    parameterIds: uniqueStrings(
      componentIds
        .map((componentId) => componentsById.get(componentId)?.parameter_id ?? "")
        .filter(Boolean),
    ),
  };
}

function isResourceCandidate(
  value: ResourceCandidate | null,
): value is ResourceCandidate {
  return value !== null;
}

function normalizeResourceId(value: string): string {
  return value.trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
