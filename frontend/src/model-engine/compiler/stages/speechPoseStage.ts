import type {
  SemanticParameterPlan,
  VoiceFollowingChannelProfile,
  VoiceFollowingProfile,
} from "../../../types/protocol.js";
import { SCHEMA_VOICE_FOLLOWING_PROFILE_V3 } from "../../../types/protocol.js";
import type {
  ModelParameterCompileContext,
  ModelParameterCompileStage,
  ModelParameterStageResult,
} from "../modelParameterCompileContext.js";
import {
  compileSpeechTrackTiming,
  resolveSpeechPhraseGroup,
} from "../performanceSchedule.js";
import {
  hashPerformanceIdentity,
  performanceUnitInterval,
} from "../performanceDeterminism.js";

type SpeechGesturePreset = NonNullable<
  SemanticParameterPlan["parameters"][number]["modulation"]
>["preset"];

type SpeechGestureChannel = VoiceFollowingChannelProfile & {
  layer: "head" | "body";
};

type SpeechGestureLateralFamily = "yaw" | "roll";

interface SpeechGestureSelection {
  channels: SpeechGestureChannel[];
  lateralFamily: SpeechGestureLateralFamily;
}

const PRESET_MAGNITUDE_RANGE: Record<
  SpeechGesturePreset,
  readonly [number, number]
> = {
  calm_explain: [0.48, 0.72],
  lively_chat: [0.70, 0.98],
  gentle_support: [0.38, 0.62],
  emphatic: [0.78, 1.00],
};

// Ordered capability mappings. Everyday speech favors visible lateral weight
// shifts and head tilt. Pitch remains available for capability-limited models,
// but is intentionally reserved as the primary gesture only for emphasis.
const PRESET_CHANNELS: Record<SpeechGesturePreset, string[]> = {
  calm_explain: ["head_roll", "head_yaw", "head_pitch", "body_roll", "body_yaw"],
  lively_chat: ["head_roll", "head_yaw", "head_pitch", "body_roll", "body_yaw"],
  gentle_support: ["head_roll", "head_yaw", "head_pitch", "body_roll", "body_yaw"],
  emphatic: ["head_pitch", "head_yaw", "head_roll", "body_yaw", "body_roll", "body_pitch"],
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
  if (!voiceProfile || voiceProfile.schema_version !== SCHEMA_VOICE_FOLLOWING_PROFILE_V3) {
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
    .filter((channel) => !context.state.axisById.has(channel.semantic_axis_id))
    .map((channel) => channel.semantic_axis_id);
  if (invalidMappings.length > 0) {
    return {
      ok: false,
      reason: `speech_gesture_semantic_binding_mismatch:${invalidMappings.join(",")}`,
    };
  }

  const preset = resolveSpeechGesturePreset(context);
  const durationMs = context.performanceSchedule.durationMs;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { ok: false, reason: "speech_gesture_timing_missing" };
  }
  const selection = selectGestureChannels(
    voiceProfile,
    preset,
    resolveSpeechGestureLateralFamily(context, preset),
    durationMs,
  );
  const selectedChannels = selection.channels;
  if (selectedChannels.length === 0) {
    return { ok: false, reason: `speech_gesture_channels_unavailable:${preset}` };
  }
  for (const channel of selectedChannels) {
    if (context.state.pendingSpeechGestures[channel.semantic_axis_id]) {
      return { ok: false, reason: `speech_gesture_axis_duplicate:${channel.semantic_axis_id}` };
    }
    const axis = context.state.axisById.get(channel.semantic_axis_id);
    if (!axis) {
      return {
        ok: false,
        reason: `speech_gesture_semantic_binding_mismatch:${channel.semantic_axis_id}`,
      };
    }
    const gestureTrack = buildGestureTrack(
      context.performanceSchedule,
      channel,
      preset,
      axis.semantic_group,
      context.options.samplingIdentity,
    );
    if (!gestureTrack.ok) {
      return { ok: false, reason: gestureTrack.reason };
    }
    context.state.pendingSpeechGestures[channel.semantic_axis_id] = gestureTrack.track;
  }
  context.state.warnings = [
    ...context.state.warnings,
    `speech_gesture_preset:${preset}`,
    `speech_gesture_lateral_family:${selection.lateralFamily}`,
    `speech_gesture_phrase_count:${context.performanceSchedule.phrases.length}`,
    `speech_gesture_text_source:${context.performanceSchedule.textSource}`,
    ...selectedChannels.map((channel) => `speech_gesture_axis_pending:${channel.semantic_axis_id}`),
  ];
  return { ok: true };
}

