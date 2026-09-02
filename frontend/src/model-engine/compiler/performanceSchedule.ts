import {
  PERFORMANCE_SCHEDULE_TRACE_VERSION,
  type PerformanceParameterNodeTrace,
  type PerformanceScheduleTrace,
  type PerformanceTimingEventTrace,
} from "../../types/compiledSemanticMotion.js";
import type { OutputSegmentSpeechCue } from "../../types/protocol.js";
import {
  MAX_MOTION_DURATION_MS,
  MAX_PARAMETER_KEYFRAME_COUNT,
} from "../constants.js";
import {
  clampInteger,
  hashPerformanceIdentity,
  performanceUnitInterval,
} from "./performanceDeterminism.js";
import {
  buildSpeechPhraseGroup,
  coalesceSpeechPhrases,
  compileSemanticStepSlots,
  estimatePhraseStepAlignments,
  applySpeechCuesToPhrases,
  resolveGesturePhraseLimit,
  segmentAssistantText,
} from "./performanceScheduleText.js";
import type {
  PerformanceHesitationReason,
  PerformanceHesitationWindow,
  PerformancePartTrackStrategy,
  PerformancePartTrackTiming,
  PerformancePhraseSlot,
  PerformanceSchedule,
  PerformanceScheduleCompileResult,
  PerformanceScheduleMutationResult,
  PerformanceSequenceStepInput,
  PerformanceSpeechCueMapping,
  PerformanceSpeechPhraseGroup,
  PerformanceSpeechTrackTiming,
  PerformanceStagedPartTrackStrategy,
} from "./performanceScheduleTypes.js";

export type {
  PerformancePartTrackStrategy,
  PerformancePartTrackTiming,
  PerformancePhraseBoundary,
  PerformancePhraseSlot,
  PerformancePhraseStepAlignment,
  PerformanceSchedule,
  PerformanceScheduleCompileResult,
  PerformanceScheduleMutationResult,
  PerformanceSemanticStepSlot,
  PerformanceSpeechPhraseGroup,
  PerformanceSpeechTrackTiming,
  PerformanceSpeechCueMapping,
  PerformanceStagedPartTrackStrategy,
} from "./performanceScheduleTypes.js";

interface PerformanceHesitationCandidate {
  reason: PerformanceHesitationReason;
  anchorAtMs: number;
  holdMs: number;
  priority: number;
  stepIndex?: number;
  afterPhraseIndex?: number;
  phraseIndices?: readonly number[];
  speechCueIndex?: number;
}

interface PerformanceTrackTimingPolicy {
  transitionOffsetMs: number;
  transitionMs: number;
  preferredHoldMs: number;
}
const GAZE_LEAD_OFFSET_MS = 80;
const GAZE_DWELL_AT_MS = 60;
const GAZE_DWELL_TRANSITION_MS = 70;
const GAZE_TRANSFER_TRANSITION_MS = 80;
const GAZE_MIN_DWELL_MS = 55;
const FACE_SETTLE_AT_MS = 45;
const FACE_SETTLE_TRANSITION_MS = 75;
const FACE_TRANSFER_OFFSET_MS = 25;
const FACE_TRANSFER_TRANSITION_MS = 80;
const FACE_MIN_HOLD_MS = 45;
const FACE_RESIDUAL_MS = 40;
const FACE_SEMANTIC_GROUPS = new Set(["eye", "brow", "mouth", "face"]);
const HESITATION_MIN_START_MS = 120;
const HESITATION_MIN_REMAINING_MS = 140;
const HESITATION_INTENT_PATTERN = /hesitat|ponder|uncertain|pause|think|犹豫|迟疑|斟酌|思考|停顿/u;
const HESITATION_TRANSITION_PATTERN = /^(?:但是|不过|然而|可是|其实|只是|反而|but\b|however\b|though\b|well\b)/iu;

type PerformancePartTrackEventKind =
  | "gaze_lead"
  | "gaze_dwell"
  | "gaze_transfer"
  | "face_enter"
  | "face_settle"
  | "face_transfer";

type PerformancePartTrackReleaseKind = "gaze_release" | "face_release";

interface PerformancePartTrackDraft {
  kind: PerformancePartTrackEventKind;
  desiredAtMs: number;
  preferredTransitionMs: number;
  stepIndex?: number;
  phraseIndices?: readonly number[];
  transitionOffsetMs: number;
}

interface FinalizePartTrackTimingOptions {
  schedule: PerformanceSchedule;
  strategy: PerformanceStagedPartTrackStrategy;
  semanticAxisId: string;
  semanticGroup: string;
  blendOutMs: number;
  allowTailExtension: boolean;
  trackDrafts: readonly PerformancePartTrackDraft[];
  releaseKind: PerformancePartTrackReleaseKind;
  source: Extract<PerformanceTimingEventTrace["source"], "gaze_strategy" | "face_strategy">;
  timingSource: Extract<
    PerformanceTimingEventTrace["timingSource"],
    "gaze_schedule_policy" | "face_schedule_policy"
  >;
  staggered: boolean;
}

function isFaceSemanticGroup(semanticGroup: string): boolean {
  return FACE_SEMANTIC_GROUPS.has(semanticGroup.trim().toLowerCase());
}

export function resolvePerformancePartTrackStrategy(
  semanticGroup: string,
): PerformanceStagedPartTrackStrategy | null {
  const normalizedGroup = semanticGroup.trim().toLowerCase();
  if (normalizedGroup === "gaze") {
    return "gaze";
  }
  return isFaceSemanticGroup(normalizedGroup) ? "face" : null;
}

