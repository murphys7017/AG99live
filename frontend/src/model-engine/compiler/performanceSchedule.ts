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
}

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
}): PerformanceSchedule {
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
  return {
    durationMs: options.durationMs,
    textSource: text ? "assistant_text" : "duration_only",
    phrases,
  };
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