function buildGestureTrack(
  schedule: ModelParameterCompileContext["performanceSchedule"],
  channel: SpeechGestureChannel,
  preset: SpeechGesturePreset,
  semanticGroup: string,
  identity: { turnId: string; messageId: string } | undefined,
):
  | {
    ok: true;
    track: ModelParameterCompileContext["state"]["pendingSpeechGestures"][string];
  }
  | { ok: false; reason: string } {
  const timing = compileSpeechTrackTiming({
    schedule,
    semanticAxisId: channel.semantic_axis_id,
    semanticGroup,
    channelId: channel.channel,
    layer: channel.layer,
    followDelayMs: channel.follow_delay_ms,
    preset,
    identity,
  });
  if (!timing.ok) {
    return { ok: false, reason: timing.reason };
  }
  const points: ModelParameterCompileContext["state"]["pendingSpeechGestures"][string]["points"] = [];
  let previousDirection = 0;
  for (const event of timing.value.events) {
    if (event.kind === "speech_start" || event.kind === "speech_release") {
      points.push({
        at_ms: event.localAtMs ?? 0,
        transition_ms: event.transitionMs,
        value: 0,
        eventId: event.id,
      });
      continue;
    }
    const phrase = resolveSpeechPhraseGroup(schedule, event);
    if (!phrase) {
      return { ok: false, reason: `speech_gesture_phrase_event_invalid:${event.id}` };
    }
    const phraseIndex = timing.value.phraseEvents.indexOf(event);
    const phraseSeed = hashPerformanceIdentity([
      identity?.turnId ?? "",
      identity?.messageId ?? "",
      preset,
      phraseIndex,
      phrase.text,
    ].join(":"));
    const resolvedValue = resolveGestureValue(
      channel,
      preset,
      phrase,
      phraseSeed,
      previousDirection,
    );
    points.push({
      at_ms: event.localAtMs ?? 0,
      transition_ms: event.transitionMs,
      value: resolvedValue.value,
      eventId: event.id,
    });
    previousDirection = resolvedValue.direction;
  }
  return {
    ok: true,
    track: {
      preset,
      amplitudeRatio: channel.amplitude_ratio,
      delayMs: channel.follow_delay_ms,
      points,
    },
  };
}