export function compilePerformanceSchedule(options: {
  assistantText?: string;
  speechCues?: readonly OutputSegmentSpeechCue[];
  durationMs: number;
  intentTags?: readonly string[];
  sequenceSteps?: readonly PerformanceSequenceStepInput[];
}): PerformanceScheduleCompileResult {
  if (
    !Number.isInteger(options.durationMs)
    || options.durationMs <= 0
    || options.durationMs > MAX_MOTION_DURATION_MS
  ) {
    return {
      ok: false,
      schedule: null,
      reason: "performance_schedule_duration_invalid",
    };
  }
  const text = typeof options.assistantText === "string"
    ? options.assistantText.trim()
    : "";
  const textSource = text ? "assistant_text" : "duration_only";
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
  const speechCueResult = textSource === "assistant_text"
    ? applySpeechCuesToPhrases(phrases, options.speechCues)
    : { phrases, mappings: [] };
  const resolvedPhrases = speechCueResult.phrases;
  const semanticStepsResult = compileSemanticStepSlots(
    options.sequenceSteps?.map((step) => step.durationWeight),
    options.durationMs,
  );
  if (!semanticStepsResult.ok) {
    return semanticStepsResult;
  }
  const semanticSteps = semanticStepsResult.semanticSteps;
  const estimatedAlignments = textSource === "assistant_text"
    ? estimatePhraseStepAlignments(resolvedPhrases, semanticSteps, options.durationMs)
    : [];
  const schedule: PerformanceSchedule = {
    durationMs: options.durationMs,
    textSource,
    phrases: resolvedPhrases,
    speechCueMappings: speechCueResult.mappings,
    semanticSteps,
    estimatedAlignments,
    hesitationWindows: [],
    decisions: [],
    events: [],
    parameterNodes: [],
  };
  const hesitationResult = compileHesitationWindows(
    schedule,
    options.intentTags ?? [],
  );
  if (!hesitationResult.ok) {
    return {
      ok: false,
      schedule: null,
      reason: hesitationResult.reason,
    };
  }
  return {
    ok: true,
    reason: "",
    schedule,
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
    speechCueMappings: schedule.speechCueMappings.map((mapping) => ({
      ...mapping,
      targetPhraseIndices: [...mapping.targetPhraseIndices],
    })),
    decisions: [...schedule.decisions],
    events: schedule.events.map((event) => ({
      ...event,
      phraseIndices: event.phraseIndices ? [...event.phraseIndices] : undefined,
    })),
    parameterNodes: schedule.parameterNodes.map((node) => ({ ...node })),
  };
}

function compileHesitationWindows(
  schedule: PerformanceSchedule,
  intentTags: readonly string[],
): PerformanceScheduleMutationResult<readonly PerformanceHesitationWindow[]> {
  const candidates = collectHesitationCandidates(schedule, intentTags);
  const legalCandidates: PerformanceHesitationCandidate[] = [];
  for (const candidate of candidates) {
    if (
      candidate.anchorAtMs < HESITATION_MIN_START_MS
      || candidate.anchorAtMs + candidate.holdMs
        > schedule.durationMs - HESITATION_MIN_REMAINING_MS
    ) {
      mutableDecisions(schedule).push(
        candidate.speechCueIndex === undefined
          ? `hesitation_not_scheduled:insufficient_window:${candidate.reason}:${candidate.anchorAtMs}`
          : `speech_cue_not_scheduled:${candidate.speechCueIndex}:insufficient_window:${candidate.anchorAtMs}`,
      );
      continue;
    }
    legalCandidates.push(candidate);
  }
  const selected = legalCandidates.sort((left, right) => (
    right.priority - left.priority || left.anchorAtMs - right.anchorAtMs
  ))[0];
  if (!selected) {
    return { ok: true, value: [], reason: "" };
  }
  for (const candidate of legalCandidates) {
    if (
      candidate.speechCueIndex !== undefined
      && candidate !== selected
    ) {
      recordPerformanceDecision(
        schedule,
        `speech_cue_not_scheduled:${candidate.speechCueIndex}:competing_window`,
      );
    }
  }
  if (selected.speechCueIndex !== undefined) {
    recordPerformanceDecision(
      schedule,
      `speech_cue_scheduled:${selected.speechCueIndex}:${selected.anchorAtMs}->${selected.anchorAtMs + selected.holdMs}`,
    );
  }

  const window: PerformanceHesitationWindow = {
    index: 0,
    reason: selected.reason,
    startMs: selected.anchorAtMs,
    resumeMs: selected.anchorAtMs + selected.holdMs,
    holdMs: selected.holdMs,
    stepIndex: selected.stepIndex,
    afterPhraseIndex: selected.afterPhraseIndex,
    phraseIndices: selected.phraseIndices ? [...selected.phraseIndices] : undefined,
  };
  const sharedEvent = {
    source: "hesitation_strategy" as const,
    timingSource: "hesitation_schedule_policy" as const,
    semanticAxisId: "performance_hesitation",
    semanticGroup: "discourse",
    transitionMs: 0,
    residualMs: 0,
    transitionOffsetMs: 0,
    compressed: false,
    stepIndex: window.stepIndex,
    phraseIndices: window.phraseIndices ? [...window.phraseIndices] : undefined,
    hesitationReason: window.reason,
    windowStartMs: window.startMs,
    windowEndMs: window.resumeMs,
  };
  const events: PerformanceTimingEventTrace[] = [{
    ...sharedEvent,
    id: buildHesitationEventId(window.reason, "hold", window.index),
    kind: "hesitation_hold",
    atMs: window.startMs,
    holdMs: window.holdMs,
  }, {
    ...sharedEvent,
    id: buildHesitationEventId(window.reason, "resume", window.index),
    kind: "hesitation_resume",
    atMs: window.resumeMs,
    holdMs: 0,
  }];
  const registerResult = registerPerformanceTimingEvents(schedule, events);
  if (!registerResult.ok) {
    return registerResult;
  }
  mutableHesitationWindows(schedule).push(window);
  mutableDecisions(schedule).push(
    `hesitation_scheduled:${window.reason}:${window.startMs}->${window.resumeMs}`,
  );
  return { ok: true, value: [window], reason: "" };
}

