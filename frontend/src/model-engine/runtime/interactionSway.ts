import type { ModelSummary } from "../../types/protocol.js";
import type {
  GazeTarget,
  GazeAlignment,
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
  const match = selectLateralAxis(profile);
  if (!match) {
    return null;
  }
  const { axis } = match;
  const bindings = mapPostureBindings(
    axis, match.parameterBindings, axis.level_anchors?.["-1"], axis.level_anchors?.["1"],
  );
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

function mapPostureBindings(
  axis: SemanticAxisDefinition,
  parameterBindings: SemanticAxisDefinition["parameter_bindings"],
  negativeValue: number | undefined,
  positiveValue: number | undefined,
): InteractionSwayInput["bindings"] {
  if (!Number.isFinite(negativeValue) || !Number.isFinite(positiveValue)) {
    return [];
  }
  const resolvedNegativeValue = Number(negativeValue);
  const resolvedPositiveValue = Number(positiveValue);

  const bindings: InteractionSwayInput["bindings"] = [];
  for (const binding of parameterBindings) {
    const neutral = mapSemanticBindingValue(axis, binding, axis.neutral);
    const negative = mapSemanticBindingValue(axis, binding, resolvedNegativeValue);
    const positive = mapSemanticBindingValue(axis, binding, resolvedPositiveValue);
    if (!neutral.ok || !negative.ok || !positive.ok) {
      return [];
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
  return bindings;
}

export function buildSpeechPostureBindings(model: ModelSummary | null): InteractionSwayInput["bindings"] {
  const profile = model?.semantic_axis_profile;
  const channels = model?.voice_following_profile?.channels;
  if (!profile || !channels) return [];

  const result: InteractionSwayInput["bindings"] = [];
  const used = new Set<string>();
  for (const alternatives of [["head_roll", "head_yaw", "head_pitch"], ["body_roll", "body_yaw"]]) {
    for (const name of alternatives) {
      const channel = channels[name];
      if (!channel || !(channel.amplitude_ratio > 0)) continue;
      const axis = profile.axes.find(item => item.id === channel.semantic_axis_id);
      if (!axis) continue;
      const [minimum, maximum] = axis.value_range;
      const excursion = (maximum - minimum) * axis.dynamics.max_speech_offset_ratio;
      if (!(excursion > 0)) continue;
      const activeBindings = axis.parameter_bindings.filter(binding => binding.default_weight > 0);
      if (!activeBindings.length) continue;
      // One semantic pose must be reachable by every participating parameter.
      const low = Math.max(minimum, axis.neutral - excursion, ...activeBindings.map(b => b.input_range[0]));
      const high = Math.min(maximum, axis.neutral + excursion, ...activeBindings.map(b => b.input_range[1]));
      if (low > axis.neutral || high < axis.neutral || low === high) continue;
      const bindings = mapPostureBindings(axis, activeBindings, low, high);
      const before = result.length;
      for (const binding of bindings) {
        if (!binding.weight || used.has(binding.parameterId)) continue;
        used.add(binding.parameterId);
        result.push({
          ...binding,
          axisId: axis.id,
          targetRatioScale: channel.amplitude_ratio,
          onsetDelayMs: channel.follow_delay_ms,
        });
      }
      if (result.length > before) break;
    }
  }
  return result;
}

export function buildCursorGazeInput(
  model: ModelSummary,
  target: GazeTarget,
  stage: "eyes" | "full" | "listening" = "full",
  alignment: GazeAlignment = { head: 0.58, body: 0.2 },
): InteractionGazeInput | null {
  const profile = model.semantic_axis_profile;
  const axes = profile ? selectCursorGazeAxes(profile, stage) : [];
  const coordinated = profile?.model_id === "Mk6_1.0" && stage !== "listening"
    && axes.some(match => match.parameterBindings.some(b => b.parameter_id === gazeX.parameter));
  if (coordinated && stage === "full") {
    if (![alignment.head, alignment.body].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
      return null;
    }
    const head = axes.find(match => match.parameterBindings.some(b => b.parameter_id === headYaw.parameter));
    if (head) head.targetRatioScale = alignment.head;
    const body = matchInteractionAxis(eligibleInteractionAxes(profile), bodyYaw);
    if (body && alignment.body > 0) {
      axes.push({ ...body, targetComponent: "horizontalRatio", targetRatioScale: alignment.body });
    }
  }
  if (!axes.length || !Number.isFinite(target.horizontalRatio) || !Number.isFinite(target.verticalRatio)) {
    return null;
  }
  const bindings: Array<InteractionGazeInput["bindings"][number] & { axisId: string }> = [];
  const boundParameters = new Set<string>();
  for (const { axis, parameterBindings, targetComponent, targetRatioScale, onsetDelayMs } of axes) {
    const negativeValue = axis.level_anchors?.["-1"];
    const positiveValue = axis.level_anchors?.["1"];
    if (!Number.isFinite(negativeValue) || !Number.isFinite(positiveValue)) {
      continue;
    }
    for (const binding of parameterBindings) {
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
        onsetDelayMs,
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
    // Mk6: a level-one head turn (+/-11.2 on ParamAngleX) settles at
    // +/-8.83 on PhyAngleX. Body yaw alone does not displace facial landmarks.
    horizontalHeadFeedback: coordinated
      ? { parameterId: "PhyAngleX", neutral: 0, eyeUnitsPerHeadUnit: 0.2 / 8.83 } : undefined,
    axisId: bindings[0].axisId,
    target: { horizontalRatio: target.horizontalRatio, verticalRatio: target.verticalRatio },
    bindings,
  };
}

interface InteractionAxisRole {
  axisId: string;
  parameter: string;
  group: string;
  direction: RegExp;
}

const yaw = /yaw|horizontal|左右|扭头/iu;
const roll = /roll|侧倾/iu;
const headRoll = { axisId: "head_roll", parameter: "ParamAngleZ", group: "head", direction: roll };
const headYaw = { axisId: "head_yaw", parameter: "ParamAngleX", group: "head", direction: yaw };
const headPitch = { axisId: "head_pitch", parameter: "ParamAngleY", group: "head", direction: /pitch|vertical|上下|俯仰/iu };
const bodyRoll = { axisId: "body_roll", parameter: "ParamBodyAngleZ", group: "body", direction: roll };
const bodyYaw = { axisId: "body_yaw", parameter: "ParamBodyAngleX", group: "body", direction: yaw };
const gazeX = { axisId: "gaze_x", parameter: "ParamEyeBallX", group: "gaze", direction: /horizontal|left[-_ ]right|左右/iu };
const gazeY = { axisId: "gaze_y", parameter: "ParamEyeBallY", group: "gaze", direction: /vertical|up[-_ ]down|上下/iu };
const standardParameters = new Set([
  headRoll.parameter, headYaw.parameter, headPitch.parameter, bodyRoll.parameter, bodyYaw.parameter,
  "ParamBodyAngleY", gazeX.parameter, gazeY.parameter,
]);

function eligibleInteractionAxes(profile: SemanticAxisProfile) {
  return profile.axes.filter((axis) =>
    (axis.control_role === "primary" || axis.control_role === "hint")
    && ["-1", "1"].every((level) => Number.isFinite(axis.level_anchors?.[level]))
    && axis.parameter_bindings.length > 0)
    .sort((left, right) => Number(left.control_role !== "primary") - Number(right.control_role !== "primary")
      || left.id.localeCompare(right.id, "en"));
}

interface InteractionAxisMatch {
  axis: SemanticAxisDefinition;
  parameterBindings: SemanticAxisDefinition["parameter_bindings"];
  rank: number;
}

function matchInteractionAxis(axes: SemanticAxisDefinition[], role: InteractionAxisRole) {
  let best: InteractionAxisMatch | undefined;
  for (const axis of axes) {
    const named = axis.id.toLowerCase() === role.axisId;
    const described = axis.semantic_group === role.group && role.direction.test(`${axis.id} ${axis.label}`);
    const explicit = axis.parameter_bindings.filter(binding => binding.default_weight > 0 && binding.interaction_role === role.axisId);
    const parameterBindings = explicit.length ? explicit : axis.parameter_bindings.filter((binding) =>
      !binding.interaction_role && binding.default_weight > 0 && (binding.parameter_id === role.parameter
        || ((named || described) && !standardParameters.has(binding.parameter_id))));
    if (!parameterBindings.length) continue;
    const standard = parameterBindings.some((binding) => binding.parameter_id === role.parameter);
    const rank = explicit.length ? -1 : named ? 0 : standard ? 1 : 2;
    if (!best || rank < best.rank) best = { axis, parameterBindings, rank };
  }
  return best;
}

function selectLateralAxis(profile: SemanticAxisProfile) {
  const axes = eligibleInteractionAxes(profile);
  let described: InteractionAxisMatch | undefined;
  for (const role of [headRoll, headYaw, bodyRoll, bodyYaw]) {
    const match = matchInteractionAxis(axes, role);
    if (match && match.rank < 2) return match;
    described ??= match;
  }
  return described ?? matchInteractionAxis(axes, gazeX);
}

function selectCursorGazeAxes(profile: SemanticAxisProfile, stage: "eyes" | "full" | "listening") {
  const axes = eligibleInteractionAxes(profile);
  const result: Array<InteractionAxisMatch & {
    targetComponent: keyof GazeTarget;
    targetRatioScale: number;
    onsetDelayMs?: number;
  }> = [];
  if (stage === "listening") {
    for (const axis of axes) {
      const parameterBindings = axis.parameter_bindings.filter(b => b.interaction_role === "listening" && b.default_weight > 0);
      if (parameterBindings.length) result.push({ axis, parameterBindings, rank: -1, targetComponent: "verticalRatio", targetRatioScale: 1 });
    }
    if (result.length) return result;
  }
  function addDirection(targetComponent: keyof GazeTarget, eyeRole: InteractionAxisRole, headRole: InteractionAxisRole) {
    const eye = matchInteractionAxis(axes, eyeRole);
    if (eye) result.push({ ...eye, targetComponent, targetRatioScale: 1 });
    const listeningPitch = stage === "listening" && targetComponent === "verticalRatio";
    if (stage === "full" || listeningPitch) {
      const head = matchInteractionAxis(axes, headRole);
      if (head) result.push({
        ...head,
        targetComponent,
        targetRatioScale: eye ? 0.58 : 0.72,
        // A short utterance can register in the eyes alone.
        onsetDelayMs: listeningPitch && eye ? 250 : 0,
      });
    }
  }
  addDirection("horizontalRatio", gazeX, headYaw);
  addDirection("verticalRatio", gazeY, headPitch);
  return result;
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
