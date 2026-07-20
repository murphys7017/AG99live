import type {
  SemanticParameterPlan,
  VoiceFollowingChannelProfile,
  VoiceFollowingProfile,
} from "../../../types/protocol.js";
import type {
  ModelParameterCompileContext,
  ModelParameterCompileStage,
  ModelParameterStageResult,
} from "../modelParameterCompileContext.js";

type SpeechGesturePreset = NonNullable<
  SemanticParameterPlan["parameters"][number]["modulation"]
>["preset"];

interface NormalizedGesturePoint {
  at: number;
  transition: number;
  value: number;
}

const GESTURE_TEMPLATES: Record<SpeechGesturePreset, NormalizedGesturePoint[]> = {
  calm_explain: [
    { at: 0, transition: 0, value: 0 },
    { at: 0.10, transition: 0.14, value: 0.45 },
    { at: 0.46, transition: 0.16, value: -0.28 },
    { at: 0.72, transition: 0.12, value: 0.18 },
    { at: 0.86, transition: 0.12, value: 0 },
  ],
  lively_chat: [
    { at: 0, transition: 0, value: 0 },
    { at: 0.08, transition: 0.10, value: 0.72 },
    { at: 0.30, transition: 0.12, value: -0.55 },
    { at: 0.52, transition: 0.10, value: 0.62 },
    { at: 0.70, transition: 0.12, value: -0.22 },
    { at: 0.84, transition: 0.14, value: 0 },
  ],
  gentle_support: [
    { at: 0, transition: 0, value: 0 },
    { at: 0.14, transition: 0.18, value: 0.38 },
    { at: 0.50, transition: 0.18, value: -0.24 },
    { at: 0.80, transition: 0.16, value: 0 },
  ],
  emphatic: [
    { at: 0, transition: 0, value: 0 },
    { at: 0.10, transition: 0.08, value: -0.82 },
    { at: 0.30, transition: 0.12, value: 0.28 },
    { at: 0.56, transition: 0.10, value: -0.68 },
    { at: 0.78, transition: 0.16, value: 0 },
  ],
};

// Ordered capability mappings. A preset uses the first channels the current
// model exposes; this is explicit capability selection, not a fallback pose.
const PRESET_CHANNELS: Record<SpeechGesturePreset, string[]> = {
  calm_explain: ["head_yaw", "head_pitch", "head_roll", "body_yaw", "body_pitch"],
  lively_chat: ["head_roll", "head_yaw", "head_pitch", "body_roll", "body_yaw"],
  gentle_support: ["head_roll", "head_pitch", "head_yaw", "body_roll", "body_yaw"],
  emphatic: ["head_pitch", "head_yaw", "head_roll", "body_pitch", "body_yaw"],
};

export const speechPoseStage: ModelParameterCompileStage = {
  id: "speechPose",
  run: runSpeechPoseStage,
};

export function runSpeechPoseStage(
  context: ModelParameterCompileContext,
): ModelParameterStageResult {
  if (context.options.speechActive !== true) {
    return { ok: true };
  }
  if (!context.state.profile) {
    return { ok: false, reason: "semantic_profile_missing" };
  }

  const voiceProfile = context.options.model.voice_following_profile;
  if (!voiceProfile || voiceProfile.schema_version !== "ag99.voice_following_profile.v2") {
    return { ok: true };
  }
  const invalidChannels = Object.values(voiceProfile.channels ?? {})
    .filter((channel) => !isUsableVoiceFollowingChannel(channel))
    .map((channel) => String(channel?.parameter_id || channel?.channel || "unknown_channel"));
  if (invalidChannels.length > 0) {
    return {
      ok: false,
      reason: `speech_gesture_channel_invalid:${[...new Set(invalidChannels)].join(",")}`,
    };
  }

  const preset = resolveSpeechGesturePreset(context);
  const durationMs = resolveGestureDurationMs(context);
  if (durationMs === null) {
    return { ok: false, reason: "speech_gesture_timing_missing" };
  }
  const selectedChannels = selectGestureChannels(
    voiceProfile,
    preset,
    context.options.samplingIdentity,
    durationMs,
  );
  if (selectedChannels.length === 0) {
    return { ok: false, reason: `speech_gesture_channels_unavailable:${preset}` };
  }
  const voiceFollowingResult = buildVoiceFollowingParameters(
    context,
    selectedChannels,
    preset,
    durationMs,
  );
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
    context.state.parameters = [...context.state.parameters, ...directParameters];
    context.state.warnings = [
      ...context.state.warnings,
      `speech_gesture_preset:${preset}`,
      ...directParameters.map((item) => `speech_pose_applied:${item.parameter_id}`),
      ...Object.keys(voiceFollowingResult.pendingModulations).map(
        (parameterId) => `speech_pose_modulation_pending:${parameterId}`,
      ),
    ];
  }
  return { ok: true };
}

