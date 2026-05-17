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
import { couplingStage } from "./stages/couplingStage.js";
import { intensityStage } from "./stages/intensityStage.js";
import { modeResolverStage } from "./stages/modeResolverStage.js";

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
    couplingStage,
    modeResolverStage,
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
  const couplingValues: DynamicAxisValues = { ...state.derivedValues };
  const allAxisValues: DynamicAxisValues = { ...state.allAxisValues };
  const forbiddenAxes = [...state.forbiddenAxes];
  const invalidAxes = [...state.invalidAxes];
  const missingAxes = [...state.missingAxes];
  const maxAxisErrors = state.axisErrorLimit;
  const axisErrorCount = state.axisErrorCount;
  const resolvedMode: SemanticParameterPlan["mode"] = state.resolvedMode;
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
  state.derivedValues = couplingValues;
  state.allAxisValues = allAxisValues;
  state.missingAxes = missingAxes;
  state.forbiddenAxes = forbiddenAxes;
  state.invalidAxes = invalidAxes;
  state.axisErrorCount = axisErrorCount;
  state.axisErrorLimit = maxAxisErrors;
  state.warnings = warnings;
  state.resolvedMode = resolvedMode;
  state.timing = timing;
  state.parameters = parameterResult.parameters;

  return buildSuccessResultFromContext(context, {
    intensityApplied:
      intent.mode === "expressive" && settings.motionIntensityScale !== 1,
  });
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
