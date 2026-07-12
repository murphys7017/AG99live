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

  const voiceFollowingResult = buildVoiceFollowingParameters(context);
  if (voiceFollowingResult.invalidParameterIds.length > 0) {
    return {
      ok: false,
      reason: `speech_pose_parameter_duplicate:${voiceFollowingResult.invalidParameterIds.join(",")}`,
    };
  }

  const directParameters = voiceFollowingResult.parameters;
  context.state.pendingParameterModulations = {
    ...context.state.pendingParameterModulations,
    ...voiceFollowingResult.pendingModulations,
  };
  if (directParameters.length > 0 || Object.keys(voiceFollowingResult.pendingModulations).length > 0) {
    context.state.parameters = [
      ...context.state.parameters,
      ...directParameters,
    ];
    context.state.warnings = [
      ...context.state.warnings,
      ...directParameters.map((item) => `speech_pose_applied:${item.parameter_id}`),
      ...Object.keys(voiceFollowingResult.pendingModulations).map(
        (parameterId) => `speech_pose_modulation_pending:${parameterId}`,
      ),
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
): {
  parameters: SemanticParameterPlan["parameters"];
  pendingModulations: MotionCompileContext["state"]["pendingParameterModulations"];
  invalidParameterIds: string[];
} {
  const profile = context.options.model.voice_following_profile;
  if (!profile || profile.schema_version !== "ag99.voice_following_profile.v1") {
    return { parameters: [], pendingModulations: {}, invalidParameterIds: [] };
  }

  const parameters: SemanticParameterPlan["parameters"] = [];
  const pendingModulations: MotionCompileContext["state"]["pendingParameterModulations"] = {};
  const invalidParameterIds: string[] = [];
  const existingParameterIds = new Set(
    context.state.parameters.map((item) => item.parameter_id),
  );
  const controlledParameterIds = collectControlledParameterIds(context);
  for (const channel of Object.values(profile.channels ?? {})) {
    if (!isUsableVoiceFollowingChannel(channel)) {
      continue;
    }
    const modulation: NonNullable<SemanticParameterPlan["parameters"][number]["modulation"]> = {
      kind: "speech_pose_cycle",
      neutral: channel.neutral,
      amplitude: channel.amplitude * channel.weight,
      phase: channel.phase,
      frequency_hz: resolveVoiceFollowingFrequencyHz(channel),
      direction: resolveVoiceFollowingDirection(channel),
    };
    if (existingParameterIds.has(channel.parameter_id)) {
      const existing = parameters.find((item) => item.parameter_id === channel.parameter_id)
        ?? context.state.parameters.find((item) => item.parameter_id === channel.parameter_id);
      if (!existing || existing.modulation) {
        invalidParameterIds.push(channel.parameter_id);
      } else {
        existing.modulation = modulation;
      }
      continue;
    }
    if (controlledParameterIds.has(channel.parameter_id)) {
      if (pendingModulations[channel.parameter_id]) {
        invalidParameterIds.push(channel.parameter_id);
      } else {
        pendingModulations[channel.parameter_id] = modulation;
      }
      continue;
    }

    parameters.push({
      axis_id: `voice_following.${channel.channel}`,
      parameter_id: channel.parameter_id,
      target_value: channel.neutral,
      neutral_target_value: channel.neutral,
      weight: channel.weight,
      input_value: channel.neutral,
      source: "speech_pose",
      modulation,
      dynamics: buildVoiceFollowingDynamics(channel),
    });
    existingParameterIds.add(channel.parameter_id);
  }
  return {
    parameters,
    pendingModulations,
    invalidParameterIds: [...new Set(invalidParameterIds)],
  };
}

function buildVoiceFollowingDynamics(
  channel: VoiceFollowingChannelProfile,
): NonNullable<SemanticParameterPlan["parameters"][number]["dynamics"]> {
  const weightedAmplitude = channel.amplitude * channel.weight;
  const angularFrequency = Math.PI * 2 * resolveVoiceFollowingFrequencyHz(channel);
  return {
    max_velocity: Math.max(0.01, weightedAmplitude * angularFrequency * 1.25),
    max_acceleration: Math.max(
      0.01,
      weightedAmplitude * angularFrequency * angularFrequency * 1.25,
    ),
    life_motion_scale: 0,
    max_speech_offset: Math.min(
      weightedAmplitude,
      Math.max(0, (channel.output_range.max - channel.output_range.min) / 2),
    ),
  };
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

  // The relation graph runs after this stage. Reserve parameters for relation
  // targets that will be derived from an active source so voice-following
  // cannot introduce a duplicate binding before the graph is evaluated.
  const pendingRelationTargets = collectPendingRelationTargetAxisIds(context);
  for (const axisId of pendingRelationTargets) {
    const targetAxis = context.state.axisById.get(axisId);
    if (!targetAxis) {
      continue;
    }
    for (const binding of targetAxis.parameter_bindings) {
      parameterIds.add(binding.parameter_id);
    }
  }
  return parameterIds;
}

function collectPendingRelationTargetAxisIds(
  context: MotionCompileContext,
): Set<string> {
  const pendingTargets = new Set<string>();
  const profile = context.state.profile;
  if (!profile) {
    return pendingTargets;
  }

  for (const relation of profile.relation_graph.edges) {
    if (context.state.allAxisValues[relation.target_axis_id] !== undefined) {
      continue;
    }
    const sourceValue = context.state.allAxisValues[relation.source_axis_id];
    const sourceAxis = context.state.axisById.get(relation.source_axis_id);
    const targetAxis = context.state.axisById.get(relation.target_axis_id);
    if (
      sourceValue === undefined
      || !sourceAxis
      || !targetAxis
      || Math.abs(sourceValue - sourceAxis.neutral) <= relation.deadzone
    ) {
      continue;
    }
    pendingTargets.add(relation.target_axis_id);
  }
  return pendingTargets;
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
      return 0.48;
    case "body_pitch":
      return 0.30;
    case "head_yaw":
      return 0.48;
    case "head_roll":
      return 0.56;
    case "body_yaw":
      return 0.26;
    case "body_roll":
      return 0.30;
    default:
      return 0.40;
  }
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
  const pendingRelationTargets = collectPendingRelationTargetAxisIds(context);
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
    if (pendingRelationTargets.has(axis.id)) {
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
 * 从轴元数据推断说话跟随偏移方向。
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
