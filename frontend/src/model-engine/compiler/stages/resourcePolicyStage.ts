import type {
  ModelParameterCompileContext,
  ModelParameterCompileStage,
  ModelParameterStageResult,
} from "../modelParameterCompileContext.js";
import { resolveCatalogResource } from "../resourceCatalog.js";

// Expression resources are the only resources that share parameter ownership
// with a direct plan, so their conflict check belongs after parameter binding.
export const resourcePolicyStage: ModelParameterCompileStage = {
  id: "resourcePolicy",
  run: runResourcePolicyStage,
};

export function runResourcePolicyStage(
  context: ModelParameterCompileContext,
): ModelParameterStageResult {
  const expressionResourceId = context.semanticMotion.expressionResourceId?.trim();
  if (!expressionResourceId) {
    return { ok: true };
  }
  const resolved = resolveCatalogResource(
    context.options.model,
    expressionResourceId,
    "expression",
  );
  if (!resolved.ok) {
    return resolved;
  }
  const resource = resolved.resource;
  if (resource.resourceType !== "expression") {
    return { ok: false, reason: "expression_resource_resolution_type_invalid" };
  }
  context.state.expressionResource = resource;

  const planParameterIds = new Set(
    context.state.parameters.map((parameter) => parameter.parameter_id),
  );
  const conflicts = resource.parameterIds.filter((parameterId) =>
    planParameterIds.has(parameterId),
  );
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: `resource_parameter_conflict:${resource.resourceId}:${conflicts.join(",")}`,
    };
  }

  return { ok: true };
}
