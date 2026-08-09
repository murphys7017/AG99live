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

type SpeechGesturePreset = NonNullable<
  SemanticParameterPlan["parameters"][number]["modulation"]
>["preset"];

type SpeechPhraseBoundary = "strong" | "soft" | "none";

interface SpeechPhrase {
  text: string;
  boundary: SpeechPhraseBoundary;
  weight: number;
  emphasis: number;
}

const MAX_TRACK_POINT_COUNT = 8;
const MAX_GESTURE_PHRASE_COUNT = MAX_TRACK_POINT_COUNT - 2;
const MAX_EFFECTIVE_PHRASE_LENGTH = 18;

const PRESET_MAGNITUDE_RANGE: Record<
  SpeechGesturePreset,
  readonly [number, number]
> = {
  calm_explain: [0.38, 0.64],
  lively_chat: [0.64, 0.94],
  gentle_support: [0.30, 0.54],
  emphatic: [0.72, 1.00],
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
  const durationMs = resolveGestureDurationMs(context);
  if (durationMs === null) {
    return { ok: false, reason: "speech_gesture_timing_missing" };
  }
  const speechPhrases = segmentAssistantText(context.options.assistantText ?? "");
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
      speechPhrases,
      context.options.samplingIdentity,
    );
  }
  context.state.warnings = [
    ...context.state.warnings,
    `speech_gesture_preset:${preset}`,
    `speech_gesture_phrase_count:${speechPhrases.length}`,
    `speech_gesture_text_source:${context.options.assistantText?.trim() ? "assistant_text" : "duration_only"}`,
    ...selectedChannels.map((channel) => `speech_gesture_axis_pending:${channel.semantic_axis_id}`),
  ];
  return { ok: true };
}

function buildGestureTrack(
  channel: VoiceFollowingChannelProfile,
  preset: SpeechGesturePreset,
  durationMs: number,
  sourcePhrases: SpeechPhrase[],
  identity: { turnId: string; messageId: string } | undefined,
): ModelParameterCompileContext["state"]["pendingSpeechGestures"][string] {
  const activeDurationMs = durationMs - channel.follow_delay_ms;
  const bodyLayer = channel.layer === "body";
  const settleDurationMs = clampInteger(
    Math.round(activeDurationMs * (bodyLayer ? 0.20 : 0.16)),
    80,
    180,
  );
  const settleAtMs = activeDurationMs - settleDurationMs;
  const introMs = clampInteger(
    Math.round(activeDurationMs * (bodyLayer ? 0.11 : 0.07)),
    18,
    bodyLayer ? 100 : 70,
  );
  const phraseLimit = resolveGesturePhraseLimit(
    settleAtMs - introMs,
    bodyLayer,
  );
  const phrases = coalesceSpeechPhrases(sourcePhrases, phraseLimit);
  const gesturePoints = buildPhraseGesturePoints({
    channel,
    preset,
    activeDurationMs,
    introMs,
    settleAtMs,
    phrases,
    identity,
  });

  return {
    preset,
    amplitudeRatio: channel.amplitude_ratio,
    delayMs: channel.follow_delay_ms,
    points: [
      { at_ms: 0, transition_ms: 0, value: 0 },
      ...gesturePoints,
      {
        at_ms: settleAtMs,
        transition_ms: settleDurationMs,
        value: 0,
      },
    ],
  };
}

