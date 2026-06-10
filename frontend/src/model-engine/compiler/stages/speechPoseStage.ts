import type { SemanticAxisDefinition } from "../../../types/semantic-axis-profile.js";
import type { SemanticParameterPlan, VoiceFollowingChannelProfile } from "../../../types/protocol.js";
import type {
  DynamicAxisValues,
  MotionCompileContext,
  MotionCompileStage,
  MotionStageResult,
} from "../compileContext.js";
import { mergeDerivedAxisValues, refreshAllAxisValues } from "../compileContext.js";

const SPEECH_POSE_GROUPS = new Set(["head", "body", "torso", "shoulder"]);
const SPEECH_POSE_KEYWORDS = [
  "speech",
  "speaking",
  "talk",
  "voice",
  "vocal",
  "说话",
  "讲话",
  "发声",
];

// Reads:
// - context.options.speechActive
// - context.options.model.voice_following_profile
// - context.state.profile
// - context.state.axisById
// - context.state.controlledValues
// - context.state.derivedValues
// - context.state.allAxisValues
// - context.state.warnings
//
// Writes:
// - context.state.derivedValues
// - context.state.axisValueSources
// - context.state.appliedDerivedAxes
// - context.state.allAxisValues
// - context.state.parameters
// - context.state.warnings
//
// Does not own:
// - controlled axis values
// - mode resolution
// - timing
export const speechPoseStage: MotionCompileStage = {
  id: "speechPose",
  run: runSpeechPoseStage,
};

export function runSpeechPoseStage(
  context: MotionCompileContext,
): MotionStageResult {
  if (context.options.speechActive !== true) {
    return { ok: true };
  }

  const profile = context.state.profile;
  if (!profile) {
    return { ok: false, reason: "semantic_profile_missing" };
  }

  const directParameters = buildVoiceFollowingParameters(context);
  if (directParameters.length > 0) {
    context.state.parameters = [
      ...context.state.parameters,
      ...directParameters,
    ];
    context.state.warnings = [
      ...context.state.warnings,
      ...directParameters.map((item) => `speech_pose_applied:${item.parameter_id}`),
    ];
    return { ok: true };
  }

  const candidateAxes = selectSpeechPoseAxes(context);
  if (!candidateAxes.length) {
    context.state.warnings = [
      ...context.state.warnings,
      "speech_pose_skipped_no_candidate_axis",
    ];
    return { ok: true };
  }

  const values = buildSpeechPoseValues(candidateAxes, context);
  const axisIds = Object.keys(values);
  if (!axisIds.length) {
    return { ok: true };
  }

  mergeDerivedAxisValues(context.state, values, "speech_pose");
  refreshAllAxisValues(context.state);
  context.state.warnings = [
    ...context.state.warnings,
    ...axisIds.map((axisId) => `speech_pose_applied:${axisId}`),
  ];

  return { ok: true };
}

function buildVoiceFollowingParameters(
  context: MotionCompileContext,
): SemanticParameterPlan["parameters"] {
  const profile = context.options.model.voice_following_profile;
  if (!profile || profile.schema_version !== "ag99.voice_following_profile.v1") {
    return [];
  }

  const parameters: SemanticParameterPlan["parameters"] = [];
  const existingParameterIds = new Set(
    context.state.parameters.map((item) => item.parameter_id),
  );
  const controlledParameterIds = collectControlledParameterIds(context);
  for (const channel of Object.values(profile.channels ?? {})) {
    if (!isUsableVoiceFollowingChannel(channel)) {
      continue;
    }
    if (
      existingParameterIds.has(channel.parameter_id)
      || controlledParameterIds.has(channel.parameter_id)
    ) {
      context.state.warnings = [
        ...context.state.warnings,
        `speech_pose_skipped_existing_parameter:${channel.parameter_id}`,
      ];
      continue;
    }

    const targetValue = resolveVoiceFollowingTargetValue(channel);
    parameters.push({
      axis_id: `voice_following.${channel.channel}`,
      parameter_id: channel.parameter_id,
      target_value: targetValue,
      weight: channel.weight,
      input_value: channel.neutral,
      source: "speech_pose",
      modulation: {
        kind: "speech_pose_cycle",
        neutral: channel.neutral,
        amplitude: channel.amplitude,
        phase: channel.phase,
        frequency_hz: resolveVoiceFollowingFrequencyHz(channel),
      },
    });
    existingParameterIds.add(channel.parameter_id);
  }
  return parameters;
}

