import {
  PERFORMANCE_SCHEDULE_TRACE_VERSION,
  type PerformanceParameterNodeTrace,
  type PerformanceScheduleTrace,
  type PerformanceTimingEventTrace,
} from "../../types/compiledSemanticMotion.js";

export type PerformancePhraseBoundary = "strong" | "soft" | "none";

export interface PerformancePhraseSlot {
  readonly index: number;
  readonly text: string;
  readonly boundary: PerformancePhraseBoundary;
  readonly weight: number;
  readonly emphasis: number;
  readonly startRatio: number;
  readonly endRatio: number;
}

export interface PerformanceSchedule {
  readonly durationMs: number;
  readonly textSource: "assistant_text" | "duration_only";
  readonly phrases: readonly PerformancePhraseSlot[];
  readonly semanticSteps: readonly PerformanceSemanticStepSlot[];
  readonly estimatedAlignments: readonly PerformancePhraseStepAlignment[];
  readonly events: readonly PerformanceTimingEventTrace[];
  readonly parameterNodes: readonly PerformanceParameterNodeTrace[];
}

export interface PerformanceSemanticStepSlot {
  readonly index: number;
  readonly durationWeight: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly startRatio: number;
  readonly endRatio: number;
}

export interface PerformancePhraseStepAlignment {
  readonly kind: "estimated_time_overlap";
  readonly phraseIndex: number;
  readonly stepIndex: number;
  readonly overlapRatio: number;
  readonly phraseCoverageRatio: number;
  readonly stepCoverageRatio: number;
  readonly primaryForPhrase: boolean;
}

export type PerformanceScheduleCompileResult =
  | { ok: true; schedule: PerformanceSchedule; reason: "" }
  | { ok: false; schedule: null; reason: string };

interface PerformancePhraseDraft {
  text: string;
  boundary: PerformancePhraseBoundary;
  weight: number;
  emphasis: number;
}

interface PerformanceTrackTimingPolicy {
  transitionOffsetMs: number;
  transitionMs: number;
  preferredHoldMs: number;
  residualMs: number;
}

export interface PerformanceSemanticTrackTiming {
  readonly events: readonly PerformanceTimingEventTrace[];
  readonly requiredOwnedUntilMs: number;
  readonly staggered: boolean;
  readonly residual: boolean;
  readonly compressed: boolean;
}

export interface PerformanceSpeechPhraseGroup {
  readonly phraseIndices: readonly number[];
  readonly text: string;
  readonly emphasis: number;
  readonly startRatio: number;
  readonly endRatio: number;
}

export interface PerformanceSpeechTrackTiming {
  readonly events: readonly PerformanceTimingEventTrace[];
  readonly phraseEvents: readonly PerformanceTimingEventTrace[];
}

export type PerformanceScheduleMutationResult<T> =
  | { ok: true; value: T; reason: "" }
  | { ok: false; value: null; reason: string };

const MAX_EFFECTIVE_PHRASE_LENGTH = 18;

export function compilePerformanceSchedule(options: {
  assistantText?: string;
  durationMs: number;
  sequenceDurationWeights?: readonly number[];
}): PerformanceScheduleCompileResult {
  if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) {
    return {
      ok: false,
      schedule: null,
      reason: "performance_schedule_duration_invalid",
    };
  }
  const text = typeof options.assistantText === "string"
    ? options.assistantText.trim()
    : "";
  const drafts = segmentAssistantText(text);
  const totalWeight = drafts.reduce((sum, phrase) => sum + phrase.weight, 0);
  let elapsedWeight = 0;
  const phrases = drafts.map((phrase, index): PerformancePhraseSlot => {
    const startRatio = elapsedWeight / totalWeight;
    elapsedWeight += phrase.weight;
    return {
      index,
      ...phrase,
      startRatio,
      endRatio: elapsedWeight / totalWeight,
    };
  });
  const semanticStepsResult = compileSemanticStepSlots(
    options.sequenceDurationWeights,
    options.durationMs,
  );
  if (!semanticStepsResult.ok) {
    return semanticStepsResult;
  }
  const textSource = text ? "assistant_text" : "duration_only";
  const semanticSteps = semanticStepsResult.semanticSteps;
  return {
    ok: true,
    reason: "",
    schedule: {
      durationMs: options.durationMs,
      textSource,
      phrases,
      semanticSteps,
      estimatedAlignments: textSource === "assistant_text"
        ? estimatePhraseStepAlignments(phrases, semanticSteps, options.durationMs)
        : [],
      events: [],
      parameterNodes: [],
    },
  };
}

