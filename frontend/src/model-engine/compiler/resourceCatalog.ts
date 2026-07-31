import type {
  CatalogMotionPayload,
  ExpressionConstraint,
  ModelSummary,
  MotionConstraint,
} from "../../types/protocol.js";

export type ResolvedCatalogResource =
  | {
    resourceId: string;
    resourceType: "expression";
    parameterIds: string[];
    expressionId: string;
  }
  | {
    resourceId: string;
    resourceType: "motion";
    motion: CatalogMotionPayload;
  };

export function resolveCatalogResource(
  model: ModelSummary,
  resourceId: string,
  resourceType: ResolvedCatalogResource["resourceType"],
): { ok: true; resource: ResolvedCatalogResource } | { ok: false; reason: string } {
  const normalizedResourceId = resourceId.trim();
  if (!normalizedResourceId) {
    return { ok: false, reason: "resource_id_empty" };
  }
  const rawMatches = resourceType === "motion"
    ? model.constraints.motions.filter((item) => item.catalog_expose_as_resource
      && resolveConstraintResourceId(item).toLowerCase() === normalizedResourceId.toLowerCase())
    : model.constraints.expressions.filter((item) => item.catalog_expose_as_resource
      && resolveConstraintResourceId(item).toLowerCase() === normalizedResourceId.toLowerCase());
  if (rawMatches.length === 0) {
    return { ok: false, reason: `resource_not_found:${normalizedResourceId}` };
  }
  if (rawMatches.length > 1) {
    return { ok: false, reason: `resource_ambiguous:${normalizedResourceId}` };
  }
  const resource = resourceType === "motion"
    ? buildMotionResource(rawMatches[0] as MotionConstraint, model)
    : buildExpressionResource(rawMatches[0] as ExpressionConstraint);
  if (!resource) {
    return {
      ok: false,
      reason: resourceType === "motion"
        ? `motion_runtime_locator_or_duration_invalid:${normalizedResourceId}`
        : `expression_runtime_ownership_invalid:${normalizedResourceId}`,
    };
  }
  return { ok: true, resource };
}

export function collectCatalogResources(model: ModelSummary): ResolvedCatalogResource[] {
  const expressions = model.constraints.expressions
    .filter((item) => item.catalog_expose_as_resource)
    .map(buildExpressionResource)
    .filter((item): item is Extract<ResolvedCatalogResource, { resourceType: "expression" }> => item !== null);
  const motions = model.constraints.motions
    .filter((item) => item.catalog_expose_as_resource)
    .map((item) => buildMotionResource(item, model))
    .filter((item): item is Extract<ResolvedCatalogResource, { resourceType: "motion" }> => item !== null);
  return [...expressions, ...motions];
}

function buildExpressionResource(
  item: ExpressionConstraint,
): Extract<ResolvedCatalogResource, { resourceType: "expression" }> | null {
  const resourceId = resolveConstraintResourceId(item);
  const expressionId = item.name.trim();
  const parameterIds = uniqueStrings(item.parameter_ids);
  if (!resourceId || !expressionId || parameterIds.length === 0) {
    return null;
  }
  return { resourceId, resourceType: "expression", expressionId, parameterIds };
}

function buildMotionResource(
  item: MotionConstraint,
  model: ModelSummary,
): Extract<ResolvedCatalogResource, { resourceType: "motion" }> | null {
  const resourceId = resolveConstraintResourceId(item);
  const group = item.group.trim();
  const file = item.file.trim();
  const durationMs = Number.isFinite(item.duration) && item.duration > 0
    ? Math.round(item.duration * 1000)
    : null;
  const index = resolveMotionGroupIndex(model.constraints.motions, item);
  if (!resourceId || !group || !file || index < 0 || durationMs === null) {
    return null;
  }
  return {
    resourceId,
    resourceType: "motion",
    motion: {
      schema_version: "engine.catalog_motion.v1",
      model_id: model.name,
      motion_id: resourceId,
      group,
      index,
      file,
      label: item.catalog_label.trim() || item.name.trim() || resourceId,
      emotion_label: item.catalog_label.trim() || item.name.trim() || resourceId,
      duration_ms: durationMs,
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
  if (normalized === "high") return 4;
  if (normalized === "low") return 2;
  return 3;
}

function normalizeResourceId(value: string): string {
  return value.trim();
}

function resolveConstraintResourceId(
  item: Pick<ExpressionConstraint | MotionConstraint, "catalog_id" | "name" | "file">,
): string {
  return normalizeResourceId(item.catalog_id || item.name || item.file);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