function collectControlledParameterIds(
  context: MotionCompileContext,
): Set<string> {
  const parameterIds = new Set<string>();
  for (const axisId of Object.keys(context.state.allAxisValues)) {
    const axis = context.state.axisById.get(axisId);
    if (!axis) {
      continue;
    }
    for (const binding of axis.parameter_bindings) {
      parameterIds.add(binding.parameter_id);
    }
  }
  return parameterIds;
}

function isUsableVoiceFollowingChannel(
  channel: VoiceFollowingChannelProfile,
): boolean {
  return Boolean(
    channel
    && typeof channel.channel === "string"
    && channel.channel.trim()
    && typeof channel.parameter_id === "string"
    && channel.parameter_id.trim()
    && typeof channel.neutral === "number"
    && Number.isFinite(channel.neutral)
    && typeof channel.amplitude === "number"
    && Number.isFinite(channel.amplitude)
    && channel.amplitude > 0
    && typeof channel.weight === "number"
    && Number.isFinite(channel.weight)
    && channel.weight > 0
    && typeof channel.output_range === "object"
    && channel.output_range !== null
    && typeof channel.output_range.min === "number"
    && Number.isFinite(channel.output_range.min)
    && typeof channel.output_range.max === "number"
    && Number.isFinite(channel.output_range.max),
  );
}

function resolveVoiceFollowingFrequencyHz(
  channel: VoiceFollowingChannelProfile,
): number {
  if (
    typeof channel.frequency_hz === "number"
    && Number.isFinite(channel.frequency_hz)
    && channel.frequency_hz > 0
  ) {
    return channel.frequency_hz;
  }
  return defaultVoiceFollowingFrequencyHz(channel.channel);
}

function defaultVoiceFollowingFrequencyHz(channelName: string): number {
  switch (channelName) {
    case "head_pitch":
      return 0.68;
    case "body_pitch":
      return 0.55;
    case "head_yaw":
      return 1.35;
    case "head_roll":
      return 1.45;
    case "body_yaw":
      return 1.15;
    case "body_roll":
      return 1.2;
    default:
      return 1.2;
  }
}

function resolveVoiceFollowingTargetValue(
  channel: VoiceFollowingChannelProfile,
): number {
  const minValue = channel.output_range.min;
  const maxValue = channel.output_range.max;
  const direction = resolveVoiceFollowingDirection(channel);
  const rawTarget = channel.neutral + direction * channel.amplitude;
  return Math.max(minValue, Math.min(maxValue, rawTarget));
}

function resolveVoiceFollowingDirection(
  channel: VoiceFollowingChannelProfile,
): 1 | -1 {
  if (channel.direction === 1 || channel.direction === -1) {
    return channel.direction;
  }
  return defaultVoiceFollowingDirection(channel.channel);
}

function defaultVoiceFollowingDirection(channelName: string): 1 | -1 {
  switch (channelName) {
    case "head_yaw":
    case "body_yaw":
    case "head_roll":
    case "body_roll":
    case "gaze_x":
      return 1;
    case "head_pitch":
    case "body_pitch":
    case "gaze_y":
      return -1;
    default:
      return 1;
  }
}

