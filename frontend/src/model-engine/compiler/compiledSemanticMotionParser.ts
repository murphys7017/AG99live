import { cloneJson } from "../../utils/cloneJson.js";
import type {
  CompileDiagnostics,
  CompiledSemanticAxis,
  CompiledSemanticMotion,
  CompiledSemanticMotionStep,
  MotionTimingResolution,
} from "./contracts.js";

export function cloneCompiledSemanticMotion(value: unknown): CompiledSemanticMotion | null {
  if (!isObject(value)
    || value.schemaVersion !== "engine.compiled_semantic_motion.v1"
    || !isNonEmptyString(value.profileId)
    || !isPositiveInteger(value.profileRevision)
    || !isNonEmptyString(value.modelId)
    || (value.mode !== "idle" && value.mode !== "expressive")
    || !isNonEmptyString(value.emotionLabel)
    || !isIntentTags(value.intentTags)
    || (value.performanceCurveHint !== undefined
      && !isPerformanceCurveHint(value.performanceCurveHint))
    || !isMotionTimingResolution(value.timing)
    || !isCompileDiagnostics(value.diagnostics)
    || (value.expressionResourceId !== undefined && !isNonEmptyString(value.expressionResourceId))
    || (value.motionResourceId !== undefined && !isNonEmptyString(value.motionResourceId))
    || (value.expressionResourceId !== undefined && value.motionResourceId !== undefined)
  ) {
    return null;
  }

  if (value.kind === "pose") {
    if (!isCompiledAxes(value.axes, value.diagnostics.speechActive === true)) {
      return null;
    }
  } else if (value.kind === "sequence") {
    if (!Array.isArray(value.steps) || value.steps.length === 0 || !value.steps.every(isCompiledStep)) {
      return null;
    }
  } else {
    return null;
  }

  return cloneJson(value) as unknown as CompiledSemanticMotion;
}

function isCompiledStep(value: unknown): value is CompiledSemanticMotionStep {
  if (!isObject(value)
    || !isPositiveFiniteNumber(value.durationWeight)
    || !isCompileDiagnostics(value.diagnostics)
  ) {
    return false;
  }
  return isCompiledAxes(value.axes, value.diagnostics.speechActive === true);
}

function isCompiledAxes(
  value: unknown,
  allowEmpty: boolean = false,
): value is CompiledSemanticAxis[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    return false;
  }
  const axisIds = new Set<string>();
  for (const axis of value) {
    if (!isObject(axis)
      || !isNonEmptyString(axis.axisId)
      || axisIds.has(axis.axisId)
      || !isFiniteNumber(axis.value)
      || !isFiniteNumber(axis.neutralValue)
      || (axis.source !== "semantic_axis" && axis.source !== "coupling")
    ) {
      return false;
    }
    axisIds.add(axis.axisId);
  }
  return true;
}

function isMotionTimingResolution(value: unknown): value is MotionTimingResolution {
  const timing = isObject(value) && isObject(value.timing) ? value.timing : null;
  if (!isObject(value)
    || !timing
    || !isPositiveFiniteNumber(value.resolvedDurationMs)
    || (value.timingSource !== "hint"
      && value.timingSource !== "audio_sync"
      && value.timingSource !== "default")
  ) {
    return false;
  }
  return ["duration_ms", "blend_in_ms", "hold_ms", "blend_out_ms"].every(
    (field) => isNonNegativeFiniteNumber(timing[field]),
  );
}

function isCompileDiagnostics(value: unknown): value is CompileDiagnostics {
  return isObject(value)
    && typeof value.usedActionLibrary === "boolean"
    && isNonNegativeInteger(value.compiledParameterCount)
    && (value.timingSource === "hint"
      || value.timingSource === "audio_sync"
      || value.timingSource === "default")
    && (value.resolvedMode === "idle" || value.resolvedMode === "expressive")
    && (value.speechActive === undefined || typeof value.speechActive === "boolean")
    && typeof value.intensityApplied === "boolean"
    && isFiniteNumber(value.motionIntensityScale);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIntentTags(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 6
    && value.every(isNonEmptyString)
    && new Set(value).size === value.length;
}

function isPerformanceCurveHint(value: unknown): boolean {
  return isObject(value)
    && value.schema_version === "ag99.performance_curve_hint.v1"
    && ["default", "quick_in_hold_soft_out", "slow_in_hold_quick_out", "pulse_then_settle", "soft_breathe"].includes(String(value.curve_family))
    && ["instant", "quick", "soft", "slow"].includes(String(value.entry))
    && ["short", "steady", "long", "breathing"].includes(String(value.hold))
    && ["quick", "soft", "slow"].includes(String(value.exit))
    && ["none", "early", "middle", "late", "punctuated"].includes(String(value.emphasis))
    && ["low", "medium", "high", "teasing", "calm"].includes(String(value.energy));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}