export function compileSemanticTrackTiming(options: {
  schedule: PerformanceSchedule;
  semanticAxisId: string;
  semanticGroup: string;
  changedStepIndices: readonly number[];
  blendOutMs: number;
  reversalStepIndices: readonly number[];
}): PerformanceScheduleMutationResult<PerformancePartTrackTiming> {
  const {
    schedule,
    semanticAxisId,
    semanticGroup,
    changedStepIndices,
    blendOutMs,
    reversalStepIndices,
  } = options;
  const normalizedGroup = semanticGroup.trim().toLowerCase();
  if (normalizedGroup === "gaze" || isFaceSemanticGroup(normalizedGroup)) {
    return {
      ok: false,
      value: null,
      reason: normalizedGroup === "gaze"
        ? `performance_schedule_gaze_strategy_required:${semanticAxisId || "unknown_axis"}`
        : `performance_schedule_face_strategy_required:${semanticAxisId || "unknown_axis"}`,
    };
  }
  if (
    !semanticAxisId
    || !Number.isInteger(blendOutMs)
    || blendOutMs < 0
    || blendOutMs > schedule.durationMs
    || changedStepIndices.length < 1
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
  const reversalSteps = new Set(reversalStepIndices);
  const firstChangedStepIndex = changedStepIndices[0];
  const firstChangedStep = schedule.semanticSteps[firstChangedStepIndex];
  const baseReleaseAtMs = Math.max(1, schedule.durationMs - blendOutMs);
  if (changedStepIndices.length === 1) {
    if (firstChangedStep.index === 0) {
      return {
        ok: true,
        reason: "",
        value: {
          strategy: "semantic",
          events: [],
          parameterEvents: [],
          requiredOwnedUntilMs: baseReleaseAtMs,
          staggered: false,
          residual: false,
          compressed: false,
        },
      };
    }
    // A sparse sequence may introduce an axis after playback has started. It
    // has no parameter-to-parameter transition, but it still needs time at
    // full ownership before the shared plan releases it.
    const activationEndMs = firstChangedStep.startMs
      + policy.transitionMs
      + policy.preferredHoldMs;
    const residualMs = resolvePerformanceResidualMs(
      schedule,
      semanticAxisId,
      semanticGroup,
      "semantic",
      Math.max(0, MAX_MOTION_DURATION_MS - blendOutMs - activationEndMs),
      false,
    );
    const requiredOwnedUntilMs = Math.max(
      baseReleaseAtMs,
      activationEndMs + residualMs,
    );
    recordPerformanceDecision(
      schedule,
      `semantic_delayed_activation:${semanticAxisId}:${firstChangedStep.index}:${requiredOwnedUntilMs}`,
    );
    return {
      ok: true,
      reason: "",
      value: {
        strategy: "semantic",
        events: [],
        parameterEvents: [],
        requiredOwnedUntilMs,
        staggered: false,
        residual: residualMs > 0,
        compressed: false,
      },
    };
  }
  const transitionStarts: number[] = [];
  let previousAtMs = firstChangedStep.startMs;
  let reversalPreparationMs = 0;
  for (let position = 1; position < changedStepIndices.length; position += 1) {
    const step = schedule.semanticSteps[changedStepIndices[position]];
    if (reversalSteps.has(step.index)) {
      reversalPreparationMs += policy.preferredHoldMs;
      recordPerformanceDecision(
        schedule,
        `semantic_reversal_preparation:${semanticAxisId}:${step.index}:${policy.preferredHoldMs}`,
      );
    }
    const desiredAtMs = resolveHesitationAdjustedStepAtMs(
      schedule,
      step.index,
      Math.max(
        1,
        Math.round(step.startMs + policy.transitionOffsetMs + reversalPreparationMs),
      ),
    );
    const atMs = Math.max(desiredAtMs, previousAtMs + 1);
    transitionStarts.push(atMs);
    previousAtMs = atMs;
  }

  const events: PerformanceTimingEventTrace[] = [];
  let compressed = false;
  let finalTransitionEndMs = firstChangedStep.startMs;
  const initialNextAtMs = transitionStarts[0] ?? schedule.durationMs;
  events.push({
    id: buildSemanticEventId(semanticAxisId, firstChangedStep.index),
    kind: "semantic_transition",
    source: "semantic_step",
    timingSource: "semantic_group_policy",
    semanticAxisId,
    semanticGroup,
    atMs: firstChangedStep.startMs,
    transitionMs: 0,
    holdMs: Math.max(0, initialNextAtMs - firstChangedStep.startMs),
    residualMs: 0,
    transitionOffsetMs: 0,
    compressed: false,
    stepIndex: firstChangedStep.index,
  });

  for (let position = 0; position < transitionStarts.length; position += 1) {
    const stepIndex = changedStepIndices[position + 1];
    const atMs = transitionStarts[position];
    const nextAtMs = transitionStarts[position + 1];
    const availableWindowMs = nextAtMs === undefined
      ? Math.max(0, schedule.durationMs - atMs)
      : nextAtMs - atMs;
    const transition = nextAtMs === undefined
      ? { transitionMs: policy.transitionMs, compressed: false }
      : resolveTransitionWindow(availableWindowMs, policy);
    compressed ||= transition.compressed;
    const transitionEndMs = atMs + transition.transitionMs;
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
      residualMs: 0,
      transitionOffsetMs: policy.transitionOffsetMs,
      compressed: transition.compressed,
      compressionReason: transition.compressed
        ? "transition_window_short"
        : undefined,
      stepIndex,
    });
    finalTransitionEndMs = transitionEndMs;
  }

  if (finalTransitionEndMs + blendOutMs > MAX_MOTION_DURATION_MS) {
    const requiredDurationMs = finalTransitionEndMs + blendOutMs;
    return {
      ok: false,
      value: null,
      reason: `performance_schedule_semantic_track_duration_exceeded:${semanticAxisId}:${requiredDurationMs}`,
    };
  }

  const residualMs = resolvePerformanceResidualMs(
    schedule,
    semanticAxisId,
    semanticGroup,
    "semantic",
    Math.max(0, MAX_MOTION_DURATION_MS - blendOutMs - finalTransitionEndMs),
    reversalStepIndices.includes(
      changedStepIndices[changedStepIndices.length - 1] ?? -1,
    ),
  );
  const requiredOwnedUntilMs = Math.max(
    baseReleaseAtMs,
    finalTransitionEndMs + residualMs,
  );
  const finalEvent = events[events.length - 1];
  if (finalEvent) {
    events[events.length - 1] = {
      ...finalEvent,
      holdMs: Math.max(
        0,
        requiredOwnedUntilMs - finalTransitionEndMs - residualMs,
      ),
      residualMs,
    };
  }

  const registerResult = registerPerformanceTimingEvents(schedule, events);
  if (!registerResult.ok) {
    return registerResult;
  }
  return {
    ok: true,
    reason: "",
    value: {
      strategy: "semantic",
      events,
      parameterEvents: events,
      requiredOwnedUntilMs,
      staggered: policy.transitionOffsetMs !== 0,
      residual: residualMs > 0,
      compressed,
    },
  };
}