function buildVoiceFollowingParameters(
  context: ModelParameterCompileContext,
  channels: VoiceFollowingChannelProfile[],
  preset: SpeechGesturePreset,
  durationMs: number,
): {
  parameters: SemanticParameterPlan["parameters"];
  pendingModulations: ModelParameterCompileContext["state"]["pendingParameterModulations"];
  invalidParameterIds: string[];
} {
  const parameters: SemanticParameterPlan["parameters"] = [];
  const pendingModulations: ModelParameterCompileContext["state"]["pendingParameterModulations"] = {};
  const invalidParameterIds: string[] = [];
  const existingParameterIds = new Set(context.state.parameters.map((item) => item.parameter_id));
  const controlledParameterIds = collectControlledParameterIds(context);
  for (const channel of channels) {
    const modulation = buildGestureTrack(
      channel,
      preset,
      durationMs,
      context.options.samplingIdentity,
    );
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
      dynamics: buildVoiceFollowingDynamics(channel, durationMs),
    });
    existingParameterIds.add(channel.parameter_id);
  }
  return { parameters, pendingModulations, invalidParameterIds: [...new Set(invalidParameterIds)] };
}

function buildGestureTrack(
  channel: VoiceFollowingChannelProfile,
  preset: SpeechGesturePreset,
  durationMs: number,
  identity: { turnId: string; messageId: string } | undefined,
): NonNullable<SemanticParameterPlan["parameters"][number]["modulation"]> {
  const activeDurationMs = durationMs - channel.follow_delay_ms;
  const gestureGroup = channel.channel.replace(/^(head|body)_/, "");
  const seed = stableHash(`${identity?.turnId ?? ""}:${identity?.messageId ?? ""}:${preset}:${gestureGroup}`);
  const polarity = preset === "emphatic" && gestureGroup === "pitch"
    ? 1
    : seed % 2 === 0 ? 1 : -1;
  return {
    kind: "speech_gesture_track",
    preset,
    amplitude: channel.amplitude * channel.weight,
    direction: 1,
    delay_ms: channel.follow_delay_ms,
    points: GESTURE_TEMPLATES[preset].map((point) => ({
      at_ms: Math.round(activeDurationMs * point.at),
      transition_ms: Math.round(activeDurationMs * point.transition),
      value: point.value === 0 ? 0 : point.value * polarity,
    })),
  };
}

