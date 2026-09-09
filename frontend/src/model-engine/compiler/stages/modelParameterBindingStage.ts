import type { SemanticParameterPlan } from "../../../types/protocol.js";
import type {
  SemanticAxisDefinition,
  SemanticAxisParameterBinding,
} from "../../../types/semantic-axis-profile.js";
import {
  mapSemanticBindingDynamics,
  mapSemanticBindingValue,
} from "../semanticParameterBinding.js";
import type {
  ModelParameterCompileContext,
  ModelParameterCompileStage,
  ModelParameterStageResult,
} from "../modelParameterCompileContext.js";

// Reads:
// - context.state.profile
// - context.state.axisById
// - context.semanticMotion.axes
// - context.state.parameters
//
// Writes:
// - context.state.parameters
//
// Does not own:
// - final plan assembly
// - diagnostics finalization
export const modelParameterBindingStage: ModelParameterCompileStage = {
  id: "modelParameterBinding",
  run: runModelParameterBindingStage,
};

export function runModelParameterBindingStage(
  context: ModelParameterCompileContext,
): ModelParameterStageResult {
  const profile = context.state.profile;
  if (!profile) {
    return { ok: false, reason: "semantic_profile_missing" };
  }

  const parameterResult = buildSemanticPlanParameters(
    context.semanticMotion.axes,
    context.state.axisById,
    context.state.pendingSpeechGestures,
  );
  if (!parameterResult.ok) {
    if (
      parameterResult.reason === "parameter_binding_parameters_empty"
      && context.state.parameters.length > 0
    ) {
      return { ok: true };
    }
    return parameterResult;
  }
  if (parameterResult.warnings.length) {
    context.state.warnings = [
      ...context.state.warnings,
      ...parameterResult.warnings,
    ];
  }

  const existingParameterIds = new Set(
    context.state.parameters.map((item) => item.parameter_id),
  );
  for (const parameter of parameterResult.parameters) {
    if (existingParameterIds.has(parameter.parameter_id)) {
      return {
        ok: false,
        reason: `duplicate_parameter_binding:${parameter.parameter_id}`,
      };
    }
    existingParameterIds.add(parameter.parameter_id);
    context.state.parameters.push(parameter);
  }
  if (!context.state.parameters.length) {
    return { ok: false, reason: "parameter_binding_parameters_empty" };
  }
  return { ok: true };
}

function buildSemanticPlanParameters(
  semanticAxes: ModelParameterCompileContext["semanticMotion"]["axes"],
  axisById: Map<string, SemanticAxisDefinition>,
  pendingSpeechGestures: ModelParameterCompileContext["state"]["pendingSpeechGestures"],
):
  | { ok: true; parameters: SemanticParameterPlan["parameters"]; warnings: string[] }
  | { ok: false; reason: string } {
  const parameters: SemanticParameterPlan["parameters"] = [];
  const seenParameterIds = new Set<string>();
  const warnings: string[] = [];

  const semanticAxisById = new Map(semanticAxes.map((axis) => [axis.axisId, axis]));
  const axisIds = new Set([...semanticAxisById.keys(), ...Object.keys(pendingSpeechGestures)]);
  for (const axisId of axisIds) {
    const semanticAxis = semanticAxisById.get(axisId);
    const axis = axisById.get(axisId);
    if (!axis) {
      return { ok: false, reason: `unknown_axis:${axisId}` };
    }
    if (!axis.parameter_bindings.length) {
      return { ok: false, reason: `axis_parameter_binding_missing:${axisId}` };
    }
    const value = semanticAxis?.value ?? axis.neutral;
    const source = semanticAxis?.source ?? "speech_pose";
    for (const binding of axis.parameter_bindings) {
      const parameter = mapSemanticBindingValue(axis, binding, value);
      if (!parameter.ok) {
        return parameter;
      }
      if (seenParameterIds.has(binding.parameter_id)) {
        return {
          ok: false,
          reason: `duplicate_parameter_binding:${binding.parameter_id}`,
        };
      }

      seenParameterIds.add(binding.parameter_id);
      const dynamics = mapSemanticBindingDynamics(axis, binding);
      parameters.push({
        axis_id: axisId,
        parameter_id: binding.parameter_id,
        activation_at_ms: 0,
        target_value: parameter.targetValue,
        neutral_target_value: parameter.neutralTargetValue,
        weight: binding.default_weight,
        input_value: value,
        source,
        dynamics,
      });
    }
  }

  if (!parameters.length) {
    return { ok: false, reason: "parameter_binding_parameters_empty" };
  }
  return { ok: true, parameters, warnings };
}