export function compileGazeTrackTiming(options: {
  schedule: PerformanceSchedule;
  semanticAxisId: string;
  semanticGroup: string;
  changedStepIndices: readonly number[];
  blendOutMs: number;
  allowTailExtension: boolean;
}): PerformanceScheduleMutationResult<PerformancePartTrackTiming> {
  const {
    schedule,
    semanticAxisId,
    semanticGroup,
    changedStepIndices,
    blendOutMs,
    allowTailExtension,
  } = options;
  const sequenceSchedule = schedule.semanticSteps.length > 0;
  if (
    !semanticAxisId
    || semanticGroup.trim().toLowerCase() !== "gaze"
    || !Number.isInteger(blendOutMs)
    || blendOutMs < 0
    || blendOutMs > schedule.durationMs
    || changedStepIndices.length === 0
    || changedStepIndices.length > MAX_PARAMETER_KEYFRAME_COUNT
    || changedStepIndices.some((stepIndex, index) => (
      !Number.isInteger(stepIndex)
      || stepIndex < 0
      || (sequenceSchedule && stepIndex >= schedule.semanticSteps.length)
      || (!sequenceSchedule && stepIndex !== 0)
      || (index > 0 && stepIndex <= changedStepIndices[index - 1])
    ))
  ) {
    return {
      ok: false,
      value: null,
      reason: `performance_schedule_gaze_track_invalid:${semanticAxisId || "unknown_axis"}`,
    };
  }

  const firstChangedStepIndex = changedStepIndices[0];
  const firstActivationAtMs = sequenceSchedule
    ? schedule.semanticSteps[firstChangedStepIndex].startMs
    : 0;
  const firstPhraseIndices = sequenceSchedule
    ? resolvePrimaryPhraseIndices(schedule, firstChangedStepIndex)
    : (schedule.phrases[0] ? [schedule.phrases[0].index] : undefined);
  const transferDrafts = changedStepIndices.slice(1).map((stepIndex) => {
    const step = schedule.semanticSteps[stepIndex];
    return {
      kind: "gaze_transfer" as const,
      desiredAtMs: resolveHesitationAdjustedStepAtMs(
        schedule,
        stepIndex,
        Math.max(firstActivationAtMs + 1, step.startMs - GAZE_LEAD_OFFSET_MS),
      ),
      preferredTransitionMs: GAZE_TRANSFER_TRANSITION_MS,
      stepIndex,
      phraseIndices: resolvePrimaryPhraseIndices(schedule, stepIndex),
      transitionOffsetMs: -GAZE_LEAD_OFFSET_MS,
    };
  });
  const firstTransferAtMs = transferDrafts[0]?.desiredAtMs;
  const includeDwell = changedStepIndices.length < MAX_PARAMETER_KEYFRAME_COUNT
    && (firstTransferAtMs === undefined
      || firstTransferAtMs >= firstActivationAtMs
        + GAZE_DWELL_AT_MS + GAZE_DWELL_TRANSITION_MS + GAZE_MIN_DWELL_MS);
  const trackDrafts: PerformancePartTrackDraft[] = [{
    kind: "gaze_lead",
    desiredAtMs: firstActivationAtMs,
    preferredTransitionMs: 0,
    stepIndex: sequenceSchedule ? firstChangedStepIndex : undefined,
    phraseIndices: firstPhraseIndices,
    transitionOffsetMs: 0,
  }];
  if (includeDwell) {
    trackDrafts.push({
      kind: "gaze_dwell",
      desiredAtMs: firstActivationAtMs + GAZE_DWELL_AT_MS,
      preferredTransitionMs: GAZE_DWELL_TRANSITION_MS,
      stepIndex: sequenceSchedule ? firstChangedStepIndex : undefined,
      phraseIndices: firstPhraseIndices,
      transitionOffsetMs: GAZE_DWELL_AT_MS,
    });
  }
  trackDrafts.push(...transferDrafts);

  if (changedStepIndices.length === 1 && trackDrafts.length < MAX_PARAMETER_KEYFRAME_COUNT) {
    const phraseTransfer = resolveGazePhraseTransfer(schedule);
    if (phraseTransfer) {
      trackDrafts.push({
        kind: "gaze_transfer",
        desiredAtMs: resolveHesitationAdjustedPhraseAtMs(
          schedule,
          phraseTransfer.index,
          Math.max(
            firstActivationAtMs + 1,
            Math.round(phraseTransfer.endRatio * schedule.durationMs),
          ),
        ),
        preferredTransitionMs: GAZE_TRANSFER_TRANSITION_MS,
        phraseIndices: [phraseTransfer.index],
        transitionOffsetMs: 0,
      });
    }
  }
  return finalizePartTrackTiming({
    schedule,
    strategy: "gaze",
    semanticAxisId,
    semanticGroup,
    blendOutMs,
    allowTailExtension,
    trackDrafts,
    releaseKind: "gaze_release",
    source: "gaze_strategy",
    timingSource: "gaze_schedule_policy",
    staggered: transferDrafts.length > 0,
  });
}

export function compileFaceTrackTiming(options: {
  schedule: PerformanceSchedule;
  semanticAxisId: string;
  semanticGroup: string;
  changedStepIndices: readonly number[];
  blendOutMs: number;
  allowTailExtension: boolean;
}): PerformanceScheduleMutationResult<PerformancePartTrackTiming> {
  const {
    schedule,
    semanticAxisId,
    semanticGroup,
    changedStepIndices,
    blendOutMs,
    allowTailExtension,
  } = options;
  const sequenceSchedule = schedule.semanticSteps.length > 0;
  if (
    !semanticAxisId
    || !isFaceSemanticGroup(semanticGroup)
    || !Number.isInteger(blendOutMs)
    || blendOutMs < 0
    || blendOutMs > schedule.durationMs
    || changedStepIndices.length === 0
    || changedStepIndices.length > MAX_PARAMETER_KEYFRAME_COUNT
    || changedStepIndices.some((stepIndex, index) => (
      !Number.isInteger(stepIndex)
      || stepIndex < 0
      || (sequenceSchedule && stepIndex >= schedule.semanticSteps.length)
      || (!sequenceSchedule && stepIndex !== 0)
      || (index > 0 && stepIndex <= changedStepIndices[index - 1])
    ))
  ) {
    return {
      ok: false,
      value: null,
      reason: `performance_schedule_face_track_invalid:${semanticAxisId || "unknown_axis"}`,
    };
  }

  const firstChangedStepIndex = changedStepIndices[0];
  const firstActivationAtMs = sequenceSchedule
    ? schedule.semanticSteps[firstChangedStepIndex].startMs
    : 0;
  const firstPhraseIndices = sequenceSchedule
    ? resolvePrimaryPhraseIndices(schedule, firstChangedStepIndex)
    : (schedule.phrases[0] ? [schedule.phrases[0].index] : undefined);
  const transferDrafts: PerformancePartTrackDraft[] = changedStepIndices
    .slice(1)
    .map((stepIndex) => {
      const step = schedule.semanticSteps[stepIndex];
      return {
        kind: "face_transfer",
        desiredAtMs: resolveHesitationAdjustedStepAtMs(
          schedule,
          stepIndex,
          Math.max(firstActivationAtMs + 1, step.startMs + FACE_TRANSFER_OFFSET_MS),
        ),
        preferredTransitionMs: FACE_TRANSFER_TRANSITION_MS,
        stepIndex,
        phraseIndices: resolvePrimaryPhraseIndices(schedule, stepIndex),
        transitionOffsetMs: FACE_TRANSFER_OFFSET_MS,
      };
    });
  const firstTransferAtMs = transferDrafts[0]?.desiredAtMs;
  const includeSettle = changedStepIndices.length < MAX_PARAMETER_KEYFRAME_COUNT
    && (firstTransferAtMs === undefined
      || firstTransferAtMs >= firstActivationAtMs
        + FACE_SETTLE_AT_MS + FACE_SETTLE_TRANSITION_MS + FACE_MIN_HOLD_MS);
  const trackDrafts: PerformancePartTrackDraft[] = [{
    kind: "face_enter",
    desiredAtMs: firstActivationAtMs,
    preferredTransitionMs: 0,
    stepIndex: sequenceSchedule ? firstChangedStepIndex : undefined,
    phraseIndices: firstPhraseIndices,
    transitionOffsetMs: 0,
  }];
  if (includeSettle) {
    trackDrafts.push({
      kind: "face_settle",
      desiredAtMs: firstActivationAtMs + FACE_SETTLE_AT_MS,
      preferredTransitionMs: FACE_SETTLE_TRANSITION_MS,
      stepIndex: sequenceSchedule ? firstChangedStepIndex : undefined,
      phraseIndices: firstPhraseIndices,
      transitionOffsetMs: FACE_SETTLE_AT_MS,
    });
  }
  trackDrafts.push(...transferDrafts);

  return finalizePartTrackTiming({
    schedule,
    strategy: "face",
    semanticAxisId,
    semanticGroup,
    blendOutMs,
    allowTailExtension,
    trackDrafts,
    releaseKind: "face_release",
    source: "face_strategy",
    timingSource: "face_schedule_policy",
    staggered: transferDrafts.length > 0,
  });
}

