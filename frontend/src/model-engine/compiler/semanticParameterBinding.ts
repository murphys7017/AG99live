import type { SemanticParameterPlan } from "../../types/protocol.js";
import type {
  SemanticAxisDefinition,
  SemanticAxisParameterBinding,
} from "../../types/semantic-axis-profile.js";

export function mapSemanticBindingDynamics(
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
    response: mapParameterResponseProfile(axis.semantic_group),
  };
}

type ParameterResponseProfile = NonNullable<
  SemanticParameterPlan["parameters"][number]["dynamics"]
>["response"];

const RESPONSE_PROFILE_BY_GROUP: Record<string, ParameterResponseProfile> = {
  head: { kind: "spring", frequency_hz: 2.9, damping_ratio: 0.72 },
  body: { kind: "spring", frequency_hz: 1.05, damping_ratio: 0.84 },
  torso: { kind: "spring", frequency_hz: 1, damping_ratio: 0.86 },
  shoulder: { kind: "spring", frequency_hz: 1.08, damping_ratio: 0.84 },
  gaze: { kind: "spring", frequency_hz: 4.2, damping_ratio: 0.74 },
  eye: { kind: "spring", frequency_hz: 4.4, damping_ratio: 0.86 },
  brow: { kind: "spring", frequency_hz: 3.9, damping_ratio: 0.78 },
  face: { kind: "spring", frequency_hz: 3.6, damping_ratio: 0.78 },
};

export function mapParameterResponseProfile(
  semanticGroup: string,
): ParameterResponseProfile {
  return RESPONSE_PROFILE_BY_GROUP[semanticGroup.trim().toLowerCase()] ?? { kind: "bounded" };
}

export function mapSemanticBindingValue(
  axis: SemanticAxisDefinition,
  binding: SemanticAxisParameterBinding,
  value: number,
):
  | { ok: true; targetValue: number; neutralTargetValue: number }
  | { ok: false; reason: string } {
  const [inputMin, inputMax] = binding.input_range;
  const [outputMin, outputMax] = binding.output_range;
  if (inputMax === inputMin) {
    return { ok: false, reason: `binding_input_range_zero:${axis.id}:${binding.parameter_id}` };
  }
  if (!Number.isFinite(binding.default_weight) || binding.default_weight < 0 || binding.default_weight > 1) {
    return { ok: false, reason: `binding_weight_invalid:${axis.id}:${binding.parameter_id}` };
  }
  if (value < inputMin || value > inputMax) {
    return { ok: false, reason: `binding_input_value_out_of_range:${axis.id}:${binding.parameter_id}` };
  }
  const ratio = (value - inputMin) / (inputMax - inputMin);
  const effectiveRatio = binding.invert ? 1 - ratio : ratio;
  const targetValue = outputMin + (outputMax - outputMin) * effectiveRatio;
  const neutralRatio = (axis.neutral - inputMin) / (inputMax - inputMin);
  const neutralTargetValue = outputMin + (outputMax - outputMin)
    * (binding.invert ? 1 - neutralRatio : neutralRatio);
  if (!Number.isFinite(targetValue) || !Number.isFinite(neutralTargetValue)) {
    return { ok: false, reason: `binding_target_not_finite:${axis.id}:${binding.parameter_id}` };
  }
  return { ok: true, targetValue, neutralTargetValue };
}
