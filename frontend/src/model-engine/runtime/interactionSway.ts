import type { ModelSummary } from "../../types/protocol.js";
import type {
  InteractionGazeInput,
  InteractionSwayInput,
} from "../../types/live2d-runtime.d.ts";
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

export function buildCursorGazeInput(
  model: ModelSummary,
  targetRatio: number,
): InteractionGazeInput | null {
  const profile = model.semantic_axis_profile;
  const axes = profile ? selectCursorGazeAxes(profile) : [];
  if (!axes.length || !Number.isFinite(targetRatio)) {
    return null;
  }
  const bindings: InteractionGazeInput["bindings"] = [];
  for (const { axis, targetRatioScale } of axes) {
    const negativeValue = axis.level_anchors?.["-1"];
    const positiveValue = axis.level_anchors?.["1"];
    if (!Number.isFinite(negativeValue) || !Number.isFinite(positiveValue)) {
      continue;
    }
    for (const binding of axis.parameter_bindings) {
      const neutral = mapSemanticBindingValue(axis, binding, axis.neutral);
      const negative = mapSemanticBindingValue(axis, binding, Number(negativeValue));
      const positive = mapSemanticBindingValue(axis, binding, Number(positiveValue));
      if (!neutral.ok || !negative.ok || !positive.ok) {
        continue;
      }
      const dynamics = resolveCursorGazeDynamics(
        axis,
        mapSemanticBindingDynamics(axis, binding),
      );
      bindings.push({
        axisId: axis.id,
        targetRatioScale,
        parameterId: binding.parameter_id,
        neutralValue: neutral.targetValue,
        negativeValue: negative.targetValue,
        positiveValue: positive.targetValue,
        weight: binding.default_weight,
        maxVelocity: dynamics.maxVelocity,
        maxAcceleration: dynamics.maxAcceleration,
        response: dynamics.response,
      });
    }
  }
  if (!bindings.length) {
    return null;
  }
  return {
    axisId: axes[0].axis.id,
    targetRatio: Math.max(-1, Math.min(1, targetRatio)),
    bindings,
  };
}

function selectCursorGazeAxes(
  profile: SemanticAxisProfile,
): Array<{ axis: SemanticAxisDefinition; targetRatioScale: number }> {
  const gazeAxis = selectGazeAxis(profile);
  const headAxis = selectHeadGazeAxis(profile, gazeAxis?.id ?? null);
  if (gazeAxis && headAxis) {
    return [
      { axis: gazeAxis, targetRatioScale: 1 },
      { axis: headAxis, targetRatioScale: 0.58 },
    ];
  }
  if (gazeAxis) {
    return [{ axis: gazeAxis, targetRatioScale: 1 }];
  }
  if (headAxis) {
    return [{ axis: headAxis, targetRatioScale: 0.72 }];
  }
  return [];
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

function selectGazeAxis(profile: SemanticAxisProfile): SemanticAxisDefinition | null {
  return profile.axes
    .filter((axis) => (
      (axis.control_role === "primary" || axis.control_role === "hint")
      && hasLateralAnchors(axis)
      && axis.parameter_bindings.length > 0
      && gazeAxisPriority(axis) !== null
    ))
    .sort((left, right) => gazeAxisPriority(left)! - gazeAxisPriority(right)!)[0]
    ?? null;
}

function selectHeadGazeAxis(
  profile: SemanticAxisProfile,
  excludedAxisId: string | null,
): SemanticAxisDefinition | null {
  return profile.axes
    .filter((axis) => (
      axis.id !== excludedAxisId
      && (axis.control_role === "primary" || axis.control_role === "hint")
      && hasLateralAnchors(axis)
      && axis.parameter_bindings.length > 0
      && headGazeAxisPriority(axis) !== null
    ))
    .sort((left, right) => headGazeAxisPriority(left)! - headGazeAxisPriority(right)!)[0]
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

function gazeAxisPriority(axis: SemanticAxisDefinition): number | null {
  const id = axis.id.toLowerCase();
  const text = `${axis.label} ${axis.description} ${axis.usage_notes}`.toLowerCase();
  if (id === "gaze_x") return 0;
  if (/(?:gaze|视线|眼神)/u.test(`${id} ${text}`)) return 1;
  return null;
}

function headGazeAxisPriority(axis: SemanticAxisDefinition): number | null {
  const id = axis.id.toLowerCase();
  const text = `${axis.label} ${axis.description} ${axis.usage_notes}`.toLowerCase();
  if (id === "head_yaw") return 0;
  if (/(?:yaw|扭头|左右)/u.test(`${id} ${text}`)
    && axis.semantic_group === "head") {
    return 1;
  }
  return null;
}

function resolveCursorGazeDynamics(
  axis: SemanticAxisDefinition,
  dynamics: ReturnType<typeof mapSemanticBindingDynamics>,
): {
  maxVelocity: number;
  maxAcceleration: number;
  response: typeof dynamics.response;
} {
  const group = axis.semantic_group.trim().toLowerCase();
  const velocityScale = group === "head" ? 0.42 : 0.58;
  const accelerationScale = group === "head" ? 0.3 : 0.42;
  const response = dynamics.response.kind === "spring"
    ? {
      kind: "spring" as const,
      frequency_hz: Math.max(1.6, dynamics.response.frequency_hz * 0.72),
      damping_ratio: Math.max(0.84, dynamics.response.damping_ratio),
    }
    : dynamics.response;
  return {
    maxVelocity: Math.max(1, dynamics.max_velocity * velocityScale),
    maxAcceleration: Math.max(1, dynamics.max_acceleration * accelerationScale),
    response,
  };
}
