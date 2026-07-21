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
    { at: 0.10, transition: 0.14, value: 0.62 },
    { at: 0.46, transition: 0.16, value: -0.42 },
    { at: 0.72, transition: 0.12, value: 0.32 },
    { at: 0.86, transition: 0.12, value: 0 },
  ],
  lively_chat: [
    { at: 0, transition: 0, value: 0 },
    { at: 0.08, transition: 0.10, value: 0.90 },
    { at: 0.30, transition: 0.12, value: -0.72 },
    { at: 0.52, transition: 0.10, value: 0.78 },
    { at: 0.70, transition: 0.12, value: -0.48 },
    { at: 0.84, transition: 0.14, value: 0 },
  ],
  gentle_support: [
    { at: 0, transition: 0, value: 0 },
    { at: 0.14, transition: 0.18, value: 0.52 },
    { at: 0.50, transition: 0.18, value: -0.34 },
    { at: 0.80, transition: 0.16, value: 0 },
  ],
  emphatic: [
    { at: 0, transition: 0, value: 0 },
    { at: 0.10, transition: 0.08, value: -1.00 },
    { at: 0.30, transition: 0.12, value: 0.42 },
    { at: 0.56, transition: 0.10, value: -0.84 },
    { at: 0.78, transition: 0.16, value: 0 },
  ],
};

// Ordered capability mappings. Everyday speech favors visible lateral weight
// shifts and head tilt. Pitch remains available for capability-limited models,
// but is intentionally reserved as the primary gesture only for emphasis.
const PRESET_CHANNELS: Record<SpeechGesturePreset, string[]> = {
  calm_explain: ["head_roll", "head_yaw", "head_pitch", "body_roll", "body_yaw"],
  lively_chat: ["head_roll", "head_yaw", "head_pitch", "body_roll", "body_yaw"],
  gentle_support: ["head_roll", "head_yaw", "head_pitch", "body_roll", "body_yaw"],
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
  if (!voiceProfile || voiceProfile.schema_version !== "ag99.voice_following_profile.v3") {
    return { ok: true };
  }
  const invalidChannels = Object.values(voiceProfile.channels ?? {})
    .filter((channel) => !isUsableVoiceFollowingChannel(channel))
    .map((channel) => String(channel?.channel || "unknown_channel"));
  if (invalidChannels.length > 0) {
    return {
      ok: false,
      reason: `speech_gesture_channel_invalid:${[...new Set(invalidChannels)].join(",")}`,
    };
  }
  const invalidMappings = Object.values(voiceProfile.channels ?? {})
    .filter((channel) => {
      return !context.state.axisById.has(channel.semantic_axis_id);
    })
    .map((channel) => channel.semantic_axis_id);
  if (invalidMappings.length > 0) {
    return {
      ok: false,
      reason: `speech_gesture_semantic_binding_mismatch:${invalidMappings.join(",")}`,
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
  for (const channel of selectedChannels) {
    if (context.state.pendingSpeechGestures[channel.semantic_axis_id]) {
      return { ok: false, reason: `speech_gesture_axis_duplicate:${channel.semantic_axis_id}` };
    }
    context.state.pendingSpeechGestures[channel.semantic_axis_id] = buildGestureTrack(
      channel,
      preset,
      durationMs,
      context.options.samplingIdentity,
    );
  }
  context.state.warnings = [
    ...context.state.warnings,
    `speech_gesture_preset:${preset}`,
    ...selectedChannels.map((channel) => `speech_gesture_axis_pending:${channel.semantic_axis_id}`),
  ];
  return { ok: true };
}

function buildGestureTrack(
  channel: VoiceFollowingChannelProfile,
  preset: SpeechGesturePreset,
  durationMs: number,
  identity: { turnId: string; messageId: string } | undefined,
): ModelParameterCompileContext["state"]["pendingSpeechGestures"][string] {
  const activeDurationMs = durationMs - channel.follow_delay_ms;
  const gestureGroup = channel.channel.replace(/^(head|body)_/, "");
  const seed = stableHash(`${identity?.turnId ?? ""}:${identity?.messageId ?? ""}:${preset}:${gestureGroup}`);
  const polarity = preset === "emphatic" && gestureGroup === "pitch"
    ? 1
    : seed % 2 === 0 ? 1 : -1;
  return {
    preset,
    amplitudeRatio: channel.amplitude_ratio,
    delayMs: channel.follow_delay_ms,
    points: GESTURE_TEMPLATES[preset].map((point) => ({
      at_ms: Math.round(activeDurationMs * point.at),
      transition_ms: Math.round(activeDurationMs * point.transition),
      value: point.value === 0 ? 0 : point.value * polarity,
    })),
  };
}

function resolveSpeechGesturePreset(context: ModelParameterCompileContext): SpeechGesturePreset {
  const hint = context.semanticMotion.performanceCurveHint;
  if (hint?.energy === "high" || hint?.curve_family === "pulse_then_settle") {
    return "emphatic";
  }
  if (hint?.energy === "calm" || hint?.energy === "low" || hint?.curve_family === "soft_breathe") {
    return "gentle_support";
  }
  if (hint?.energy === "teasing") {
    return "lively_chat";
  }
  const tags = context.semanticMotion.intentTags.join(" ").toLowerCase();
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
  const includeBody = preset === "emphatic" || preset === "lively_chat"
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

function isUsableVoiceFollowingChannel(channel: VoiceFollowingChannelProfile): boolean {
  return Boolean(
    channel
    && typeof channel.channel === "string"
    && channel.channel.trim()
    && typeof channel.semantic_axis_id === "string"
    && channel.semantic_axis_id.trim()
    && Number.isFinite(channel.amplitude_ratio)
    && channel.amplitude_ratio > 0
    && channel.amplitude_ratio <= 1
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