export function buildPerformanceScheduleTrace(
  schedule: PerformanceSchedule,
): PerformanceScheduleTrace {
  return {
    version: PERFORMANCE_SCHEDULE_TRACE_VERSION,
    durationMs: schedule.durationMs,
    textSource: schedule.textSource,
    phrases: schedule.phrases.map((phrase) => ({ ...phrase })),
    semanticSteps: schedule.semanticSteps.map((step) => ({ ...step })),
    estimatedAlignments: schedule.estimatedAlignments.map((alignment) => ({
      ...alignment,
    })),
    events: schedule.events.map((event) => ({
      ...event,
      phraseIndices: event.phraseIndices ? [...event.phraseIndices] : undefined,
    })),
    parameterNodes: schedule.parameterNodes.map((node) => ({ ...node })),
  };
}

export function compileSemanticTrackTiming(options: {
  schedule: PerformanceSchedule;
  semanticAxisId: string;
  semanticGroup: string;
  changedStepIndices: readonly number[];
}): PerformanceScheduleMutationResult<PerformanceSemanticTrackTiming> {
  const { schedule, semanticAxisId, semanticGroup, changedStepIndices } = options;
  if (
    !semanticAxisId
    || changedStepIndices.length < 2
    || changedStepIndices[0] !== 0
    || changedStepIndices.some((stepIndex, index) => (
      !Number.isInteger(stepIndex)
      || stepIndex < 0
      || stepIndex >= schedule.semanticSteps.length
      || (index > 0 && stepIndex <= changedStepIndices[index - 1])
    ))
  ) {
    return {
      ok: false,
      value: null,
      reason: `performance_schedule_semantic_track_invalid:${semanticAxisId || "unknown_axis"}`,
    };
  }

  const policy = resolveTrackTimingPolicy(semanticGroup);
  const transitionStarts: number[] = [];
  let previousAtMs = 0;
  for (let position = 1; position < changedStepIndices.length; position += 1) {
    const step = schedule.semanticSteps[changedStepIndices[position]];
    const desiredAtMs = Math.max(
      1,
      Math.round(step.startMs + policy.transitionOffsetMs),
    );
    const atMs = Math.max(desiredAtMs, previousAtMs + 1);
    transitionStarts.push(atMs);
    previousAtMs = atMs;
  }

  const events: PerformanceTimingEventTrace[] = [];
  let compressed = false;
  let finalTransitionEndMs = 0;
  const initialNextAtMs = transitionStarts[0] ?? schedule.durationMs;
  events.push({
    id: buildSemanticEventId(semanticAxisId, 0),
    kind: "semantic_transition",
    source: "semantic_step",
    timingSource: "semantic_group_policy",
    semanticAxisId,
    semanticGroup,
    atMs: 0,
    transitionMs: 0,
    holdMs: Math.max(0, initialNextAtMs),
    residualMs: 0,
    transitionOffsetMs: 0,
    compressed: false,
    stepIndex: 0,
  });

  for (let position = 0; position < transitionStarts.length; position += 1) {
    const stepIndex = changedStepIndices[position + 1];
    const atMs = transitionStarts[position];
    const nextAtMs = transitionStarts[position + 1];
    const availableWindowMs = nextAtMs === undefined
      ? Math.max(0, schedule.durationMs - atMs)
      : nextAtMs - atMs;
    const transition = nextAtMs === undefined && availableWindowMs === 0
      ? { transitionMs: policy.transitionMs, compressed: false }
      : resolveTransitionWindow(availableWindowMs, policy);
    compressed ||= transition.compressed;
    const transitionEndMs = atMs + transition.transitionMs;
    const residualMs = position === transitionStarts.length - 1
      ? policy.residualMs
      : 0;
    events.push({
      id: buildSemanticEventId(semanticAxisId, stepIndex),
      kind: "semantic_transition",
      source: "semantic_step",
      timingSource: "semantic_group_policy",
      semanticAxisId,
      semanticGroup,
      atMs,
      transitionMs: transition.transitionMs,
      holdMs: Math.max(
        0,
        (nextAtMs ?? schedule.durationMs) - transitionEndMs,
      ),
      residualMs,
      transitionOffsetMs: policy.transitionOffsetMs,
      compressed: transition.compressed,
      compressionReason: transition.compressed
        ? "transition_window_short"
        : undefined,
      stepIndex,
    });
    finalTransitionEndMs = transitionEndMs;
  }

  const registerResult = registerPerformanceTimingEvents(schedule, events);
  if (!registerResult.ok) {
    return registerResult;
  }
  return {
    ok: true,
    reason: "",
    value: {
      events,
      requiredOwnedUntilMs: finalTransitionEndMs + policy.residualMs,
      staggered: policy.transitionOffsetMs !== 0,
      residual: policy.residualMs > 0,
      compressed,
    },
  };
}