function buildPhraseGesturePoints(options: {
  channel: VoiceFollowingChannelProfile;
  preset: SpeechGesturePreset;
  activeDurationMs: number;
  introMs: number;
  settleAtMs: number;
  phrases: SpeechPhrase[];
  identity: { turnId: string; messageId: string } | undefined;
}): Array<{ at_ms: number; transition_ms: number; value: number }> {
  const {
    channel,
    preset,
    activeDurationMs,
    introMs,
    settleAtMs,
    phrases,
    identity,
  } = options;
  const bodyLayer = channel.layer === "body";
  const availableMs = Math.max(1, settleAtMs - introMs);
  const totalWeight = phrases.reduce((sum, phrase) => sum + phrase.weight, 0);
  const points: Array<{ at_ms: number; transition_ms: number; value: number }> = [];
  let elapsedWeight = 0;
  let previousAtMs = 0;
  let previousDirection = 0;

  for (let index = 0; index < phrases.length; index += 1) {
    const phrase = phrases[index];
    const windowStartMs = introMs + Math.round((elapsedWeight / totalWeight) * availableMs);
    elapsedWeight += phrase.weight;
    const windowEndMs = introMs + Math.round((elapsedWeight / totalWeight) * availableMs);
    const seed = stableHash([
      identity?.turnId ?? "",
      identity?.messageId ?? "",
      channel.channel,
      preset,
      index,
      phrase.text,
    ].join(":"));
    const onsetRatio = bodyLayer
      ? 0.12 + unitInterval(seed) * 0.14
      : 0.05 + unitInterval(seed) * 0.12;
    const candidateAtMs = windowStartMs
      + Math.round(Math.max(1, windowEndMs - windowStartMs) * onsetRatio);
    const latestAtMs = Math.max(
      previousAtMs + 1,
      Math.min(settleAtMs - 1, windowEndMs - 1),
    );
    const atMs = clampInteger(
      candidateAtMs,
      previousAtMs + 1,
      latestAtMs,
    );
    const resolvedValue = resolveGestureValue(
      channel,
      preset,
      phrase,
      seed,
      previousDirection,
    );
    points.push({
      at_ms: atMs,
      transition_ms: 0,
      value: resolvedValue.value,
    });
    previousAtMs = atMs;
    previousDirection = resolvedValue.direction;
  }

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const nextAtMs = points[index + 1]?.at_ms ?? settleAtMs;
    const transitionBudgetMs = Math.max(0, nextAtMs - point.at_ms);
    const transitionSeed = stableHash([
      identity?.turnId ?? "",
      identity?.messageId ?? "",
      channel.channel,
      "transition",
      index,
      activeDurationMs,
    ].join(":"));
    const transitionRatio = bodyLayer
      ? 0.56 + unitInterval(transitionSeed) * 0.18
      : 0.34 + unitInterval(transitionSeed) * 0.22;
    point.transition_ms = Math.min(
      transitionBudgetMs,
      Math.max(1, Math.round(transitionBudgetMs * transitionRatio)),
    );
  }
  return points;
}

function resolveGestureValue(
  channel: VoiceFollowingChannelProfile,
  preset: SpeechGesturePreset,
  phrase: SpeechPhrase,
  seed: number,
  previousDirection: number,
): { value: number; direction: number } {
  const [minimumMagnitude, maximumMagnitude] = PRESET_MAGNITUDE_RANGE[preset];
  const magnitudeSeed = stableHash(`${seed}:magnitude`);
  const directionSeed = stableHash(`${seed}:direction`);
  const magnitude = (
    minimumMagnitude
    + (maximumMagnitude - minimumMagnitude) * unitInterval(magnitudeSeed)
  ) * phrase.emphasis;
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

function segmentAssistantText(assistantText: string): SpeechPhrase[] {
  const text = typeof assistantText === "string" ? assistantText.trim() : "";
  if (!text) {
    return [createSpeechPhrase("", "none")];
  }

  const rawPhrases: SpeechPhrase[] = [];
  let buffer = "";
  for (const character of Array.from(text)) {
    buffer += character;
    const boundary = resolvePhraseBoundary(character);
    if (boundary === "none") {
      continue;
    }
    appendSplitPhrase(rawPhrases, buffer, boundary);
    buffer = "";
  }
  appendSplitPhrase(rawPhrases, buffer, "none");
  return rawPhrases.length > 0
    ? rawPhrases
    : [createSpeechPhrase("", "none")];
}

function appendSplitPhrase(
  target: SpeechPhrase[],
  text: string,
  boundary: SpeechPhraseBoundary,
): void {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return;
  }
  const characters = Array.from(normalizedText);
  if (!characters.some(isEffectiveSpeechCharacter)) {
    appendSpeechPhrase(target, normalizedText, boundary);
    return;
  }
  let chunk = "";
  let effectiveLength = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    chunk += character;
    if (isEffectiveSpeechCharacter(character)) {
      effectiveLength += 1;
    }
    const hasMore = index < characters.length - 1;
    if (effectiveLength < MAX_EFFECTIVE_PHRASE_LENGTH || !hasMore) {
      continue;
    }
    appendSpeechPhrase(target, chunk, "none");
    chunk = "";
    effectiveLength = 0;
  }
  appendSpeechPhrase(target, chunk, boundary);
}

