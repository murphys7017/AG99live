import type {
  SemanticMotionIntent,
  SemanticParameterPlan,
} from "../../types/protocol.js";
import { SCHEMA_PARAMETER_PLAN_V2 } from "../../types/protocol.js";
import type { CompileOptions, CompileResult } from "./contracts.js";
import { normalizeModelEngineSettings } from "../settings.js";
import { buildBaseCompileDiagnostics, finalizeCompileDiagnostics } from "./diagnostics.js";
import {
  createInitialCompileState,
  type MotionCompileContext,
} from "./compileContext.js";
import { runCompilePipeline } from "./pipeline.js";
import { resolveCompileStages } from "./registry.js";

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
  context.state.warnings.push(...(options.runtimeWarnings ?? []));

  const pipelineResult = runCompilePipeline(context, resolveCompileStages(context));
  if (!pipelineResult.ok) {
    return failCompile(pipelineResult.reason, context);
  }

  return buildSuccessCompileResult(context);
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
    feedback: {
      code: reason,
      message: reason,
      fields: [
        ...context.state.invalidAxes,
        ...context.state.forbiddenAxes,
      ],
    },
  };
}

function buildSuccessCompileResult(
  context: MotionCompileContext,
): CompileResult {
  const { intent, settings, state } = context;
  const semanticProfile = state.profile;
  if (!semanticProfile) {
    return failCompile("semantic_profile_missing", context);
  }
  const timing = state.timing;
  if (!timing) {
    return failCompile("compile_pipeline_missing_required_state", context);
  }

  return buildSuccessResultFromContext(context, {
    intensityApplied: hasAppliedEffectiveIntensity(context),
  });
}

function hasAppliedEffectiveIntensity(
  context: MotionCompileContext,
): boolean {
  if (context.intent.mode !== "expressive") {
    return false;
  }
  if (context.settings.motionIntensityScale !== 1) {
    return true;
  }
  return Object.keys(context.state.controlledValues).some(
    (axisId) => (context.settings.axisIntensityScale[axisId] ?? 1) !== 1,
  );
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

  const diagnostics = finalizeCompileDiagnostics(context, extra);
  const plan: SemanticParameterPlan = {
    schema_version: SCHEMA_PARAMETER_PLAN_V2,
    profile_id: profile.profile_id,
    profile_revision: profile.revision,
    model_id: profile.model_id,
    mode: context.state.resolvedMode,
    emotion_label: context.intent.emotion_label,
    resource: context.state.resource?.resourceType === "expression"
      ? {
          kind: "expression",
          resource_id: context.state.resource.resourceId,
          expression_id: context.state.resource.expressionId ?? "",
          parameter_ids: [...context.state.resource.parameterIds],
        }
      : context.state.resource?.resourceType === "motion" && context.state.resource.motion
        ? {
            kind: "motion",
            resource_id: context.state.resource.resourceId,
            parameter_ids: [...context.state.resource.parameterIds],
            motion: context.state.resource.motion,
          }
        : undefined,
    timing: timing.timing,
    parameters: context.state.parameters,
    diagnostics: {
      warnings: [...context.state.warnings],
    },
    summary: {
      axis_count: Object.keys(context.state.allAxisValues).length,
      parameter_count: context.state.parameters.length,
      target_duration_ms: timing.resolvedDurationMs,
      active_groups: diagnostics.activeGroups,
      skeleton_groups: diagnostics.skeletonGroups,
      missing_skeleton_groups: diagnostics.missingSkeletonGroups,
      max_delta_from_neutral: diagnostics.maxDeltaFromNeutral,
      neutralish_axis_count: diagnostics.neutralishAxisCount,
      expressive_axis_count: diagnostics.expressiveAxisCount,
    },
  };

  return {
    ok: true,
    plan,
    reason: "",
    diagnostics,
  };
}