export function compileSpeechTrackTiming(options: {
  schedule: PerformanceSchedule;
  semanticAxisId: string;
  semanticGroup: string;
  channelId: string;
  layer: "head" | "body";
  followDelayMs: number;
  preset: string;
  identity?: { turnId: string; messageId: string };
}): PerformanceScheduleMutationResult<PerformanceSpeechTrackTiming> {
  const {
    schedule,
    semanticAxisId,
    semanticGroup,
    channelId,
    layer,
    followDelayMs,
    preset,
    identity,
  } = options;
  const activeDurationMs = schedule.durationMs - followDelayMs;
  if (
    !semanticAxisId
    || !channelId
    || !Number.isInteger(followDelayMs)
    || followDelayMs < 0
    || activeDurationMs <= 0
  ) {
    return {
      ok: false,
      value: null,
      reason: `performance_schedule_speech_track_invalid:${channelId || "unknown_channel"}`,
    };
  }

  const bodyLayer = layer === "body";
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
  const phraseGroups = coalesceSpeechPhrases(schedule.phrases, phraseLimit);
  const phraseEvents: PerformanceTimingEventTrace[] = [];
  let previousAtMs = 0;

  for (let index = 0; index < phraseGroups.length; index += 1) {
    const phrase = phraseGroups[index];
    const availableMs = Math.max(1, settleAtMs - introMs);
    const windowStartMs = introMs + Math.round(phrase.startRatio * availableMs);
    const windowEndMs = introMs + Math.round(phrase.endRatio * availableMs);
    const seed = hashPerformanceIdentity([
      identity?.turnId ?? "",
      identity?.messageId ?? "",
      channelId,
      preset,
      index,
      phrase.text,
    ].join(":"));
    const onsetRatio = bodyLayer
      ? 0.12 + performanceUnitInterval(seed) * 0.14
      : 0.05 + performanceUnitInterval(seed) * 0.12;
    const candidateAtMs = windowStartMs
      + Math.round(Math.max(1, windowEndMs - windowStartMs) * onsetRatio);
    const latestAtMs = Math.max(
      previousAtMs + 1,
      Math.min(settleAtMs - 1, windowEndMs - 1),
    );
    const localAtMs = clampInteger(
      candidateAtMs,
      previousAtMs + 1,
      latestAtMs,
    );
    phraseEvents.push({
      id: buildSpeechEventId(channelId, "phrase", index),
      kind: "speech_phrase",
      source: "speech_phrase",
      timingSource: "voice_following_profile",
      semanticAxisId,
      semanticGroup,
      atMs: followDelayMs + localAtMs,
      localAtMs,
      windowStartMs: followDelayMs + windowStartMs,
      windowEndMs: followDelayMs + windowEndMs,
      transitionMs: 0,
      holdMs: 0,
      residualMs: 0,
      transitionOffsetMs: localAtMs - windowStartMs,
      compressed: false,
      phraseIndices: [...phrase.phraseIndices],
      channelId,
      gesturePreset: preset,
    });
    previousAtMs = localAtMs;
  }

  for (let index = 0; index < phraseEvents.length; index += 1) {
    const event = phraseEvents[index];
    const localAtMs = event.localAtMs ?? 0;
    const nextAtMs = phraseEvents[index + 1]?.localAtMs ?? settleAtMs;
    const transitionBudgetMs = Math.max(0, nextAtMs - localAtMs);
    const transitionSeed = hashPerformanceIdentity([
      identity?.turnId ?? "",
      identity?.messageId ?? "",
      channelId,
      "transition",
      index,
      activeDurationMs,
    ].join(":"));
    const transitionRatio = bodyLayer
      ? 0.56 + performanceUnitInterval(transitionSeed) * 0.18
      : 0.34 + performanceUnitInterval(transitionSeed) * 0.22;
    event.transitionMs = Math.min(
      transitionBudgetMs,
      Math.max(1, Math.round(transitionBudgetMs * transitionRatio)),
    );
    event.holdMs = Math.max(
      0,
      nextAtMs - (localAtMs + event.transitionMs),
    );
  }

  const startEvent: PerformanceTimingEventTrace = {
    id: buildSpeechEventId(channelId, "start", 0),
    kind: "speech_start",
    source: "speech_track",
    timingSource: "voice_following_profile",
    semanticAxisId,
    semanticGroup,
    atMs: followDelayMs,
    localAtMs: 0,
    transitionMs: 0,
    holdMs: phraseEvents[0]?.localAtMs ?? settleAtMs,
    residualMs: 0,
    transitionOffsetMs: 0,
    compressed: false,
    channelId,
    gesturePreset: preset,
  };
  const releaseEvent: PerformanceTimingEventTrace = {
    id: buildSpeechEventId(channelId, "release", 0),
    kind: "speech_release",
    source: "speech_release",
    timingSource: "voice_following_profile",
    semanticAxisId,
    semanticGroup,
    atMs: followDelayMs + settleAtMs,
    localAtMs: settleAtMs,
    transitionMs: settleDurationMs,
    holdMs: 0,
    residualMs: 0,
    transitionOffsetMs: 0,
    compressed: false,
    channelId,
    gesturePreset: preset,
  };
  const events = [startEvent, ...phraseEvents, releaseEvent];
  const registerResult = registerPerformanceTimingEvents(schedule, events);
  if (!registerResult.ok) {
    return registerResult;
  }
  return {
    ok: true,
    reason: "",
    value: { events, phraseEvents },
  };
}

