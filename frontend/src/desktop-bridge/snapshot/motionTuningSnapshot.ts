import type {
  DesktopMotionTuningEffectiveExample,
  DesktopMotionTuningSample,
  DesktopMotionTuningSamplesStatus,
} from "../../types/desktop";
import { cloneSemanticParameterPlan } from "../../model-engine/planParser";
import {
  cloneNumericRecord,
  isObject,
  isPresent,
  normalizeStringArray,
  normalizeText,
} from "../../utils/guards";

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
    const adjustedPlan = cloneSemanticParameterPlan(sample.adjustedPlan);
    if (!adjustedPlan) {
      console.warn("[DesktopBridge] invalid motion tuning sample ignored.", {
        schemaVersion: isObject(sample.adjustedPlan)
          ? normalizeText(sample.adjustedPlan.schema_version)
          : "",
      });
      return null;
    }
    // Treat the embedded adjusted plan as the canonical identity for upgraded samples.
    const modelName = adjustedPlan.model_id;
    const profileId = adjustedPlan.profile_id;
    const profileRevision = Math.round(adjustedPlan.profile_revision);
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
      adjustedPlan,
    } satisfies DesktopMotionTuningSample;
  } catch (error) {
    console.warn("[DesktopBridge] motion tuning sample rejected.", error, sample);
    return null;
  }
}