function resolveGestureValue(
  channel: SpeechGestureChannel,
  preset: SpeechGesturePreset,
  phrase: { emphasis: number },
  phraseSeed: number,
  previousDirection: number,
): { value: number; direction: number } {
  const [minimumMagnitude, maximumMagnitude] = PRESET_MAGNITUDE_RANGE[preset];
  const magnitudeSeed = hashPerformanceIdentity(
    `${phraseSeed}:${channel.channel}:magnitude`,
  );
  const directionSeed = hashPerformanceIdentity(`${phraseSeed}:direction`);
  const pitchScale = channel.channel.includes("pitch") && preset !== "emphatic"
    ? 0.78
    : 1;
  const magnitude = (
    minimumMagnitude
    + (maximumMagnitude - minimumMagnitude) * performanceUnitInterval(magnitudeSeed)
  ) * phrase.emphasis * pitchScale;
  let direction = directionSeed % 2 === 0 ? 1 : -1;
  if (previousDirection !== 0 && directionSeed % 5 !== 0) {
    direction = -previousDirection;
  }
  if (preset === "emphatic" && channel.channel.includes("pitch") && previousDirection === 0) {
    direction = -1;
  }
  return {
    direction,
    value: clampNumber(magnitude * direction, -1, 1),
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
  const semanticLabels = [
    context.semanticMotion.emotionLabel,
    ...context.semanticMotion.intentTags,
  ].join(" ").toLowerCase();
  if (/(?:\b(?:surprised?|angry|excited?)\b|惊讶|生气|强调|激动)/.test(semanticLabels)) {
    return "emphatic";
  }
  if (/(?:\b(?:comfort|soothing?|gentle|sad|tired)\b|安抚|温柔|理解|低落|悲伤|疲惫)/.test(semanticLabels)) {
    return "gentle_support";
  }
  if (/(?:\b(?:happy|joyful?|playful|teasing)\b|开心|高兴|愉快|调皮|可爱)/.test(semanticLabels)) {
    return "lively_chat";
  }
  if (/(?:\b(?:explain|thinking?|serious)\b|说明|解释|思考|认真)/.test(semanticLabels)) {
    return "calm_explain";
  }
  const identity = context.options.samplingIdentity;
  return hashPerformanceIdentity(`${identity?.turnId ?? ""}:${identity?.messageId ?? ""}`) % 2 === 0
    ? "calm_explain"
    : "lively_chat";
}

function resolveSpeechGestureLateralFamily(
  context: ModelParameterCompileContext,
  preset: SpeechGesturePreset,
): SpeechGestureLateralFamily {
  const familyStrength: Record<SpeechGestureLateralFamily, number> = {
    yaw: 0,
    roll: 0,
  };
  for (const semanticAxis of context.semanticMotion.axes) {
    const family = resolveAxisLateralFamily(semanticAxis.axisId);
    const axis = context.state.axisById.get(semanticAxis.axisId);
    if (!family || !axis) {
      continue;
    }
    const availableSpan = Math.max(
      Math.abs(axis.neutral - axis.value_range[0]),
      Math.abs(axis.value_range[1] - axis.neutral),
    );
    if (availableSpan <= 0) {
      continue;
    }
    familyStrength[family] = Math.max(
      familyStrength[family],
      Math.abs(semanticAxis.value - semanticAxis.neutralValue) / availableSpan,
    );
  }
  if (Math.abs(familyStrength.yaw - familyStrength.roll) > 0.000001) {
    return familyStrength.yaw > familyStrength.roll ? "yaw" : "roll";
  }
  return preset === "calm_explain" || preset === "emphatic" ? "yaw" : "roll";
}

function resolveAxisLateralFamily(axisId: string): SpeechGestureLateralFamily | null {
  if (axisId === "head_yaw" || axisId === "body_yaw" || axisId === "gaze_x") {
    return "yaw";
  }
  if (axisId === "head_roll" || axisId === "body_roll") {
    return "roll";
  }
  return null;
}

function selectGestureChannels(
  profile: VoiceFollowingProfile,
  preset: SpeechGesturePreset,
  lateralFamily: SpeechGestureLateralFamily,
  durationMs: number,
): SpeechGestureSelection {
  const channels = profile.channels ?? {};
  const selected: SpeechGestureChannel[] = [];
  const available = PRESET_CHANNELS[preset]
    .map((channelName) => channels[channelName])
    .filter((channel): channel is SpeechGestureChannel => (
      isUsableVoiceFollowingChannel(channel)
      && channel.follow_delay_ms <= durationMs - 220
    ));
  const headChannels = available.filter((channel) => channel.layer === "head");
  const bodyChannels = available.filter((channel) => channel.layer === "body");
  const lateralHeadChannels = headChannels.filter((channel) => (
    channel.channel.includes("yaw") || channel.channel.includes("roll")
  ));
  const lateralBodyChannels = bodyChannels.filter((channel) => (
    channel.channel.includes("yaw") || channel.channel.includes("roll")
  ));
  const requestedHeadFamilyAvailable = lateralHeadChannels
    .some((channel) => channel.channel.includes(lateralFamily));
  const effectiveLateralFamily = requestedHeadFamilyAvailable
    ? lateralFamily
    : resolveChannelLateralFamily(lateralHeadChannels[0] ?? lateralBodyChannels[0])
      ?? lateralFamily;
  const primaryHeadChannel = lateralHeadChannels.find(
    (channel) => channel.channel.includes(effectiveLateralFamily),
  );
  const secondaryHeadChannel = lateralHeadChannels.find(
    (channel) => !channel.channel.includes(effectiveLateralFamily),
  );
  const emphaticPitchChannel = preset === "emphatic"
    ? headChannels.find((channel) => channel.channel.includes("pitch"))
    : undefined;
  if (emphaticPitchChannel) {
    selected.push(emphaticPitchChannel);
  }
  if (primaryHeadChannel) {
    selected.push(primaryHeadChannel);
  }
  if (preset === "lively_chat" && selected.length < 2 && secondaryHeadChannel) {
    selected.push(secondaryHeadChannel);
  }
  if (selected.length === 0) {
    const fallbackHeadChannel = secondaryHeadChannel ?? headChannels[0];
    if (fallbackHeadChannel) {
      selected.push(fallbackHeadChannel);
    }
  }

  const lateralBodyChannel = bodyChannels.find(
    (channel) => channel.channel.includes(effectiveLateralFamily),
  );
  if (lateralBodyChannel) {
    selected.push(lateralBodyChannel);
  } else if (lateralHeadChannels.length === 0 && bodyChannels.length > 0) {
    selected.push(bodyChannels[0]);
  }

  return { channels: selected, lateralFamily: effectiveLateralFamily };
}

function resolveChannelLateralFamily(
  channel: SpeechGestureChannel | undefined,
): SpeechGestureLateralFamily | null {
  if (channel?.channel.includes("yaw")) {
    return "yaw";
  }
  if (channel?.channel.includes("roll")) {
    return "roll";
  }
  return null;
}

function isUsableVoiceFollowingChannel(
  channel: VoiceFollowingChannelProfile,
): channel is SpeechGestureChannel {
  return Boolean(
    channel
    && typeof channel.channel === "string"
    && channel.channel.trim()
    && typeof channel.semantic_axis_id === "string"
    && channel.semantic_axis_id.trim()
    && (channel.layer === "head" || channel.layer === "body")
    && Number.isFinite(channel.amplitude_ratio)
    && channel.amplitude_ratio > 0
    && channel.amplitude_ratio <= 1
    && Number.isInteger(channel.follow_delay_ms)
    && channel.follow_delay_ms >= 0
    && channel.follow_delay_ms <= 600
  );
}

function clampNumber(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}