export function resolveSpeechPhraseGroup(
  schedule: PerformanceSchedule,
  event: PerformanceTimingEventTrace,
): PerformanceSpeechPhraseGroup | null {
  if (event.kind !== "speech_phrase" || !event.phraseIndices?.length) {
    return null;
  }
  const phrases = event.phraseIndices.map((index) => schedule.phrases[index]);
  if (phrases.some((phrase) => !phrase)) {
    return null;
  }
  return buildSpeechPhraseGroup(phrases);
}

export function registerPerformanceParameterNodes(
  schedule: PerformanceSchedule,
  nodes: readonly PerformanceParameterNodeTrace[],
): PerformanceScheduleMutationResult<readonly PerformanceParameterNodeTrace[]> {
  const eventIds = new Set(schedule.events.map((event) => event.id));
  const existingNodeKeys = new Set(schedule.parameterNodes.map(buildParameterNodeKey));
  const incomingNodeKeys = new Set<string>();
  for (const node of nodes) {
    const nodeKey = buildParameterNodeKey(node);
    if (
      !node.parameterId
      || !node.axisId
      || !eventIds.has(node.eventId)
      || !Number.isInteger(node.nodeIndex)
      || node.nodeIndex < 0
      || !Number.isFinite(node.atMs)
      || node.atMs < 0
      || !Number.isFinite(node.transitionMs)
      || node.transitionMs < 0
      || existingNodeKeys.has(nodeKey)
      || incomingNodeKeys.has(nodeKey)
    ) {
      return {
        ok: false,
        value: null,
        reason: `performance_schedule_parameter_node_invalid:${node.parameterId || "unknown_parameter"}:${node.nodeIndex}`,
      };
    }
    incomingNodeKeys.add(nodeKey);
  }
  mutableParameterNodes(schedule).push(...nodes.map((node) => ({ ...node })));
  return { ok: true, value: nodes, reason: "" };
}

