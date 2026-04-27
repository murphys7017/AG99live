import type {
  SemanticMotionIntent,
  SemanticParameterPlan,
} from "../types/protocol";
import type {
  SemanticAxisDefinition,
  SemanticAxisParameterBinding,
  SemanticAxisProfile,
} from "../types/semantic-axis-profile";
import type { CompileOptions, CompileResult } from "./contracts";
import {
  normalizeModelEngineSettings,
} from "./settings";
import { resolveMotionTiming } from "./timing";

type DynamicAxisValues = Record<string, number>;
const MAX_SEMANTIC_AXIS_ERROR_RATE = 0.30;

export function compileMotionIntent(
  intent: SemanticMotionIntent,
  options: CompileOptions,
): CompileResult {
  const normalizedSettings = normalizeModelEngineSettings(options.settings);
  const baseDiagnostics = {
    usedFallbackLibrary: false,
    supplementaryCount: 0,
    timingSource: "default" as const,
    resolvedMode: "idle" as const,
    source: options.source,
    intensityApplied: false,
    motionIntensityScale: normalizedSettings.motionIntensityScale,
    axisIntensityScale: { ...normalizedSettings.axisIntensityScale },
    warnings: [] as string[],
  };

  const profile = options.model.semantic_axis_profile;
  const profileFailure = validateProfileForIntent(intent, profile);
  if (profileFailure) {
    return {
      ok: false,
      plan: null,
      reason: profileFailure,
      diagnostics: baseDiagnostics,
    };
  }

  const semanticProfile = profile as SemanticAxisProfile;
  const axisById = new Map(semanticProfile.axes.map((axis) => [axis.id, axis]));
  const roleAxisIds = {
    primaryAxes: semanticProfile.axes.filter((axis) => axis.control_role === "primary").map((axis) => axis.id),
    hintAxes: semanticProfile.axes.filter((axis) => axis.control_role === "hint").map((axis) => axis.id),
    derivedAxes: semanticProfile.axes.filter((axis) => axis.control_role === "derived").map((axis) => axis.id),
    runtimeAxes: semanticProfile.axes
      .filter((axis) => axis.control_role === "runtime" || axis.control_role === "ambient" || axis.control_role === "debug")
      .map((axis) => axis.id),
  };
  const allowedLlmRoles = new Set(["primary", "hint"]);
  const controlledValues: DynamicAxisValues = {};
  const warnings: string[] = [];
  const forbiddenAxes: string[] = [];
  const invalidAxes: string[] = [];
  const maxAxisErrors = Math.max(
    0,
    Math.floor((roleAxisIds.primaryAxes.length + roleAxisIds.hintAxes.length) * MAX_SEMANTIC_AXIS_ERROR_RATE),
  );
  for (const [axisId, axisValuePayload] of Object.entries(intent.axes)) {
    const axis = axisById.get(axisId);
    if (!axis) {
      invalidAxes.push(axisId);
      warnings.push(`semantic_axis_ignored_unknown:${axisId}`);
      continue;
    }
    if (!allowedLlmRoles.has(axis.control_role)) {
      forbiddenAxes.push(axisId);
      warnings.push(`semantic_axis_ignored_forbidden_role:${axisId}:${axis.control_role}`);
      continue;
    }
    const value = axisValuePayload.value as unknown;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      invalidAxes.push(axisId);
      warnings.push(`semantic_axis_ignored_not_number:${axisId}`);
      continue;
    }
    const rangeResult = normalizeSemanticAxisValue(axis, value);
    if (rangeResult.warning) {
      warnings.push(rangeResult.warning);
      console.warn("[ModelEngine] semantic axis value clamped:", rangeResult.warning, {
        axisId,
        inputValue: value,
        outputValue: rangeResult.value,
      });
    }
    const intensityResult = applySemanticIntensity(
      rangeResult.value,
      axis,
      intent.mode,
      normalizedSettings.motionIntensityScale,
    );
    controlledValues[axisId] = intensityResult.value;
    if (intensityResult.warning) {
      warnings.push(intensityResult.warning);
      console.warn("[ModelEngine] semantic intensity adjusted:", intensityResult.warning, {
        axisId,
        inputValue: value,
        outputValue: intensityResult.value,
      });
    }
  }
  const missingAxes: string[] = [];
  for (const axis of semanticProfile.axes) {
    if (axis.control_role !== "primary" || axis.id in controlledValues) {
      continue;
    }
    missingAxes.push(axis.id);
    warnings.push(`semantic_primary_axis_missing_ignored:${axis.id}`);
  }

  const axisErrorCount = invalidAxes.length + forbiddenAxes.length;
  if (axisErrorCount > maxAxisErrors) {
    return failSemanticCompile(`semantic_axis_error_rate_exceeded:${axisErrorCount}/${roleAxisIds.primaryAxes.length + roleAxisIds.hintAxes.length}`, {
      ...baseDiagnostics,
      ...roleAxisIds,
      warnings,
      missingAxes,
      forbiddenAxes,
      invalidAxes,
      axisErrorCount,
      axisErrorLimit: maxAxisErrors,
    });
  }
  if (axisErrorCount > 0) {
    console.warn("[ModelEngine] semantic axes ignored within error threshold.", {
      invalidAxes,
      missingAxes,
      forbiddenAxes,
      axisErrorCount,
      axisErrorLimit: maxAxisErrors,
    });
  }

  let couplingResult: { values: DynamicAxisValues; warnings: string[] };
  try {
    couplingResult = applySemanticCouplings(controlledValues, semanticProfile, axisById);
  } catch (error) {
    return failSemanticCompile(
      error instanceof Error ? error.message : "semantic_coupling_failed",
      baseDiagnostics,
    );
  }
  if (couplingResult.warnings.length > 0) {
    warnings.push(...couplingResult.warnings);
    console.warn("[ModelEngine] semantic coupling adjusted:", couplingResult.warnings);
  }
  const allAxisValues = {
    ...controlledValues,
    ...couplingResult.values,
  };

  const idleDeadzone = isSemanticIdleDeadzone(allAxisValues, axisById);
  const resolvedMode: SemanticParameterPlan["mode"] = intent.mode === "idle"
    ? "idle"
    : idleDeadzone
      ? "idle"
      : "expressive";
  const timing = resolveMotionTiming({
    mode: resolvedMode,
    durationHintMs: intent.duration_hint_ms ?? null,
    targetDurationMs: options.targetDurationMs ?? null,
  });

  const parameterResult = buildSemanticPlanParameters(
    allAxisValues,
    semanticProfile,
    axisById,
    new Set(Object.keys(controlledValues)),
  );
  if (!parameterResult.ok) {
    return failSemanticCompile(parameterResult.reason, {
      ...baseDiagnostics,
      timingSource: timing.timingSource,
      resolvedMode,
      warnings,
      ...roleAxisIds,
      missingAxes,
      forbiddenAxes,
      invalidAxes,
      axisErrorCount,
      axisErrorLimit: maxAxisErrors,
    });
  }

  const intensityApplied = intent.mode === "expressive" && normalizedSettings.motionIntensityScale !== 1;
  const plan: SemanticParameterPlan = {
    schema_version: "engine.parameter_plan.v2",
    profile_id: semanticProfile.profile_id,
    profile_revision: semanticProfile.revision,
    model_id: semanticProfile.model_id,
    mode: resolvedMode,
    emotion_label: intent.emotion_label,
    timing: timing.timing,
    parameters: parameterResult.parameters,
    diagnostics: {
      warnings: [
        ...warnings,
        ...(idleDeadzone && intent.mode === "expressive"
          ? ["expressive_intent_resolved_to_idle_deadzone"]
          : []),
      ],
    },
    summary: {
      axis_count: Object.keys(allAxisValues).length,
      parameter_count: parameterResult.parameters.length,
      target_duration_ms: timing.resolvedDurationMs,
    },
  };

  return {
    ok: true,
    plan,
    reason: "",
    diagnostics: {
      ...baseDiagnostics,
      timingSource: timing.timingSource,
      resolvedMode,
      intensityApplied,
      supplementaryCount: parameterResult.parameters.length,
      warnings: plan.diagnostics?.warnings ?? [],
      ...roleAxisIds,
      missingAxes,
      forbiddenAxes,
      invalidAxes,
      axisErrorCount,
      axisErrorLimit: maxAxisErrors,
      compiledParameters: parameterResult.parameters.map((item) => item.parameter_id),
    },
  };
}

