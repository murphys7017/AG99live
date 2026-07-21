import type { SemanticParameterPlan } from "../../../types/protocol.js";
import type {
  SemanticAxisDefinition,
  SemanticAxisParameterBinding,
} from "../../../types/semantic-axis-profile.js";
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
      const speechGesture = pendingSpeechGestures[axisId];
      parameters.push({
        axis_id: axisId,
        parameter_id: binding.parameter_id,
        target_value: parameter.targetValue,
        neutral_target_value: parameter.neutralTargetValue,
        weight: binding.default_weight,
        input_value: value,
        source,
        modulation: speechGesture ? {
          kind: "speech_gesture_track",
          preset: speechGesture.preset,
          amplitude: dynamics.max_speech_offset * speechGesture.amplitudeRatio,
          direction: 1,
          delay_ms: speechGesture.delayMs,
          points: speechGesture.points,
        } : undefined,
        dynamics,
      });
    }
  }

  if (!parameters.length) {
    return { ok: false, reason: "parameter_binding_parameters_empty" };
  }
  return { ok: true, parameters, warnings };
}

function mapSemanticBindingDynamics(
  axis: SemanticAxisDefinition,
  binding: SemanticAxisParameterBinding,
): NonNullable<SemanticParameterPlan["parameters"][number]["dynamics"]> {
  const inputSpan = Math.abs(binding.input_range[1] - binding.input_range[0]);
  const outputSpan = Math.abs(binding.output_range[1] - binding.output_range[0]);
  const outputPerInput = inputSpan > 0 ? outputSpan / inputSpan : 0;
  return {
    max_velocity: axis.dynamics.max_velocity * outputPerInput,
    max_acceleration: axis.dynamics.max_acceleration * outputPerInput,
    max_speech_offset: outputSpan * axis.dynamics.max_speech_offset_ratio,
  };
}

function mapSemanticBindingValue(
  axis: SemanticAxisDefinition,
  binding: SemanticAxisParameterBinding,
  value: number,
):
  | { ok: true; targetValue: number; neutralTargetValue: number }
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
  const neutralRatio = (axis.neutral - inputMin) / (inputMax - inputMin);
  const effectiveNeutralRatio = binding.invert ? 1 - neutralRatio : neutralRatio;
  const neutralTargetValue = outputMin
    + (outputMax - outputMin) * effectiveNeutralRatio;

  if (!Number.isFinite(targetValue) || !Number.isFinite(neutralTargetValue)) {
    return {
      ok: false,
      reason: `binding_target_not_finite:${axis.id}:${binding.parameter_id}`,
    };
  }

  return { ok: true, targetValue, neutralTargetValue };
}