function finalizePartTrackTiming(
  options: FinalizePartTrackTimingOptions,
): PerformanceScheduleMutationResult<PerformancePartTrackTiming> {
  const {
    schedule,
    strategy,
    semanticAxisId,
    semanticGroup,
    blendOutMs,
    allowTailExtension,
    trackDrafts,
    releaseKind,
    source,
    timingSource,
    staggered,
  } = options;
  const sortedDrafts = [...trackDrafts].sort(
    (left, right) => left.desiredAtMs - right.desiredAtMs,
  );
  const baseReleaseAtMs = Math.max(1, schedule.durationMs - blendOutMs);
  const normalizedDrafts: PerformancePartTrackDraft[] = [];
  let previousAtMs = -1;
  for (const draft of sortedDrafts) {
    const atMs = draft.desiredAtMs === 0
      ? 0
      : Math.max(previousAtMs + 1, draft.desiredAtMs);
    if (!allowTailExtension && atMs >= baseReleaseAtMs) {
      continue;
    }
    normalizedDrafts.push({ ...draft, desiredAtMs: atMs });
    previousAtMs = atMs;
  }

  let releaseAtMs = baseReleaseAtMs;
  const finalDraft = normalizedDrafts[normalizedDrafts.length - 1];
  const residualMs = finalDraft
    ? resolvePerformanceResidualMs(
        schedule,
        semanticAxisId,
        semanticGroup,
        strategy,
        Math.max(
          0,
          (allowTailExtension
            ? MAX_MOTION_DURATION_MS - blendOutMs
            : baseReleaseAtMs)
            - finalDraft.desiredAtMs
            - finalDraft.preferredTransitionMs,
        ),
        false,
      )
    : 0;
  if (allowTailExtension && finalDraft) {
    releaseAtMs = Math.min(
      MAX_MOTION_DURATION_MS - blendOutMs,
      Math.max(
        releaseAtMs,
        finalDraft.desiredAtMs
          + finalDraft.preferredTransitionMs
          + residualMs,
      ),
    );
  }

  const parameterEvents: PerformanceTimingEventTrace[] = [];
  let compressed = false;
  for (let index = 0; index < normalizedDrafts.length; index += 1) {
    const draft = normalizedDrafts[index];
    const nextAtMs = normalizedDrafts[index + 1]?.desiredAtMs ?? releaseAtMs;
    const availableTransitionMs = Math.max(0, nextAtMs - draft.desiredAtMs);
    const transitionMs = Math.min(draft.preferredTransitionMs, availableTransitionMs);
    const eventCompressed = transitionMs < draft.preferredTransitionMs;
    const eventResidualMs = index === normalizedDrafts.length - 1 ? residualMs : 0;
    compressed ||= eventCompressed;
    parameterEvents.push({
      id: buildPartTrackEventId(strategy, semanticAxisId, draft.kind, index),
      kind: draft.kind,
      source,
      timingSource,
      semanticAxisId,
      semanticGroup,
      atMs: draft.desiredAtMs,
      transitionMs,
      holdMs: Math.max(
        0,
        nextAtMs - draft.desiredAtMs - transitionMs - eventResidualMs,
      ),
      residualMs: eventResidualMs,
      transitionOffsetMs: draft.transitionOffsetMs,
      compressed: eventCompressed,
      compressionReason: eventCompressed ? "transition_window_short" : undefined,
      stepIndex: draft.stepIndex,
      phraseIndices: draft.phraseIndices ? [...draft.phraseIndices] : undefined,
    });
  }

  const releaseEvent: PerformanceTimingEventTrace = {
    id: buildPartTrackEventId(strategy, semanticAxisId, releaseKind, 0),
    kind: releaseKind,
    source,
    timingSource,
    semanticAxisId,
    semanticGroup,
    atMs: releaseAtMs,
    transitionMs: blendOutMs,
    holdMs: 0,
    residualMs: 0,
    transitionOffsetMs: releaseAtMs - baseReleaseAtMs,
    compressed: false,
    phraseIndices: schedule.phrases.length > 0
      ? [schedule.phrases[schedule.phrases.length - 1].index]
      : undefined,
  };
  const events = [...parameterEvents, releaseEvent];
  const registerResult = registerPerformanceTimingEvents(schedule, events);
  if (!registerResult.ok) {
    return registerResult;
  }
  return {
    ok: true,
    reason: "",
    value: {
      strategy,
      events,
      parameterEvents,
      requiredOwnedUntilMs: releaseAtMs,
      staggered,
      residual: releaseAtMs > baseReleaseAtMs,
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
    const baseCandidateAtMs = windowStartMs
      + Math.round(Math.max(1, windowEndMs - windowStartMs) * onsetRatio);
    const hesitationDelayMs = resolveHesitationDelayForPhraseGroup(
      schedule,
      phrase.phraseIndices,
      followDelayMs + baseCandidateAtMs,
    );
    const adjustedWindowStartMs = windowStartMs + hesitationDelayMs;
    const adjustedWindowEndMs = windowEndMs + hesitationDelayMs;
    const candidateAtMs = baseCandidateAtMs + hesitationDelayMs;
    const localAtMs = Math.max(candidateAtMs, previousAtMs + 1);
    const effectiveWindowEndMs = Math.min(settleAtMs, adjustedWindowEndMs);
    if (
      adjustedWindowStartMs >= settleAtMs
      || localAtMs >= effectiveWindowEndMs
    ) {
      return {
        ok: false,
        value: null,
        reason: `performance_schedule_speech_hesitation_window_exceeded:${channelId}:${index}:${hesitationDelayMs}`,
      };
    }
    phraseEvents.push({
      id: buildSpeechEventId(channelId, "phrase", index),
      kind: "speech_phrase",
      source: "speech_phrase",
      timingSource: "voice_following_profile",
      semanticAxisId,
      semanticGroup,
      atMs: followDelayMs + localAtMs,
      localAtMs,
      windowStartMs: followDelayMs + adjustedWindowStartMs,
      windowEndMs: followDelayMs + effectiveWindowEndMs,
      transitionMs: 0,
      holdMs: 0,
      residualMs: 0,
      transitionOffsetMs: localAtMs - adjustedWindowStartMs,
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

export function finalizePerformancePlanRelease(options: {
  schedule: PerformanceSchedule;
  releaseAtMs: number;
  blendOutMs: number;
}): PerformanceScheduleMutationResult<number> {
  const { schedule, releaseAtMs, blendOutMs } = options;
  if (
    !Number.isInteger(releaseAtMs)
    || releaseAtMs < 0
    || !Number.isInteger(blendOutMs)
    || blendOutMs < 0
    || releaseAtMs + blendOutMs > MAX_MOTION_DURATION_MS
  ) {
    return {
      ok: false,
      value: null,
      reason: `performance_schedule_plan_release_invalid:${releaseAtMs}:${blendOutMs}`,
    };
  }

  const events = mutableEvents(schedule);
  const finalParameterEventByAxis = new Map<string, PerformanceTimingEventTrace>();
  for (const event of events) {
    if (
      event.source !== "semantic_step"
      && event.source !== "gaze_strategy"
      && event.source !== "face_strategy"
    ) {
      continue;
    }
    if (event.kind === "gaze_release" || event.kind === "face_release") {
      continue;
    }
    const existing = finalParameterEventByAxis.get(event.semanticAxisId);
    if (!existing || event.atMs > existing.atMs) {
      finalParameterEventByAxis.set(event.semanticAxisId, event);
    }
  }

  const updatedEvents = new Map<string, PerformanceTimingEventTrace>();
  for (const event of finalParameterEventByAxis.values()) {
    const requestedReleaseAtMs = event.atMs
      + event.transitionMs
      + event.holdMs
      + event.residualMs;
    if (requestedReleaseAtMs > releaseAtMs) {
      return {
        ok: false,
        value: null,
        reason: `performance_schedule_plan_release_precedes_track:${event.semanticAxisId}:${requestedReleaseAtMs}:${releaseAtMs}`,
      };
    }
    updatedEvents.set(event.id, {
      ...event,
      holdMs: event.holdMs + releaseAtMs - requestedReleaseAtMs,
    });
  }

  const baseReleaseAtMs = Math.max(1, schedule.durationMs - blendOutMs);
  for (const event of events) {
    if (event.kind !== "gaze_release" && event.kind !== "face_release") {
      continue;
    }
    updatedEvents.set(event.id, {
      ...event,
      atMs: releaseAtMs,
      transitionMs: blendOutMs,
      transitionOffsetMs: releaseAtMs - baseReleaseAtMs,
    });
  }
  for (const event of updatedEvents.values()) {
    const invalidReason = validatePerformanceTimingEvent(schedule, event);
    if (invalidReason) {
      return { ok: false, value: null, reason: invalidReason };
    }
  }
  for (let index = 0; index < events.length; index += 1) {
    const updated = updatedEvents.get(events[index].id);
    if (updated) {
      events[index] = updated;
    }
  }
  recordPerformanceDecision(
    schedule,
    `plan_release_finalized:${baseReleaseAtMs}->${releaseAtMs}`,
  );
  return { ok: true, value: releaseAtMs, reason: "" };
}

function registerPerformanceTimingEvents(
  schedule: PerformanceSchedule,
  events: readonly PerformanceTimingEventTrace[],
): PerformanceScheduleMutationResult<readonly PerformanceTimingEventTrace[]> {
  const existingIds = new Set(schedule.events.map((event) => event.id));
  const incomingIds = new Set<string>();
  let previousAtMs = -1;
  for (const event of events) {
    const invalidReason = validatePerformanceTimingEvent(schedule, event);
    if (invalidReason) {
      return { ok: false, value: null, reason: invalidReason };
    }
    if (existingIds.has(event.id) || incomingIds.has(event.id)) {
      return {
        ok: false,
        value: null,
        reason: `performance_schedule_event_id_duplicate:${event.id}`,
      };
    }
    if (event.atMs < previousAtMs) {
      return {
        ok: false,
        value: null,
        reason: `performance_schedule_event_order_invalid:${event.id}:${event.atMs}:${previousAtMs}`,
      };
    }
    incomingIds.add(event.id);
    previousAtMs = event.atMs;
  }
  mutableEvents(schedule).push(...events.map((event) => ({
    ...event,
    phraseIndices: event.phraseIndices ? [...event.phraseIndices] : undefined,
  })));
  return { ok: true, value: events, reason: "" };
}

function validatePerformanceTimingEvent(
  schedule: PerformanceSchedule,
  event: PerformanceTimingEventTrace,
): string | null {
  const eventEndMs = event.atMs
    + event.transitionMs
    + event.holdMs
    + event.residualMs;
  if (
    !event.id
    || !event.semanticAxisId
    || !event.semanticGroup
    || !Number.isInteger(event.atMs)
    || event.atMs < 0
    || !Number.isInteger(event.transitionMs)
    || event.transitionMs < 0
    || !Number.isInteger(event.holdMs)
    || event.holdMs < 0
    || !Number.isInteger(event.residualMs)
    || event.residualMs < 0
    || !Number.isInteger(event.transitionOffsetMs)
    || !Number.isFinite(eventEndMs)
    || eventEndMs > MAX_MOTION_DURATION_MS
  ) {
    return `performance_schedule_event_invalid:${event.id || "unknown_event"}`;
  }
  if (
    event.stepIndex !== undefined
    && (
      !Number.isInteger(event.stepIndex)
      || event.stepIndex < 0
      || event.stepIndex >= schedule.semanticSteps.length
    )
  ) {
    return `performance_schedule_event_step_invalid:${event.id}:${event.stepIndex}`;
  }
  if (event.phraseIndices !== undefined) {
    const uniquePhraseIndices = new Set(event.phraseIndices);
    if (
      event.phraseIndices.length === 0
      || uniquePhraseIndices.size !== event.phraseIndices.length
      || event.phraseIndices.some((phraseIndex) => (
        !Number.isInteger(phraseIndex)
        || phraseIndex < 0
        || phraseIndex >= schedule.phrases.length
      ))
    ) {
      return `performance_schedule_event_phrase_invalid:${event.id}`;
    }
  }
  if (
    event.localAtMs !== undefined
    && (!Number.isInteger(event.localAtMs) || event.localAtMs < 0)
  ) {
    return `performance_schedule_event_local_time_invalid:${event.id}`;
  }
  const hasWindowStart = event.windowStartMs !== undefined;
  const hasWindowEnd = event.windowEndMs !== undefined;
  if (hasWindowStart !== hasWindowEnd) {
    return `performance_schedule_event_window_invalid:${event.id}`;
  }
  if (hasWindowStart && hasWindowEnd) {
    const windowStartMs = event.windowStartMs!;
    const windowEndMs = event.windowEndMs!;
    if (
      !Number.isInteger(windowStartMs)
      || !Number.isInteger(windowEndMs)
      || windowStartMs < 0
      || windowEndMs < windowStartMs
      || windowEndMs > MAX_MOTION_DURATION_MS
      || event.atMs < windowStartMs
      || event.atMs > windowEndMs
    ) {
      return `performance_schedule_event_window_invalid:${event.id}`;
    }
  }
  return null;
}

function mutableEvents(schedule: PerformanceSchedule): PerformanceTimingEventTrace[] {
  return schedule.events as PerformanceTimingEventTrace[];
}

function mutableHesitationWindows(
  schedule: PerformanceSchedule,
): PerformanceHesitationWindow[] {
  return schedule.hesitationWindows as PerformanceHesitationWindow[];
}

function mutableDecisions(schedule: PerformanceSchedule): string[] {
  return schedule.decisions as string[];
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

function buildHesitationEventId(
  reason: PerformanceHesitationReason,
  kind: "hold" | "resume",
  index: number,
): string {
  return `hesitation:${reason}:${kind}:${index}`;
}

function buildPartTrackEventId(
  strategy: PerformanceStagedPartTrackStrategy,
  semanticAxisId: string,
  kind: PerformancePartTrackEventKind | PerformancePartTrackReleaseKind,
  index: number,
): string {
  return `${strategy}:${semanticAxisId}:${kind}:${index}`;
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
  if (group === "head") {
    return {
      transitionOffsetMs: 0,
      transitionMs: 110,
      preferredHoldMs: 55,
    };
  }
  if (group === "body" || group === "torso" || group === "shoulder") {
    return {
      transitionOffsetMs: 110,
      transitionMs: 140,
      preferredHoldMs: 70,
    };
  }
  return {
    transitionOffsetMs: 0,
    transitionMs: 100,
    preferredHoldMs: 50,
  };
}

function resolvePerformanceResidualMs(
  schedule: PerformanceSchedule,
  semanticAxisId: string,
  semanticGroup: string,
  strategy: PerformancePartTrackStrategy,
  tailBudgetMs: number,
  finalTransitionReversed: boolean,
): number {
  const group = semanticGroup.trim().toLowerCase();
  const baseMs = strategy === "gaze"
    ? GAZE_MIN_DWELL_MS
    : strategy === "face"
      ? FACE_RESIDUAL_MS
      : group === "body" || group === "torso" || group === "shoulder"
        ? 150
        : group === "head"
          ? 70
          : 60;
  const lastPhrase = schedule.phrases[schedule.phrases.length - 1];
  const finalText = lastPhrase?.text ?? "";
  const reasons: string[] = [];
  let multiplier = 1;
  if (/[?？]\s*$/u.test(finalText)) {
    multiplier += strategy === "gaze" || strategy === "face" ? 0.25 : 0.12;
    reasons.push("question");
  } else if (/[!！]\s*$/u.test(finalText)) {
    multiplier -= 0.12;
    reasons.push("emphasis_release");
  } else if (lastPhrase?.boundary === "soft") {
    multiplier += 0.12;
    reasons.push("soft_boundary");
  }
  if ((lastPhrase?.emphasis ?? 1) > 1.1) {
    multiplier -= 0.08;
    reasons.push("emphasis");
  }
  if (schedule.hesitationWindows.length > 0) {
    multiplier += 0.12;
    reasons.push("hesitation");
  }
  if (finalTransitionReversed) {
    multiplier += 0.10;
    reasons.push("semantic_reversal");
  }
  const desiredMs = clampInteger(
    Math.round(baseMs * multiplier),
    20,
    strategy === "semantic" && (group === "body" || group === "torso" || group === "shoulder")
      ? 260
      : strategy === "gaze"
        ? 180
        : strategy === "face"
          ? 160
          : 180,
  );
  const residualMs = Math.min(desiredMs, Math.max(0, Math.round(tailBudgetMs)));
  recordPerformanceDecision(
    schedule,
    `residual_selected:${strategy}:${semanticAxisId}:${group || "unknown"}:${residualMs}:${reasons.join("+") || "base"}:${Math.max(0, Math.round(tailBudgetMs))}`,
  );
  return residualMs;
}

function recordPerformanceDecision(schedule: PerformanceSchedule, decision: string): void {
  if (!schedule.decisions.includes(decision)) {
    mutableDecisions(schedule).push(decision);
  }
}

function resolvePrimaryPhraseIndices(
  schedule: PerformanceSchedule,
  stepIndex: number,
): number[] | undefined {
  const phraseIndices = schedule.estimatedAlignments
    .filter((alignment) => alignment.stepIndex === stepIndex && alignment.primaryForPhrase)
    .map((alignment) => alignment.phraseIndex);
  return phraseIndices.length > 0 ? phraseIndices : undefined;
}

function collectHesitationCandidates(
  schedule: PerformanceSchedule,
  intentTags: readonly string[],
): PerformanceHesitationCandidate[] {
  const candidates: PerformanceHesitationCandidate[] = [];
  for (let index = 0; index < schedule.phrases.length - 1; index += 1) {
    const phrase = schedule.phrases[index];
    const nextPhrase = schedule.phrases[index + 1];
    const stepIndex = resolveStepIndexAfterPhrase(schedule, index);
    const anchorAtMs = stepIndex === undefined
      ? Math.round(phrase.endRatio * schedule.durationMs)
      : schedule.semanticSteps[stepIndex].startMs;
    const shared = {
      anchorAtMs,
      stepIndex,
      afterPhraseIndex: index,
      phraseIndices: [index],
    };
    const punctuationReason = resolveHesitationPunctuationReason(phrase.text);
    if (punctuationReason) {
      candidates.push({
        ...shared,
        reason: punctuationReason,
        holdMs: punctuationReason === "ellipsis" ? 160 : 130,
        priority: punctuationReason === "ellipsis" ? 100 : 95,
      });
    }
    if (HESITATION_TRANSITION_PATTERN.test(nextPhrase.text.trim())) {
      candidates.push({
        ...shared,
        reason: "transition",
        holdMs: 110,
        priority: 80,
      });
    } else if (phrase.boundary === "soft" && nextPhrase.boundary === "soft") {
      candidates.push({
        ...shared,
        reason: "soft_boundary",
        holdMs: 100,
        priority: 70,
      });
    }
  }

  if (HESITATION_INTENT_PATTERN.test(intentTags.join(" ").toLowerCase())) {
    const phrase = schedule.phrases
      .slice(0, -1)
      .filter((item) => item.boundary !== "none")
      .sort((left, right) => (
        Math.abs(left.endRatio - 0.52) - Math.abs(right.endRatio - 0.52)
      ))[0];
    if (phrase) {
      const stepIndex = resolveStepIndexAfterPhrase(schedule, phrase.index);
      candidates.push({
        reason: "intent_tag",
        anchorAtMs: stepIndex === undefined
          ? Math.round(phrase.endRatio * schedule.durationMs)
          : schedule.semanticSteps[stepIndex].startMs,
        holdMs: 125,
        priority: 60,
        stepIndex,
        afterPhraseIndex: phrase.index,
        phraseIndices: [phrase.index],
      });
    } else if (schedule.semanticSteps[1]) {
      candidates.push({
        reason: "intent_tag",
        anchorAtMs: schedule.semanticSteps[1].startMs,
        holdMs: 125,
        priority: 60,
        stepIndex: 1,
      });
    }
  }

  for (const mapping of schedule.speechCueMappings) {
    if (
      mapping.status !== "mapped"
      || (mapping.kind !== "hesitate"
        && mapping.kind !== "breath"
        && mapping.kind !== "sigh")
    ) {
      continue;
    }
    const firstTarget = mapping.targetPhraseIndices[0];
    const lastTarget = mapping.targetPhraseIndices[mapping.targetPhraseIndices.length - 1];
    if (firstTarget === undefined || lastTarget === undefined) {
      continue;
    }
    const afterPhraseIndex = mapping.position === "after"
      ? lastTarget
      : firstTarget > 0 ? firstTarget - 1 : undefined;
    const stepIndex = afterPhraseIndex === undefined
      ? undefined
      : resolveStepIndexAfterPhrase(schedule, afterPhraseIndex);
    const anchorPhraseIndex = mapping.position === "after"
      ? lastTarget
      : firstTarget;
    const phrase = schedule.phrases[anchorPhraseIndex];
    const anchorAtMs = stepIndex === undefined
      ? Math.round(
          ((mapping.position === "after"
            ? phrase?.endRatio
            : phrase?.startRatio) ?? 0) * schedule.durationMs,
        )
      : schedule.semanticSteps[stepIndex].startMs;
    candidates.push({
      reason: "speech_cue",
      anchorAtMs,
      holdMs: mapping.kind === "hesitate"
        ? 140
        : mapping.kind === "sigh"
          ? 110
          : 80,
      priority: mapping.kind === "hesitate"
        ? 115
        : mapping.kind === "sigh"
          ? 75
          : 65,
      stepIndex,
      afterPhraseIndex,
      phraseIndices: afterPhraseIndex === undefined
        ? undefined
        : [afterPhraseIndex],
      speechCueIndex: mapping.cueIndex,
    });
  }

  return candidates;
}

function resolveHesitationPunctuationReason(
  text: string,
): Extract<PerformanceHesitationReason, "ellipsis" | "dash"> | null {
  if (/(?:…+|\.{3,})\s*$/u.test(text)) {
    return "ellipsis";
  }
  return /(?:—+|--+)\s*$/u.test(text) ? "dash" : null;
}

function resolveStepIndexAfterPhrase(
  schedule: PerformanceSchedule,
  phraseIndex: number,
): number | undefined {
  const nextPhraseIndex = phraseIndex + 1;
  const alignment = schedule.estimatedAlignments.find((item) => (
    item.phraseIndex === nextPhraseIndex && item.primaryForPhrase && item.stepIndex > 0
  ));
  return alignment?.stepIndex;
}

function resolveHesitationAdjustedStepAtMs(
  schedule: PerformanceSchedule,
  stepIndex: number,
  desiredAtMs: number,
): number {
  const delayMs = schedule.hesitationWindows.reduce((sum, item) => (
    desiredAtMs >= item.startMs
      || (item.stepIndex !== undefined && item.stepIndex <= stepIndex)
      ? sum + item.holdMs
      : sum
  ), 0);
  return desiredAtMs + delayMs;
}

function resolveHesitationAdjustedPhraseAtMs(
  schedule: PerformanceSchedule,
  afterPhraseIndex: number,
  desiredAtMs: number,
): number {
  const delayMs = schedule.hesitationWindows.reduce((sum, item) => (
    desiredAtMs >= item.startMs
      || (
        item.afterPhraseIndex !== undefined
        && item.afterPhraseIndex <= afterPhraseIndex
      )
      ? sum + item.holdMs
      : sum
  ), 0);
  return desiredAtMs + delayMs;
}

function resolveHesitationDelayForPhraseGroup(
  schedule: PerformanceSchedule,
  phraseIndices: readonly number[],
  baseAtMs: number,
): number {
  let delayMs = 0;
  for (const item of schedule.hesitationWindows) {
    const afterPhraseIndex = item.afterPhraseIndex;
    if (
      baseAtMs >= item.startMs
      || (
        afterPhraseIndex !== undefined
        && phraseIndices.some((phraseIndex) => phraseIndex > afterPhraseIndex)
      )
    ) {
      delayMs += item.holdMs;
    }
  }
  return delayMs;
}

function resolveGazePhraseTransfer(
  schedule: PerformanceSchedule,
): PerformancePhraseSlot | null {
  if (schedule.durationMs < 900 || schedule.phrases.length < 2) {
    return null;
  }
  const finalText = schedule.phrases[schedule.phrases.length - 1].text;
  if (/[?？]\s*$/.test(finalText)) {
    return null;
  }
  const candidates = schedule.phrases.slice(0, -1).filter((phrase) => (
    phrase.endRatio >= 0.34
    && phrase.endRatio <= 0.72
    && phrase.boundary !== "none"
  ));
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((best, phrase) => (
    Math.abs(phrase.endRatio - 0.56) < Math.abs(best.endRatio - 0.56)
      ? phrase
      : best
  ));
}