function failSemanticCompile(
  reason: string,
  diagnostics: CompileResult["diagnostics"],
): CompileResult {
  return {
    ok: false,
    plan: null,
    reason,
    diagnostics,
  };
}

function validateProfileForIntent(
  intent: SemanticMotionIntent,
  profile: SemanticAxisProfile | null | undefined,
): string {
  if (!profile) {
    return "semantic_profile_missing";
  }
  if (profile.profile_id !== intent.profile_id) {
    return `semantic_profile_id_mismatch:${intent.profile_id}`;
  }
  if (profile.model_id !== intent.model_id) {
    return `semantic_profile_model_mismatch:${intent.model_id}`;
  }
  if (profile.revision !== intent.profile_revision) {
    return `semantic_profile_revision_mismatch:${intent.profile_revision}:${profile.revision}`;
  }
  if (!intent.emotion_label.trim()) {
    return "emotion_label_empty";
  }
  if (!Object.keys(intent.axes).length) {
    return "semantic_intent_axes_empty";
  }
  return "";
}

function normalizeSemanticAxisValue(
  axis: SemanticAxisDefinition,
  value: number,
): { value: number; warning: string } {
  const [minValue, maxValue] = axis.value_range;
  if (value < minValue || value > maxValue) {
    const clampedValue = value < minValue ? minValue : maxValue;
    return {
      value: clampedValue,
      warning: `semantic_axis_value_clamped:${axis.id}:${value}->${clampedValue}`,
    };
  }
  return { value, warning: "" };
}