function appendSpeechPhrase(
  target: SpeechPhrase[],
  text: string,
  boundary: SpeechPhraseBoundary,
): void {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return;
  }
  if (!Array.from(normalizedText).some(isEffectiveSpeechCharacter)) {
    const previous = target[target.length - 1];
    if (!previous) {
      return;
    }
    const merged = createSpeechPhrase(previous.text + normalizedText, boundary);
    previous.text = merged.text;
    previous.boundary = merged.boundary;
    previous.weight = merged.weight;
    previous.emphasis = merged.emphasis;
    return;
  }
  target.push(createSpeechPhrase(normalizedText, boundary));
}

function createSpeechPhrase(
  text: string,
  boundary: SpeechPhraseBoundary,
): SpeechPhrase {
  const effectiveLength = Math.max(
    1,
    Array.from(text).filter(isEffectiveSpeechCharacter).length,
  );
  const pauseWeight = boundary === "strong" ? 4 : boundary === "soft" ? 2 : 0;
  let emphasis = boundary === "strong" ? 1.05 : 1;
  if (/[！!]/u.test(text)) {
    emphasis = 1.14;
  } else if (/[？?]/u.test(text)) {
    emphasis = 1.08;
  }
  return {
    text,
    boundary,
    weight: effectiveLength + pauseWeight,
    emphasis,
  };
}

function coalesceSpeechPhrases(
  phrases: SpeechPhrase[],
  maximumCount: number,
): SpeechPhrase[] {
  if (phrases.length <= maximumCount) {
    return phrases;
  }
  const result: SpeechPhrase[] = [];
  for (let index = 0; index < maximumCount; index += 1) {
    const start = Math.floor((index * phrases.length) / maximumCount);
    const end = Math.floor(((index + 1) * phrases.length) / maximumCount);
    const group = phrases.slice(start, Math.max(start + 1, end));
    const finalPhrase = group[group.length - 1];
    result.push({
      text: group.map((phrase) => phrase.text).join(""),
      boundary: finalPhrase.boundary,
      weight: group.reduce((sum, phrase) => sum + phrase.weight, 0),
      emphasis: Math.max(...group.map((phrase) => phrase.emphasis)),
    });
  }
  return result;
}

function resolveGesturePhraseLimit(
  availableMs: number,
  bodyLayer: boolean,
): number {
  const preferredWindowMs = bodyLayer ? 260 : 180;
  return clampInteger(
    Math.ceil(Math.max(1, availableMs) / preferredWindowMs),
    1,
    MAX_GESTURE_PHRASE_COUNT,
  );
}

function resolvePhraseBoundary(character: string): SpeechPhraseBoundary {
  if (/[。！？!?；;\n]/u.test(character)) {
    return "strong";
  }
  if (/[，、,:：]/u.test(character)) {
    return "soft";
  }
  return "none";
}

function isEffectiveSpeechCharacter(character: string): boolean {
  return !/\s/u.test(character) && resolvePhraseBoundary(character) === "none";
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

function unitInterval(seed: number): number {
  return (seed >>> 0) / 0xffffffff;
}

function clampInteger(value: number, minValue: number, maxValue: number): number {
  return Math.round(clampNumber(value, minValue, maxValue));
}

function clampNumber(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
