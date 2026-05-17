import type {
  SemanticMotionIntent,
  SemanticParameterPlan,
} from "../../types/protocol.js";
import { SCHEMA_PARAMETER_PLAN_V2 } from "../../types/protocol.js";
import type {
  SemanticAxisDefinition,
  SemanticAxisParameterBinding,
} from "../../types/semantic-axis-profile.js";
import type { CompileOptions, CompileResult } from "../contracts.js";
import { normalizeModelEngineSettings } from "../settings.js";
import { resolveMotionTiming } from "../timing.js";
import { buildBaseCompileDiagnostics, finalizeCompileDiagnostics } from "./diagnostics.js";
import {
  createInitialCompileState,
  type DynamicAxisValues,
  type MotionCompileContext,
  type MotionCompileStage,
} from "./compileContext.js";
import { runCompilePipeline } from "./pipeline.js";
import { intentValidatorStage } from "./stages/intentValidator.js";
import { axisResolverStage } from "./stages/axisResolver.js";
import { intensityStage } from "./stages/intensityStage.js";

export function compileMotionIntent(
  intent: SemanticMotionIntent,
  options: CompileOptions,
): CompileResult {
  const normalizedSettings = normalizeModelEngineSettings(options.settings);
  const context: MotionCompileContext = {
    intent,
    options,
    settings: normalizedSettings,
    baseDiagnostics: buildBaseCompileDiagnostics(options, normalizedSettings),
    state: createInitialCompileState(),
  };

  const pipelineResult = runCompilePipeline(context, buildDefaultCompileStages());
  if (!pipelineResult.ok) {
    return failCompile(pipelineResult.reason, context);
  }

  return continueLegacyCompile(context);
}

function buildDefaultCompileStages(): MotionCompileStage[] {
  return [
    intentValidatorStage,
    axisResolverStage,
    intensityStage,
  ];
}

function failCompile(
  reason: string,
  context: MotionCompileContext,
): CompileResult {
  return {
    ok: false,
    plan: null,
    reason,
    diagnostics: finalizeCompileDiagnostics(context),
  };
}

function continueLegacyCompile(
  context: MotionCompileContext,
): CompileResult {
  const { intent, options, settings, baseDiagnostics, state } = context;
  const semanticProfile = state.profile;
  if (!semanticProfile) {
    return failCompile("semantic_profile_missing", context);
  }

  const axisById = state.axisById;
  const roleAxisIds = state.roleAxisIds;
  const warnings = [...state.warnings];
  const controlledValues: DynamicAxisValues = { ...state.controlledValues };
  const forbiddenAxes = [...state.forbiddenAxes];
  const invalidAxes = [...state.invalidAxes];
  const missingAxes = [...state.missingAxes];
  const maxAxisErrors = state.axisErrorLimit;
  const axisErrorCount = state.axisErrorCount;

  let couplingResult: { values: DynamicAxisValues; warnings: string[] };
  try {
    couplingResult = applySemanticCouplings(
      controlledValues,
      semanticProfile,
      axisById,
    );
  } catch (error) {
    return {
      ok: false,
      plan: null,
      reason:
        error instanceof Error ? error.message : "semantic_coupling_failed",
      diagnostics: baseDiagnostics,
    };
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
  const resolvedMode: SemanticParameterPlan["mode"] =
    intent.mode === "idle"
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
    return {
      ok: false,
      plan: null,
      reason: parameterResult.reason,
      diagnostics: {
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
      },
    };
  }

  state.roleAxisIds = roleAxisIds;
  state.controlledValues = controlledValues;
  state.derivedValues = couplingResult.values;
  state.allAxisValues = allAxisValues;
  state.missingAxes = missingAxes;
  state.forbiddenAxes = forbiddenAxes;
  state.invalidAxes = invalidAxes;
  state.axisErrorCount = axisErrorCount;
  state.axisErrorLimit = maxAxisErrors;
  state.warnings = [
    ...warnings,
    ...(idleDeadzone && intent.mode === "expressive"
      ? ["expressive_intent_resolved_to_idle_deadzone"]
      : []),
  ];
  state.resolvedMode = resolvedMode;
  state.timing = timing;
  state.parameters = parameterResult.parameters;

  return buildSuccessResultFromContext(context, {
    intensityApplied:
      intent.mode === "expressive" && settings.motionIntensityScale !== 1,
  });
}

function applySemanticCouplings(
  sourceValues: DynamicAxisValues,
  profile: NonNullable<MotionCompileContext["state"]["profile"]>,
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
      if (baseValues[coupling.target_axis_id] !== undefined) {
        warningSet.add(
          `semantic_coupling_skipped_explicit_target:${coupling.id}:${coupling.target_axis_id}`,
        );
        continue;
      }
      const sourceDelta = sourceValue - sourceAxis.neutral;
      if (Math.abs(sourceDelta) <= coupling.deadzone) {
        continue;
      }
      const direction = coupling.mode === "opposite_direction" ? -1 : 1;
      const rawDelta = sourceDelta * coupling.scale * direction;
      const clampedDelta = Math.max(
        -coupling.max_delta,
        Math.min(coupling.max_delta, rawDelta),
      );
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
  profile: NonNullable<MotionCompileContext["state"]["profile"]>,
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
        return {
          ok: false,
          reason: `duplicate_parameter_binding:${binding.parameter_id}`,
        };
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
  void profile;
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
    return {
      ok: false,
      reason: `binding_input_range_zero:${axis.id}:${binding.parameter_id}`,
    };
  }
  if (
    !Number.isFinite(binding.default_weight)
    || binding.default_weight < 0
    || binding.default_weight > 1
  ) {
    return {
      ok: false,
      reason: `binding_weight_invalid:${axis.id}:${binding.parameter_id}`,
    };
  }
  const ratio = (value - inputMin) / (inputMax - inputMin);
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const effectiveRatio = binding.invert ? 1 - clampedRatio : clampedRatio;
  const targetValue = outputMin + (outputMax - outputMin) * effectiveRatio;
  if (!Number.isFinite(targetValue)) {
    return {
      ok: false,
      reason: `binding_target_not_finite:${axis.id}:${binding.parameter_id}`,
    };
  }
  return { ok: true, targetValue };
}

function buildSuccessResultFromContext(
  context: MotionCompileContext,
  extra: Partial<CompileResult["diagnostics"]> = {},
): CompileResult {
  const profile = context.state.profile;
  const timing = context.state.timing;

  if (!profile || !timing) {
    return failCompile("compile_pipeline_missing_required_state", context);
  }

  const plan: SemanticParameterPlan = {
    schema_version: SCHEMA_PARAMETER_PLAN_V2,
    profile_id: profile.profile_id,
    profile_revision: profile.revision,
    model_id: profile.model_id,
    mode: context.state.resolvedMode,
    emotion_label: context.intent.emotion_label,
    timing: timing.timing,
    parameters: context.state.parameters,
    diagnostics: {
      warnings: [...context.state.warnings],
    },
    summary: {
      axis_count: Object.keys(context.state.allAxisValues).length,
      parameter_count: context.state.parameters.length,
      target_duration_ms: timing.resolvedDurationMs,
    },
  };

  return {
    ok: true,
    plan,
    reason: "",
    diagnostics: finalizeCompileDiagnostics(context, extra),
  };
}