function applySemanticIntensity(
  value: number,
  axis: SemanticAxisDefinition,
  mode: SemanticMotionIntent["mode"],
  motionIntensityScale: number,
): { value: number; warning: string } {
  if (mode !== "expressive") {
    return { value, warning: "" };
  }
  const [minValue, maxValue] = axis.value_range;
  const scaled = axis.neutral + (value - axis.neutral) * motionIntensityScale;
  if (scaled < minValue || scaled > maxValue) {
    const clampedValue = Math.max(minValue, Math.min(maxValue, scaled));
    return {
      value: clampedValue,
      warning: `semantic_intensity_clamped:${axis.id}:${scaled}->${clampedValue}`,
    };
  }
  return { value: scaled, warning: "" };
}

function applySemanticCouplings(
  sourceValues: DynamicAxisValues,
  profile: SemanticAxisProfile,
  axisById: Map<string, SemanticAxisDefinition>,
): { values: DynamicAxisValues; warnings: string[] } {
  const baseValues: DynamicAxisValues = { ...sourceValues };
  let resolvedValues: DynamicAxisValues = { ...baseValues };
  const result: DynamicAxisValues = {};
  const warningSet = new Set<string>();
  const maxPasses = Math.max(1, profile.couplings.length + 1);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const nextResolvedValues: DynamicAxisValues = { ...baseValues };
    const nextDerivedValues: DynamicAxisValues = {};
    for (const coupling of profile.couplings) {
      const sourceAxis = axisById.get(coupling.source_axis_id);
      const targetAxis = axisById.get(coupling.target_axis_id);
      if (!sourceAxis || !targetAxis) {
        throw new Error(`semantic_coupling_axis_missing:${coupling.id}`);
      }
      const sourceValue = resolvedValues[coupling.source_axis_id];
      if (sourceValue === undefined) {
        continue;
      }
      const sourceDelta = sourceValue - sourceAxis.neutral;
      if (Math.abs(sourceDelta) <= coupling.deadzone) {
        continue;
      }
      const direction = coupling.mode === "opposite_direction" ? -1 : 1;
      const rawDelta = sourceDelta * coupling.scale * direction;
      const clampedDelta = Math.max(-coupling.max_delta, Math.min(coupling.max_delta, rawDelta));
      const [minValue, maxValue] = targetAxis.value_range;
      const targetValue = targetAxis.neutral + clampedDelta;
      const clampedTargetValue = Math.max(minValue, Math.min(maxValue, targetValue));
      if (clampedTargetValue !== targetValue) {
        warningSet.add(
          `semantic_coupling_clamped:${coupling.id}:${targetValue}->${clampedTargetValue}`,
        );
      }
      nextResolvedValues[coupling.target_axis_id] = clampedTargetValue;
      nextDerivedValues[coupling.target_axis_id] = clampedTargetValue;
    }
    const changed = !dynamicAxisValuesEqual(resolvedValues, nextResolvedValues);
    if (!changed) {
      return { values: nextDerivedValues, warnings: [...warningSet] };
    }
    resolvedValues = nextResolvedValues;
    Object.keys(result).forEach((axisId) => {
      delete result[axisId];
    });
    Object.assign(result, nextDerivedValues);
  }
  throw new Error("semantic_coupling_resolution_exhausted");
}

