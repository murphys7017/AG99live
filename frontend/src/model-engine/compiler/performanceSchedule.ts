import {
  PERFORMANCE_SCHEDULE_TRACE_VERSION,
  type PerformanceScheduleTrace,
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
  };
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
