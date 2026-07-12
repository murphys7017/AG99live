import type { SemanticParameterPlan, VoiceFollowingChannelProfile } from "../../../types/protocol.js";
import type {
  MotionCompileContext,
  MotionCompileStage,
  MotionStageResult,
} from "../compileContext.js";

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
      invalidParameterIds.push(
        String(channel?.parameter_id || channel?.channel || "unknown_channel"),
      );
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
    && Number.isFinite(channel.output_range.max)
    && typeof channel.frequency_hz === "number"
    && Number.isFinite(channel.frequency_hz)
    && channel.frequency_hz > 0
    && (channel.direction === 1 || channel.direction === -1),
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
  throw new Error(`voice_following_frequency_missing:${channel.channel}`);
}

function resolveVoiceFollowingDirection(
  channel: VoiceFollowingChannelProfile,
): 1 | -1 {
  if (channel.direction === 1 || channel.direction === -1) {
    return channel.direction;
  }
  throw new Error(`voice_following_direction_missing:${channel.channel}`);
}
