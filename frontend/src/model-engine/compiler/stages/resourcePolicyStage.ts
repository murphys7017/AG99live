import type {
  ExpressionConstraint,
  ModelSummary,
  MotionConstraint,
  MotionResourceComponent,
} from "../../../types/protocol.js";
import type {
  ModelParameterCompileContext,
  ModelParameterCompileStage,
  ModelParameterStageResult,
} from "../modelParameterCompileContext.js";

// Resource intent is validated after parameter compilation so the policy can
// compare the resource-owned parameters with the final semantic plan.
export const resourcePolicyStage: ModelParameterCompileStage = {
  id: "resourcePolicy",
  run: runResourcePolicyStage,
};

export function runResourcePolicyStage(
  context: ModelParameterCompileContext,
): ModelParameterStageResult {
  const expressionResourceId = context.intent.schema_version === "engine.motion_intent.v4"
    ? context.intent.expression_resource_id?.trim()
    : undefined;
  const motionResourceId = context.intent.schema_version === "engine.motion_intent.v4"
    ? context.intent.motion_resource_id?.trim()
    : undefined;
  const legacyResourceId = context.intent.schema_version === "engine.motion_intent.v3"
    ? context.intent.resource_id?.trim()
    : undefined;
  const resourceId = expressionResourceId || motionResourceId || legacyResourceId;
  if (!resourceId) {
    return { ok: true };
  }

  const expectedType = expressionResourceId
    ? "expression"
    : motionResourceId
      ? "motion"
      : null;

  const candidates = collectResourceCandidates(context.options.model);
  const matches = candidates.filter(
    (candidate) => candidate.resourceId.toLowerCase() === resourceId.toLowerCase()
      && (expectedType === null || candidate.resourceType === expectedType),
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

  if (resource.resourceType === "expression" && !resource.expressionId) {
    return { ok: false, reason: `expression_runtime_id_missing:${resourceId}` };
  }
  if (
    resource.resourceType === "motion"
    && (
      !resource.motion
      || !resource.motion.group
      || !resource.motion.file
      || resource.motion.index < 0
    )
  ) {
    return { ok: false, reason: `motion_runtime_locator_missing:${resourceId}` };
  }

  if (resource.resourceType === "motion") {
    return { ok: true };
  }

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
  expressionId?: string;
  motion?: import("../../../types/protocol.js").CatalogMotionPayload;
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
    expressionId: item.name.trim(),
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
    motion: {
      schema_version: "engine.catalog_motion.v1",
      model_id: model.name,
      motion_id: resourceId,
      group: item.group.trim(),
      index: resolveMotionGroupIndex(model.constraints.motions, item),
      file: item.file.trim(),
      label: item.catalog_label?.trim() || item.name.trim() || resourceId,
      emotion_label: item.catalog_label?.trim() || item.name.trim() || resourceId,
      duration_ms: Number.isFinite(item.duration) && item.duration > 0
        ? Math.round(item.duration * 1000)
        : null,
      priority: resolveMotionPriority(item.catalog_intensity),
      summary: { source: "semantic_motion_resource" },
    },
  };
}

function resolveMotionGroupIndex(
  motions: readonly MotionConstraint[],
  target: MotionConstraint,
): number {
  let index = 0;
  for (const item of motions) {
    if (item.group !== target.group) {
      continue;
    }
    if (item === target || item.file === target.file) {
      return index;
    }
    index += 1;
  }
  return -1;
}

function resolveMotionPriority(intensity: string): number {
  const normalized = intensity.trim().toLowerCase();
  if (normalized === "high") {
    return 4;
  }
  if (normalized === "low") {
    return 2;
  }
  return 3;
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
