import type { ModelSummary } from "../../types/protocol.js";
import type {
  GazeTarget,
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
    delayMs: 350,
    attackMs: 500,
    holdMs: 450,
    bindings,
  };
}

export function buildCursorGazeInput(
  model: ModelSummary,
  target: GazeTarget,
): InteractionGazeInput | null {
  const profile = model.semantic_axis_profile;
  const axes = profile ? selectCursorGazeAxes(profile) : [];
  if (!axes.length || !Number.isFinite(target.horizontalRatio) || !Number.isFinite(target.verticalRatio)) {
    return null;
  }
  const bindings: InteractionGazeInput["bindings"] = [];
  const boundParameters = new Set<string>();
  for (const { axis, targetComponent, targetRatioScale } of axes) {
    const negativeValue = axis.level_anchors?.["-1"];
    const positiveValue = axis.level_anchors?.["1"];
    if (!Number.isFinite(negativeValue) || !Number.isFinite(positiveValue)) {
      continue;
    }
    for (const binding of axis.parameter_bindings) {
      if (boundParameters.has(binding.parameter_id)) continue;
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
      boundParameters.add(binding.parameter_id);
      bindings.push({
        axisId: axis.id,
        targetComponent,
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
    target: { horizontalRatio: target.horizontalRatio, verticalRatio: target.verticalRatio },
    bindings,
  };
}

function selectCursorGazeAxes(profile: SemanticAxisProfile) {
  const eligible = profile.axes.filter((axis) =>
    (axis.control_role === "primary" || axis.control_role === "hint")
    && hasLateralAnchors(axis) && axis.parameter_bindings.length > 0);
  const result: Array<{
    axis: SemanticAxisDefinition;
    targetComponent: keyof GazeTarget;
    targetRatioScale: number;
  }> = [];
  const resolve = (id: string, parameter: string, group: "gaze" | "head", direction: RegExp) =>
      eligible.find((axis) => axis.id.toLowerCase() === id)
      ?? eligible.find((axis) => axis.parameter_bindings.some((binding) => binding.parameter_id === parameter))
      ?? eligible.find((axis) => axis.semantic_group === group && direction.test(`${axis.id} ${axis.label}`));
  const addDirection = (
    targetComponent: keyof GazeTarget,
    eye: SemanticAxisDefinition | undefined,
    head: SemanticAxisDefinition | undefined,
  ) => {
    if (eye) {
      result.push({ axis: eye, targetComponent, targetRatioScale: 1 });
    }
    if (head && head !== eye) {
      result.push({ axis: head, targetComponent, targetRatioScale: eye ? 0.58 : 0.72 });
    }
  };
  const horizontal = /horizontal|left[-_ ]right|左右/iu;
  const vertical = /vertical|up[-_ ]down|上下/iu;
  addDirection("horizontalRatio",
    resolve("gaze_x", "ParamEyeBallX", "gaze", horizontal),
    resolve("head_yaw", "ParamAngleX", "head", /yaw|horizontal|左右|扭头/iu));
  addDirection("verticalRatio",
    resolve("gaze_y", "ParamEyeBallY", "gaze", vertical),
    resolve("head_pitch", "ParamAngleY", "head", /pitch|vertical|上下|俯仰/iu));
  return result;
}

function selectLateralAxis(profile: SemanticAxisProfile): SemanticAxisDefinition | null {
  let best: SemanticAxisDefinition | null = null;
  let bestPriority = Infinity;
  for (const axis of profile.axes) {
    if ((axis.control_role !== "primary" && axis.control_role !== "hint")
      || !hasLateralAnchors(axis) || !axis.parameter_bindings.length) continue;
    const priority = lateralAxisPriority(axis);
    if (priority === null) continue;
    if (!best || priority < bestPriority || (priority === bestPriority && axis.id < best.id)) {
      best = axis;
      bestPriority = priority;
    }
  }
  return best;
}

function hasLateralAnchors(axis: SemanticAxisDefinition): boolean {
  return ["-1", "1"].every((level) => (
    typeof axis.level_anchors?.[level] === "number"
    && Number.isFinite(axis.level_anchors[level])
  ));
}

function lateralAxisPriority(axis: SemanticAxisDefinition): number | null {
  const id = axis.id.toLowerCase();
  const binds = (parameter: string) => axis.parameter_bindings.some((binding) => binding.parameter_id === parameter);
  if (id === "head_roll" || binds("ParamAngleZ")) return 0;
  if (id === "head_yaw" || binds("ParamAngleX")) return 1;
  if (id === "body_roll" || id === "body_yaw" || binds("ParamBodyAngleZ") || binds("ParamBodyAngleX")) return 2;
  if ((axis.semantic_group === "head" || axis.semantic_group === "body")
    && /yaw|roll|侧倾|左右|扭头/iu.test(`${id} ${axis.label}`)) return 3;
  if (id === "gaze_x" || binds("ParamEyeBallX")
    || (axis.semantic_group === "gaze" && /horizontal|left[-_ ]right|左右/iu.test(`${id} ${axis.label}`))) return 4;
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