function dynamicAxisValuesEqual(
  left: DynamicAxisValues,
  right: DynamicAxisValues,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue === undefined || rightValue === undefined) {
      if (leftValue !== rightValue) {
        return false;
      }
      continue;
    }
    if (Math.abs(leftValue - rightValue) > 1e-6) {
      return false;
    }
  }
  return true;
}

function isSemanticIdleDeadzone(
  axisValues: DynamicAxisValues,
  axisById: Map<string, SemanticAxisDefinition>,
): boolean {
  for (const [axisId, value] of Object.entries(axisValues)) {
    const axis = axisById.get(axisId);
    if (!axis) {
      return false;
    }
    const [minSoft, maxSoft] = axis.soft_range;
    if (value < minSoft || value > maxSoft) {
      return false;
    }
  }
  return true;
}

function buildSemanticPlanParameters(
  axisValues: DynamicAxisValues,
  profile: SemanticAxisProfile,
  axisById: Map<string, SemanticAxisDefinition>,
  controlledAxisIds: Set<string>,
):
  | { ok: true; parameters: SemanticParameterPlan["parameters"] }
  | { ok: false; reason: string } {
  const parameters: SemanticParameterPlan["parameters"] = [];
  const seenParameterIds = new Set<string>();
  for (const [axisId, value] of Object.entries(axisValues)) {
    const axis = axisById.get(axisId);
    if (!axis) {
      return { ok: false, reason: `unknown_axis:${axisId}` };
    }
    if (!axis.parameter_bindings.length) {
      return { ok: false, reason: `axis_has_no_parameter_binding:${axisId}` };
    }
    for (const binding of axis.parameter_bindings) {
      const parameter = mapSemanticBindingValue(axis, binding, value);
      if (!parameter.ok) {
        return parameter;
      }
      if (seenParameterIds.has(binding.parameter_id)) {
        return { ok: false, reason: `duplicate_parameter_binding:${binding.parameter_id}` };
      }
      seenParameterIds.add(binding.parameter_id);
      parameters.push({
        axis_id: axisId,
        parameter_id: binding.parameter_id,
        target_value: parameter.targetValue,
        weight: binding.default_weight,
        input_value: value,
        source: controlledAxisIds.has(axisId) ? "semantic_axis" : "coupling",
      });
    }
  }
  if (!parameters.length) {
    return { ok: false, reason: "semantic_plan_parameters_empty" };
  }
  return { ok: true, parameters };
}

function mapSemanticBindingValue(
  axis: SemanticAxisDefinition,
  binding: SemanticAxisParameterBinding,
  value: number,
):
  | { ok: true; targetValue: number }
  | { ok: false; reason: string } {
  const [inputMin, inputMax] = binding.input_range;
  const [outputMin, outputMax] = binding.output_range;
  if (inputMax === inputMin) {
    return { ok: false, reason: `binding_input_range_zero:${axis.id}:${binding.parameter_id}` };
  }
  if (!Number.isFinite(binding.default_weight) || binding.default_weight < 0 || binding.default_weight > 1) {
    return { ok: false, reason: `binding_weight_invalid:${axis.id}:${binding.parameter_id}` };
  }
  const ratio = (value - inputMin) / (inputMax - inputMin);
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const effectiveRatio = binding.invert ? 1 - clampedRatio : clampedRatio;
  const targetValue = outputMin + (outputMax - outputMin) * effectiveRatio;
  if (!Number.isFinite(targetValue)) {
    return { ok: false, reason: `binding_target_not_finite:${axis.id}:${binding.parameter_id}` };
  }
  return { ok: true, targetValue };
}
