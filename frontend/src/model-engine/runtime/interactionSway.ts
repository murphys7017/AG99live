import type { ModelSummary } from "../../types/protocol.js";
import type { InteractionSwayInput } from "../../types/live2d-runtime.d.ts";
import type {
  SemanticAxisDefinition,
  SemanticAxisProfile,
} from "../../types/semantic-axis-profile.js";
import {
  mapSemanticBindingDynamics,
  mapSemanticBindingValue,
} from "../compiler/semanticParameterBinding.js";

export function buildThinkingSwayInput(model: ModelSummary): InteractionSwayInput | null {
  const profile = model.semantic_axis_profile;
  if (!profile) {
    return null;
  }
  const axis = selectLateralAxis(profile);
  if (!axis) {
    return null;
  }
  const negativeValue = axis.level_anchors?.["-1"];
  const positiveValue = axis.level_anchors?.["1"];
  if (!Number.isFinite(negativeValue) || !Number.isFinite(positiveValue)) {
    return null;
  }
  const resolvedNegativeValue = Number(negativeValue);
  const resolvedPositiveValue = Number(positiveValue);

  const bindings: InteractionSwayInput["bindings"] = [];
  for (const binding of axis.parameter_bindings) {
    const neutral = mapSemanticBindingValue(axis, binding, axis.neutral);
    const negative = mapSemanticBindingValue(axis, binding, resolvedNegativeValue);
    const positive = mapSemanticBindingValue(axis, binding, resolvedPositiveValue);
    if (!neutral.ok || !negative.ok || !positive.ok) {
      return null;
    }
    const dynamics = mapSemanticBindingDynamics(axis, binding);
    bindings.push({
      parameterId: binding.parameter_id,
      neutralValue: neutral.targetValue,
      negativeValue: negative.targetValue,
      positiveValue: positive.targetValue,
      weight: binding.default_weight,
      maxVelocity: dynamics.max_velocity,
      maxAcceleration: dynamics.max_acceleration,
      response: dynamics.response,
    });
  }
  if (!bindings.length) {
    return null;
  }
  return {
    axisId: axis.id,
    // A complete left-right cycle takes four seconds; this remains visibly alive
    // without competing with an eventual reply gesture.
    cycleMs: 4000,
    attackMs: 500,
    releaseMs: 650,
    bindings,
  };
}

function selectLateralAxis(profile: SemanticAxisProfile): SemanticAxisDefinition | null {
  return profile.axes
    .filter((axis) => (
      (axis.control_role === "primary" || axis.control_role === "hint")
      && hasLateralAnchors(axis)
      && axis.parameter_bindings.length > 0
      && lateralAxisPriority(axis) !== null
    ))
    .sort((left, right) => lateralAxisPriority(left)! - lateralAxisPriority(right)!)[0]
    ?? null;
}

function hasLateralAnchors(axis: SemanticAxisDefinition): boolean {
  return ["-1", "1"].every((level) => (
    typeof axis.level_anchors?.[level] === "number"
    && Number.isFinite(axis.level_anchors[level])
  ));
}

function lateralAxisPriority(axis: SemanticAxisDefinition): number | null {
  const id = axis.id.toLowerCase();
  const text = `${axis.label} ${axis.description} ${axis.usage_notes}`.toLowerCase();
  if (id === "gaze_x" || id === "head_yaw") return 0;
  if (id === "head_roll") return 1;
  if (id === "body_yaw" || id === "body_roll") return 2;
  if (/(?:gaze|yaw|roll|左右|扭头|摇摆)/u.test(`${id} ${text}`)) return 3;
  return null;
}