function resolveSpeechGesturePreset(context: ModelParameterCompileContext): SpeechGesturePreset {
  const hint = context.intent.performance_curve_hint;
  if (hint?.energy === "high" || hint?.curve_family === "pulse_then_settle") {
    return "emphatic";
  }
  if (hint?.energy === "calm" || hint?.energy === "low" || hint?.curve_family === "soft_breathe") {
    return "gentle_support";
  }
  if (hint?.energy === "teasing") {
    return "lively_chat";
  }
  const tags = (context.intent.intent_tags ?? []).join(" ").toLowerCase();
  if (/surpris|angry|惊讶|生气|强调|激动/.test(tags)) {
    return "emphatic";
  }
  if (/comfort|sooth|gentle|安抚|温柔|理解|低落/.test(tags)) {
    return "gentle_support";
  }
  if (/explain|think|说明|解释|思考|认真/.test(tags)) {
    return "calm_explain";
  }
  const identity = context.options.samplingIdentity;
  return stableHash(`${identity?.turnId ?? ""}:${identity?.messageId ?? ""}`) % 2 === 0
    ? "calm_explain"
    : "lively_chat";
}

function selectGestureChannels(
  profile: VoiceFollowingProfile,
  preset: SpeechGesturePreset,
  identity: { turnId: string; messageId: string } | undefined,
  durationMs: number,
): VoiceFollowingChannelProfile[] {
  const channels = profile.channels ?? {};
  const includeBody = preset === "emphatic"
    || stableHash(`${identity?.turnId ?? ""}:${identity?.messageId ?? ""}:body`) % 3 !== 0;
  const selected: VoiceFollowingChannelProfile[] = [];
  let headCount = 0;
  for (const channelName of PRESET_CHANNELS[preset]) {
    const channel = channels[channelName];
    if (!channel || channel.follow_delay_ms > durationMs - 220) {
      continue;
    }
    if (channelName.startsWith("body_")) {
      if (!includeBody || selected.some((item) => item.layer === "body")) {
        continue;
      }
      selected.push(channel);
      continue;
    }
    if (headCount >= 2) {
      continue;
    }
    selected.push(channel);
    headCount += 1;
  }
  return selected;
}

function resolveGestureDurationMs(context: ModelParameterCompileContext): number | null {
  const durationMs = context.semanticMotion.timing.timing.duration_ms;
  if (!Number.isFinite(durationMs) || !durationMs || durationMs <= 0) {
    return null;
  }
  return durationMs;
}

function buildVoiceFollowingDynamics(
  channel: VoiceFollowingChannelProfile,
  durationMs: number,
): NonNullable<SemanticParameterPlan["parameters"][number]["dynamics"]> {
  const weightedAmplitude = channel.amplitude * channel.weight;
  const transitionSeconds = Math.max(0.08, durationMs * 0.10 / 1000);
  return {
    max_velocity: Math.max(0.01, weightedAmplitude / transitionSeconds * 1.25),
    max_acceleration: Math.max(0.01, weightedAmplitude / (transitionSeconds * transitionSeconds) * 1.25),
    life_motion_scale: 0,
    max_speech_offset: Math.min(
      weightedAmplitude,
      Math.max(0, (channel.output_range.max - channel.output_range.min) / 2),
    ),
  };
}

function collectControlledParameterIds(context: ModelParameterCompileContext): Set<string> {
  const parameterIds = new Set<string>();
  for (const semanticAxis of context.semanticMotion.axes) {
    const axisId = semanticAxis.axisId;
    const axis = context.state.axisById.get(axisId);
    for (const binding of axis?.parameter_bindings ?? []) {
      parameterIds.add(binding.parameter_id);
    }
  }
  return parameterIds;
}

function isUsableVoiceFollowingChannel(channel: VoiceFollowingChannelProfile): boolean {
  return Boolean(
    channel
    && typeof channel.channel === "string"
    && channel.channel.trim()
    && typeof channel.parameter_id === "string"
    && channel.parameter_id.trim()
    && Number.isFinite(channel.neutral)
    && Number.isFinite(channel.amplitude)
    && channel.amplitude > 0
    && Number.isFinite(channel.weight)
    && channel.weight > 0
    && channel.output_range
    && Number.isFinite(channel.output_range.min)
    && Number.isFinite(channel.output_range.max)
    && Number.isInteger(channel.follow_delay_ms)
    && channel.follow_delay_ms >= 0
    && channel.follow_delay_ms <= 600
  );
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
