import type {
  DesktopMotionTuningEffectiveExample,
  DesktopMotionTuningSample,
  DesktopMotionTuningSamplesStatus,
} from "../../types/desktop.js";
import { cloneCompiledSemanticMotion } from "../../types/compiledSemanticMotion.js";
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
    category: normalizeText(example.category),
    input: normalizeText(example.input),
    output: {
      intentTags: normalizeStringArray(example.output.intentTags) ?? [],
      durationHintMs: typeof example.output.durationHintMs === "number"
        && Number.isFinite(example.output.durationHintMs)
        ? example.output.durationHintMs
        : null,
      axisLevels: Object.keys(cloneNumericRecord(example.output.axisLevels)).length
        ? cloneNumericRecord(example.output.axisLevels)
        : undefined,
      motionSteps: cloneMotionTuningMotionSteps(example.output.motionSteps),
      expressionResourceId: normalizeText(example.output.expressionResourceId) || undefined,
      motionResourceId: normalizeText(example.output.motionResourceId) || undefined,
    },
    source: normalizeText(example.source),
    tags: normalizeStringArray(example.tags) ?? [],
  };
}

function cloneMotionTuningMotionSteps(
  value: unknown,
): DesktopMotionTuningEffectiveExample["output"]["motionSteps"] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    return undefined;
  }
  const steps = value.map((item) => {
    if (!isObject(item)) {
      return null;
    }
    const durationWeight = item.durationWeight;
    const axisLevels = cloneNumericRecord(item.axisLevels);
    if (
      !Object.keys(axisLevels).length
      || typeof durationWeight !== "number"
      || !Number.isInteger(durationWeight)
      || durationWeight < 1
      || durationWeight > 3
    ) {
      return null;
    }
    return { axisLevels, durationWeight };
  });
  return steps.every((step) => step !== null)
    ? steps as NonNullable<DesktopMotionTuningEffectiveExample["output"]["motionSteps"]>
    : undefined;
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
      adjustedAxes: sample.adjustedAxes === undefined
        ? undefined
        : cloneNumericRecord(sample.adjustedAxes),
      compiledSemanticMotion,
    } satisfies DesktopMotionTuningSample;
  } catch (error) {
    console.warn("[DesktopBridge] motion tuning sample rejected.", error, sample);
    return null;
  }
}
