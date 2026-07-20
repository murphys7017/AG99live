import type {
  DesktopMotionTuningEffectiveExample,
  DesktopMotionTuningSample,
  DesktopMotionTuningSamplesStatus,
} from "../../types/desktop.js";
import { cloneCompiledSemanticMotion } from "../../model-engine/compiler/compiledSemanticMotionParser.js";
import {
  cloneNumericRecord,
  isObject,
  isPresent,
  normalizeStringArray,
  normalizeText,
} from "../../utils/guards.js";

export function normalizeMotionTuningSamplesStatus(
  value: unknown,
): DesktopMotionTuningSamplesStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      rootError: "",
      loadError: "",
      diagnostics: [],
      effectiveExamples: [],
    };
  }
  const candidate = value as {
    rootError?: unknown;
    loadError?: unknown;
    diagnostics?: unknown;
    effectiveExamples?: unknown;
  };
  return {
    rootError: normalizeText(candidate.rootError),
    loadError: normalizeText(candidate.loadError),
    diagnostics: Array.isArray(candidate.diagnostics)
      ? candidate.diagnostics.map((item) => normalizeText(item)).filter(Boolean)
      : [],
    effectiveExamples: Array.isArray(candidate.effectiveExamples)
      ? candidate.effectiveExamples.map(cloneMotionTuningEffectiveExample).filter(isPresent)
      : [],
  };
}

export function normalizeMotionTuningSamples(
  samples: unknown,
): DesktopMotionTuningSample[] {
  if (!Array.isArray(samples)) {
    return [];
  }
  return samples.map(cloneMotionTuningSample).filter(isPresent);
}

export function cloneMotionTuningEffectiveExample(
  example: unknown,
): DesktopMotionTuningEffectiveExample | null {
  if (!isObject(example) || !isObject(example.output)) {
    return null;
  }
  return {
    input: normalizeText(example.input),
    output: {
      emotion: normalizeText(example.output.emotion),
      mode: normalizeText(example.output.mode),
      durationMs: typeof example.output.durationMs === "number" && Number.isFinite(example.output.durationMs)
        ? example.output.durationMs
        : null,
      axes: cloneNumericRecord(example.output.axes),
    },
    source: normalizeText(example.source),
    tags: normalizeStringArray(example.tags) ?? [],
  };
}

function cloneMotionTuningSample(
  sample: unknown,
): DesktopMotionTuningSample | null {
  try {
    if (!isObject(sample)) {
      return null;
    }
    const compiledSemanticMotion = cloneCompiledSemanticMotion(sample.compiledSemanticMotion);
    if (!compiledSemanticMotion) {
      console.warn("[DesktopBridge] invalid motion tuning sample ignored.", {
        schemaVersion: isObject(sample.compiledSemanticMotion)
          ? normalizeText(sample.compiledSemanticMotion.schemaVersion)
          : "",
      });
      return null;
    }
    const modelName = compiledSemanticMotion.modelId;
    const profileId = compiledSemanticMotion.profileId;
    const profileRevision = Math.round(compiledSemanticMotion.profileRevision);
    return {
      ...(sample as unknown as DesktopMotionTuningSample),
      modelName,
      tags: Array.isArray(sample.tags)
        ? sample.tags.map((item) => normalizeText(item)).filter(Boolean)
        : [],
      profileId,
      profileRevision,
      enabledForLlmReference: Boolean(sample.enabledForLlmReference),
      originalAxes: cloneNumericRecord(sample.originalAxes),
      adjustedAxes: cloneNumericRecord(sample.adjustedAxes),
      compiledSemanticMotion,
    } satisfies DesktopMotionTuningSample;
  } catch (error) {
    console.warn("[DesktopBridge] motion tuning sample rejected.", error, sample);
    return null;
  }
}