export function hashPerformanceIdentity(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function performanceUnitInterval(seed: number): number {
  return (seed >>> 0) / 0xffffffff;
}

function registerPerformanceTimingEvents(
  schedule: PerformanceSchedule,
  events: readonly PerformanceTimingEventTrace[],
): PerformanceScheduleMutationResult<readonly PerformanceTimingEventTrace[]> {
  const existingIds = new Set(schedule.events.map((event) => event.id));
  const incomingIds = new Set<string>();
  for (const event of events) {
    if (
      !event.id
      || !event.semanticAxisId
      || !event.semanticGroup
      || !Number.isFinite(event.atMs)
      || event.atMs < 0
      || !Number.isFinite(event.transitionMs)
      || event.transitionMs < 0
      || !Number.isFinite(event.holdMs)
      || event.holdMs < 0
      || !Number.isFinite(event.residualMs)
      || event.residualMs < 0
      || existingIds.has(event.id)
      || incomingIds.has(event.id)
    ) {
      return {
        ok: false,
        value: null,
        reason: `performance_schedule_event_invalid:${event.id || "unknown_event"}`,
      };
    }
    incomingIds.add(event.id);
  }
  mutableEvents(schedule).push(...events.map((event) => ({
    ...event,
    phraseIndices: event.phraseIndices ? [...event.phraseIndices] : undefined,
  })));
  return { ok: true, value: events, reason: "" };
}

function mutableEvents(schedule: PerformanceSchedule): PerformanceTimingEventTrace[] {
  return schedule.events as PerformanceTimingEventTrace[];
}

function mutableParameterNodes(
  schedule: PerformanceSchedule,
): PerformanceParameterNodeTrace[] {
  return schedule.parameterNodes as PerformanceParameterNodeTrace[];
}

function buildSemanticEventId(semanticAxisId: string, stepIndex: number): string {
  return `semantic:${semanticAxisId}:step:${stepIndex}`;
}

function buildSpeechEventId(
  channelId: string,
  kind: "start" | "phrase" | "release",
  index: number,
): string {
  return `speech:${channelId}:${kind}:${index}`;
}

function buildParameterNodeKey(node: PerformanceParameterNodeTrace): string {
  return `${node.trackKind}:${node.parameterId}:${node.nodeIndex}`;
}

function resolveTransitionWindow(
  availableWindowMs: number,
  policy: PerformanceTrackTimingPolicy,
): { transitionMs: number; compressed: boolean } {
  const preferredWindowMs = policy.transitionMs + policy.preferredHoldMs;
  if (availableWindowMs >= preferredWindowMs) {
    return { transitionMs: policy.transitionMs, compressed: false };
  }
  if (availableWindowMs <= 0) {
    return { transitionMs: 0, compressed: true };
  }
  const transitionRatio = policy.transitionMs / preferredWindowMs;
  return {
    transitionMs: Math.min(
      policy.transitionMs,
      Math.max(1, Math.round(availableWindowMs * transitionRatio)),
    ),
    compressed: true,
  };
}

function resolveTrackTimingPolicy(semanticGroup: string): PerformanceTrackTimingPolicy {
  const group = semanticGroup.trim().toLowerCase();
  if (group === "gaze") {
    return {
      transitionOffsetMs: -70,
      transitionMs: 80,
      preferredHoldMs: 45,
      residualMs: 20,
    };
  }
  if (group === "head") {
    return {
      transitionOffsetMs: 0,
      transitionMs: 110,
      preferredHoldMs: 55,
      residualMs: 70,
    };
  }
  if (group === "body" || group === "torso" || group === "shoulder") {
    return {
      transitionOffsetMs: 110,
      transitionMs: 140,
      preferredHoldMs: 70,
      residualMs: 150,
    };
  }
  if (group === "eye" || group === "brow" || group === "mouth" || group === "face") {
    return {
      transitionOffsetMs: 25,
      transitionMs: 80,
      preferredHoldMs: 45,
      residualMs: 40,
    };
  }
  return {
    transitionOffsetMs: 0,
    transitionMs: 100,
    preferredHoldMs: 50,
    residualMs: 60,
  };
}

function coalesceSpeechPhrases(
  phrases: readonly PerformancePhraseSlot[],
  maximumCount: number,
): PerformanceSpeechPhraseGroup[] {
  if (phrases.length <= maximumCount) {
    return phrases.map((phrase) => buildSpeechPhraseGroup([phrase]));
  }
  const result: PerformanceSpeechPhraseGroup[] = [];
  for (let index = 0; index < maximumCount; index += 1) {
    const start = Math.floor((index * phrases.length) / maximumCount);
    const end = Math.floor(((index + 1) * phrases.length) / maximumCount);
    result.push(buildSpeechPhraseGroup(
      phrases.slice(start, Math.max(start + 1, end)),
    ));
  }
  return result;
}

function buildSpeechPhraseGroup(
  phrases: readonly PerformancePhraseSlot[],
): PerformanceSpeechPhraseGroup {
  const firstPhrase = phrases[0];
  const finalPhrase = phrases[phrases.length - 1];
  return {
    phraseIndices: phrases.map((phrase) => phrase.index),
    text: phrases.map((phrase) => phrase.text).join(""),
    emphasis: Math.max(...phrases.map((phrase) => phrase.emphasis)),
    startRatio: firstPhrase.startRatio,
    endRatio: finalPhrase.endRatio,
  };
}

function resolveGesturePhraseLimit(
  availableMs: number,
  bodyLayer: boolean,
): number {
  const preferredWindowMs = bodyLayer ? 260 : 180;
  return clampInteger(
    Math.ceil(Math.max(1, availableMs) / preferredWindowMs),
    1,
    6,
  );
}

function clampInteger(value: number, minValue: number, maxValue: number): number {
  return Math.round(Math.max(minValue, Math.min(maxValue, value)));
}

function compileSemanticStepSlots(
  durationWeights: readonly number[] | undefined,
  durationMs: number,
):
  | { ok: true; semanticSteps: PerformanceSemanticStepSlot[] }
  | Extract<PerformanceScheduleCompileResult, { ok: false }> {
  if (durationWeights === undefined) {
    return { ok: true, semanticSteps: [] };
  }
  if (
    durationWeights.length < 2
    || durationWeights.length > 4
    || durationWeights.some(
      (weight) => !Number.isInteger(weight) || weight < 1 || weight > 3,
    )
  ) {
    return {
      ok: false,
      schedule: null,
      reason: "performance_schedule_sequence_shape_invalid",
    };
  }
  const totalWeight = durationWeights.reduce((sum, weight) => sum + weight, 0);
  const startTimes = resolveStepStartTimes(durationWeights, totalWeight, durationMs);
  const semanticSteps = durationWeights.map((durationWeight, index) => {
    const startMs = startTimes[index];
    const endMs = startTimes[index + 1] ?? durationMs;
    return {
      index,
      durationWeight,
      startMs,
      endMs,
      startRatio: startMs / durationMs,
      endRatio: endMs / durationMs,
    };
  });
  if (semanticSteps.some((step) => step.endMs <= step.startMs)) {
    return {
      ok: false,
      schedule: null,
      reason: "performance_schedule_sequence_window_invalid",
    };
  }
  return { ok: true, semanticSteps };
}

function resolveStepStartTimes(
  durationWeights: readonly number[],
  totalWeight: number,
  durationMs: number,
): number[] {
  const startTimes = [0];
  let elapsedWeight = durationWeights[0];
  for (let index = 1; index < durationWeights.length; index += 1) {
    const desiredAtMs = Math.round((elapsedWeight / totalWeight) * durationMs);
    const earliestAtMs = startTimes[index - 1] + 1;
    const latestAtMs = durationMs - (durationWeights.length - index);
    startTimes.push(Math.min(
      Math.max(desiredAtMs, earliestAtMs),
      Math.max(earliestAtMs, latestAtMs),
    ));
    elapsedWeight += durationWeights[index];
  }
  return startTimes;
}

function estimatePhraseStepAlignments(
  phrases: readonly PerformancePhraseSlot[],
  semanticSteps: readonly PerformanceSemanticStepSlot[],
  durationMs: number,
): PerformancePhraseStepAlignment[] {
  if (semanticSteps.length === 0) {
    return [];
  }
  const alignments: PerformancePhraseStepAlignment[] = [];
  for (const phrase of phrases) {
    const phraseStartMs = phrase.startRatio * durationMs;
    const phraseEndMs = phrase.endRatio * durationMs;
    const phraseDurationMs = phraseEndMs - phraseStartMs;
    const overlaps = semanticSteps.flatMap((step) => {
      const overlapMs = Math.min(phraseEndMs, step.endMs)
        - Math.max(phraseStartMs, step.startMs);
      return overlapMs > 0 ? [{ step, overlapMs }] : [];
    });
    let primaryStepIndex = -1;
    let primaryOverlapMs = -1;
    for (const overlap of overlaps) {
      if (overlap.overlapMs > primaryOverlapMs) {
        primaryStepIndex = overlap.step.index;
        primaryOverlapMs = overlap.overlapMs;
      }
    }
    for (const overlap of overlaps) {
      const stepDurationMs = overlap.step.endMs - overlap.step.startMs;
      alignments.push({
        kind: "estimated_time_overlap",
        phraseIndex: phrase.index,
        stepIndex: overlap.step.index,
        overlapRatio: overlap.overlapMs / durationMs,
        phraseCoverageRatio: overlap.overlapMs / phraseDurationMs,
        stepCoverageRatio: overlap.overlapMs / stepDurationMs,
        primaryForPhrase: overlap.step.index === primaryStepIndex,
      });
    }
  }
  return alignments;
}

function segmentAssistantText(text: string): PerformancePhraseDraft[] {
  if (!text) {
    return [createPhrase("", "none")];
  }

  const phrases: PerformancePhraseDraft[] = [];
  let buffer = "";
  for (const character of Array.from(text)) {
    buffer += character;
    const boundary = resolvePhraseBoundary(character);
    if (boundary === "none") {
      continue;
    }
    appendSplitPhrase(phrases, buffer, boundary);
    buffer = "";
  }
  appendSplitPhrase(phrases, buffer, "none");
  return phrases.length > 0 ? phrases : [createPhrase("", "none")];
}

function appendSplitPhrase(
  target: PerformancePhraseDraft[],
  text: string,
  boundary: PerformancePhraseBoundary,
): void {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return;
  }
  const characters = Array.from(normalizedText);
  if (!characters.some(isEffectiveSpeechCharacter)) {
    appendPhrase(target, normalizedText, boundary);
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
    appendPhrase(target, chunk, "none");
    chunk = "";
    effectiveLength = 0;
  }
  appendPhrase(target, chunk, boundary);
}

function appendPhrase(
  target: PerformancePhraseDraft[],
  text: string,
  boundary: PerformancePhraseBoundary,
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
    const merged = createPhrase(previous.text + normalizedText, boundary);
    previous.text = merged.text;
    previous.boundary = merged.boundary;
    previous.weight = merged.weight;
    previous.emphasis = merged.emphasis;
    return;
  }
  target.push(createPhrase(normalizedText, boundary));
}

function createPhrase(
  text: string,
  boundary: PerformancePhraseBoundary,
): PerformancePhraseDraft {
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

function resolvePhraseBoundary(character: string): PerformancePhraseBoundary {
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
