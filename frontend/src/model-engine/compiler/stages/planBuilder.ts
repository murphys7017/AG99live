import type { SemanticParameterPlan } from "../../../types/protocol.js";
import type {
  SemanticAxisDefinition,
  SemanticAxisParameterBinding,
} from "../../../types/semantic-axis-profile.js";
import type {
  DynamicAxisValues,
  MotionCompileContext,
  MotionCompileStage,
  MotionAxisValueSourceMap,
  MotionStageResult,
} from "../compileContext.js";

// Reads:
// - context.state.profile
// - context.state.axisById
// - context.state.allAxisValues
// - context.state.controlledValues
// - context.state.parameters
//
// Writes:
// - context.state.parameters
//
// Does not own:
// - final plan assembly
// - diagnostics finalization
export const planBuilderStage: MotionCompileStage = {
  id: "planBuilder",
  run: runPlanBuilderStage,
};

export function runPlanBuilderStage(
  context: MotionCompileContext,
): MotionStageResult {
  const profile = context.state.profile;
  if (!profile) {
    return { ok: false, reason: "semantic_profile_missing" };
  }

  const parameterResult = buildSemanticPlanParameters(
    context.state.allAxisValues,
    context.state.axisById,
    context.state.axisValueSources,
  );
  if (!parameterResult.ok) {
    if (
      parameterResult.reason === "semantic_plan_parameters_empty"
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
    return { ok: false, reason: "semantic_plan_parameters_empty" };
  }
  return { ok: true };
}

function buildSemanticPlanParameters(
  axisValues: DynamicAxisValues,
  axisById: Map<string, SemanticAxisDefinition>,
  axisValueSources: MotionAxisValueSourceMap,
):
  | { ok: true; parameters: SemanticParameterPlan["parameters"]; warnings: string[] }
  | { ok: false; reason: string } {
  const parameters: SemanticParameterPlan["parameters"] = [];
  const seenParameterIds = new Set<string>();
  const warnings: string[] = [];

  for (const [axisId, value] of Object.entries(axisValues)) {
    const axis = axisById.get(axisId);
    if (!axis) {
      return { ok: false, reason: `unknown_axis:${axisId}` };
    }
    if (!axis.parameter_bindings.length) {
      return { ok: false, reason: `axis_parameter_binding_missing:${axisId}` };
    }

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
      parameters.push({
        axis_id: axisId,
        parameter_id: binding.parameter_id,
        target_value: parameter.targetValue,
        weight: binding.default_weight,
        input_value: value,
        source: axisValueSources[axisId] ?? "coupling",
      });
    }
  }

  if (!parameters.length) {
    return { ok: false, reason: "semantic_plan_parameters_empty" };
  }
  return { ok: true, parameters, warnings };
}

function mapSemanticBindingValue(
  axis: SemanticAxisDefinition,
  binding: SemanticAxisParameterBinding,
  value: number,
):
  | { ok: true; targetValue: number }
  | { ok: false; reason: string } {
  const [inputMin, inputMax] = binding.input_range;
  const [outputMin, outputMax] = binding.output_range;

  if (inputMax === inputMin) {
    return {
      ok: false,
      reason: `binding_input_range_zero:${axis.id}:${binding.parameter_id}`,
    };
  }
  if (
    !Number.isFinite(binding.default_weight)
    || binding.default_weight < 0
    || binding.default_weight > 1
  ) {
    return {
      ok: false,
      reason: `binding_weight_invalid:${axis.id}:${binding.parameter_id}`,
    };
  }

  if (value < inputMin || value > inputMax) {
    return {
      ok: false,
      reason: `binding_input_value_out_of_range:${axis.id}:${binding.parameter_id}`,
    };
  }

  const ratio = (value - inputMin) / (inputMax - inputMin);
  const effectiveRatio = binding.invert ? 1 - ratio : ratio;
  const targetValue = outputMin + (outputMax - outputMin) * effectiveRatio;

  if (!Number.isFinite(targetValue)) {
    return {
      ok: false,
      reason: `binding_target_not_finite:${axis.id}:${binding.parameter_id}`,
    };
  }

  return { ok: true, targetValue };
}