function selectSpeechPoseAxes(
  context: MotionCompileContext,
): SemanticAxisDefinition[] {
  const profile = context.state.profile;
  if (!profile) {
    return [];
  }

  const axes: SemanticAxisDefinition[] = [];
  for (const axis of profile.axes) {
    if (!isDedicatedSpeechPoseAxis(axis)) {
      continue;
    }
    if (context.state.controlledValues[axis.id] !== undefined) {
      context.state.warnings = [
        ...context.state.warnings,
        `speech_pose_skipped_existing_axis:${axis.id}`,
      ];
      continue;
    }
    if (context.state.derivedValues[axis.id] !== undefined) {
      context.state.warnings = [
        ...context.state.warnings,
        `speech_pose_skipped_existing_axis:${axis.id}`,
      ];
      continue;
    }
    axes.push(axis);
  }
  return axes;
}

function isDedicatedSpeechPoseAxis(axis: SemanticAxisDefinition): boolean {
  if (axis.control_role !== "derived") {
    return false;
  }
  if (!SPEECH_POSE_GROUPS.has(axis.semantic_group)) {
    return false;
  }

  const haystack = [
    axis.id,
    axis.label,
    axis.description,
    axis.usage_notes,
    ...axis.positive_semantics,
    ...axis.negative_semantics,
  ].join(" ").toLowerCase();

  return SPEECH_POSE_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function buildSpeechPoseValues(
  axes: SemanticAxisDefinition[],
  context: MotionCompileContext,
): DynamicAxisValues {
  const values: DynamicAxisValues = {};
  for (const axis of axes) {
    values[axis.id] = resolveSpeechPoseValue(axis, context);
  }
  return values;
}

function resolveSpeechPoseValue(
  axis: SemanticAxisDefinition,
  context: MotionCompileContext,
): number {
  const baseValue = context.state.allAxisValues[axis.id] ?? axis.neutral;
  const [minValue, maxValue] = axis.value_range;
  const [minStrong, maxStrong] = axis.strong_range;
  const positiveRoom = Math.max(0, maxStrong - axis.neutral);
  const negativeRoom = Math.max(0, axis.neutral - minStrong);
  const direction = resolveSpeechPoseAxisDirection(axis);
  const signedRoom = direction >= 0 ? positiveRoom : negativeRoom;
  const delta = signedRoom > 0 ? Math.max(2, signedRoom * 0.45) : 4;
  const targetValue = baseValue + direction * delta;

  return Math.max(minValue, Math.min(maxValue, targetValue));
}

/**
 * 从轴元数据推断说话跟随偏移方向。优先读取语义关键词，最后才 fallback 到旧 hash 方法。
 */
function resolveSpeechPoseAxisDirection(
  axis: SemanticAxisDefinition,
): 1 | -1 {
  const text = [
    axis.id,
    axis.label,
    axis.description,
    ...axis.positive_semantics,
    ...axis.negative_semantics,
  ].join(" ").toLowerCase();

  if (text.includes("down") || text.includes("lower") || text.includes("下沉")) {
    return -1;
  }
  if (text.includes("left") || text.includes("左")) {
    return -1;
  }

  return 1;
}

/**
 * @deprecated 改用 resolveVoiceFollowingDirection() / defaultVoiceFollowingDirection()
 *             或 resolveSpeechPoseAxisDirection()。此函数用字符串 hash 决定方向，
 *             语义不可控，仅作为未迁移模型的兼容 fallback 保留。
 *             命中时会上报 speech_pose_direction_fallback warning。
 */
function stableAxisDirection(axisId: string): 1 | -1 {
  console.warn(
    `[ModelEngine] speech_pose_direction_fallback:${axisId} — ` +
    "axis direction fell back to hash-based resolution. " +
    "Add explicit direction to VoiceFollowingChannelProfile or axis metadata.",
  );
  let hash = 0;
  for (let index = 0; index < axisId.length; index += 1) {
    hash = (hash + axisId.charCodeAt(index)) % 2;
  }
  return hash === 0 ? 1 : -1;
}
