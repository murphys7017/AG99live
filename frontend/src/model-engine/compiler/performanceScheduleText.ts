import { clampInteger } from "./performanceDeterminism.js";
import type {
  PerformancePhraseBoundary,
  PerformancePhraseSlot,
  PerformancePhraseStepAlignment,
  PerformanceScheduleCompileResult,
  PerformanceSemanticStepSlot,
  PerformanceSpeechCueMapping,
  PerformanceSpeechPhraseGroup,
} from "./performanceScheduleTypes.js";
import type { OutputSegmentSpeechCue } from "../../types/protocol.js";

interface PerformancePhraseDraft {
  sourcePhraseIndex: number;
  text: string;
  boundary: PerformancePhraseBoundary;
  weight: number;
  emphasis: number;
}

const MAX_EFFECTIVE_PHRASE_LENGTH = 18;

export function segmentAssistantText(text: string): PerformancePhraseDraft[] {
  if (!text) {
    return [createPhrase("", "none", 0)];
  }

  const phrases: PerformancePhraseDraft[] = [];
  let buffer = "";
  let sourcePhraseIndex = 0;
  const characters = Array.from(text);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    buffer += character;
    const asciiEllipsis = character === "."
      && characters[index - 1] === "."
      && characters[index - 2] === ".";
    const asciiDash = character === "-" && characters[index - 1] === "-";
    const boundary = asciiEllipsis || asciiDash
      ? "soft"
      : resolvePhraseBoundary(character);
    if (boundary === "none") {
      continue;
    }
    appendSplitPhrase(phrases, buffer, boundary, sourcePhraseIndex);
    buffer = "";
    sourcePhraseIndex += 1;
  }
  appendSplitPhrase(phrases, buffer, "none", sourcePhraseIndex);
  return phrases.length > 0 ? phrases : [createPhrase("", "none", 0)];
}

export function applySpeechCuesToPhrases(
  phrases: readonly PerformancePhraseSlot[],
  cues: readonly OutputSegmentSpeechCue[] | undefined,
): {
  phrases: PerformancePhraseSlot[];
  mappings: PerformanceSpeechCueMapping[];
} {
  let nextPhrases = phrases.map((phrase) => ({ ...phrase }));
  const mappings: PerformanceSpeechCueMapping[] = [];
  const inputCues = cues ?? [];
  for (let cueIndex = 0; cueIndex < inputCues.length; cueIndex += 1) {
    const cue = inputCues[cueIndex];
    const targetPhraseIndices = nextPhrases
      .filter((phrase) => phrase.sourcePhraseIndex === cue.phrase_index)
      .map((phrase) => phrase.index);
    if (targetPhraseIndices.length === 0) {
      mappings.push({
        cueIndex,
        kind: cue.kind,
        sourcePhraseIndex: cue.phrase_index,
        position: cue.position,
        targetPhraseIndices: [],
        status: "ignored",
        reason: "speech_cue_source_phrase_not_found",
      });
      continue;
    }

    const emphasisMultiplier = resolveSpeechCueEmphasisMultiplier(cue.kind);
    if (emphasisMultiplier !== 1) {
      const targetSet = new Set(targetPhraseIndices);
      nextPhrases = nextPhrases.map((phrase) => (
        targetSet.has(phrase.index)
          ? {
              ...phrase,
              emphasis: Math.min(1.24, phrase.emphasis * emphasisMultiplier),
            }
          : phrase
      ));
    }
    mappings.push({
      cueIndex,
      kind: cue.kind,
      sourcePhraseIndex: cue.phrase_index,
      position: cue.position,
      targetPhraseIndices,
      status: "mapped",
      reason: resolveSpeechCueMappingReason(cue.kind),
    });
  }
  return { phrases: nextPhrases, mappings };
}

export function compileSemanticStepSlots(
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

export function estimatePhraseStepAlignments(
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

export function coalesceSpeechPhrases(
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

export function buildSpeechPhraseGroup(
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

export function resolveGesturePhraseLimit(
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

function appendSplitPhrase(
  target: PerformancePhraseDraft[],
  text: string,
  boundary: PerformancePhraseBoundary,
  sourcePhraseIndex: number,
): void {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return;
  }
  const characters = Array.from(normalizedText);
  if (!characters.some(isEffectiveSpeechCharacter)) {
    appendPhrase(target, normalizedText, boundary, sourcePhraseIndex);
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
    appendPhrase(target, chunk, "none", sourcePhraseIndex);
    chunk = "";
    effectiveLength = 0;
  }
  appendPhrase(target, chunk, boundary, sourcePhraseIndex);
}

function appendPhrase(
  target: PerformancePhraseDraft[],
  text: string,
  boundary: PerformancePhraseBoundary,
  sourcePhraseIndex: number,
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
    const merged = createPhrase(
      previous.text + normalizedText,
      boundary,
      previous.sourcePhraseIndex,
    );
    previous.sourcePhraseIndex = merged.sourcePhraseIndex;
    previous.text = merged.text;
    previous.boundary = merged.boundary;
    previous.weight = merged.weight;
    previous.emphasis = merged.emphasis;
    return;
  }
  target.push(createPhrase(normalizedText, boundary, sourcePhraseIndex));
}

function createPhrase(
  text: string,
  boundary: PerformancePhraseBoundary,
  sourcePhraseIndex: number,
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
    sourcePhraseIndex,
    text,
    boundary,
    weight: effectiveLength + pauseWeight,
    emphasis,
  };
}

function resolveSpeechCueEmphasisMultiplier(
  kind: OutputSegmentSpeechCue["kind"],
): number {
  switch (kind) {
    case "laugh":
      return 1.12;
    case "chuckle":
      return 1.08;
    case "emphasis":
      return 1.08;
    default:
      return 1;
  }
}

function resolveSpeechCueMappingReason(
  kind: OutputSegmentSpeechCue["kind"],
): string {
  switch (kind) {
    case "breath":
    case "sigh":
    case "hesitate":
      return "speech_cue_hesitation_candidate";
    case "laugh":
    case "chuckle":
    case "emphasis":
      return "speech_cue_phrase_emphasis";
  }
}

function resolvePhraseBoundary(character: string): PerformancePhraseBoundary {
  if (/[。！？!?；;\n]/u.test(character)) {
    return "strong";
  }
  if (/[，、,:：…—]/u.test(character)) {
    return "soft";
  }
  return "none";
}

function isEffectiveSpeechCharacter(character: string): boolean {
  return !/[\s.\-]/u.test(character) && resolvePhraseBoundary(character) === "none";
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
