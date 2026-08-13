import type {
  SemanticParameterPlan,
} from "../../types/protocol.js";
import { SCHEMA_PARAMETER_PLAN_V3 } from "../../types/protocol.js";
import type {
  CompiledSemanticMotion,
} from "../../types/compiledSemanticMotion.js";
import type {
  CompileOptions,
  CompileResult,
} from "./contracts.js";
import { runCompilePipeline } from "./pipeline.js";
import {
  createModelEngineStageRegistry,
  type ModelEngineStageRegistry,
} from "./registry.js";
import {
  createModelParameterCompileContext,
  type ModelParameterCompileContext,
} from "./modelParameterCompileContext.js";
import { normalizeModelEngineSettings } from "../settings.js";
import { compileParameterSequenceTrackGraph } from "./parameterTrackGraphCompiler.js";
import {
  buildPerformanceScheduleTrace,
  compilePerformanceSchedule,
  type PerformanceSchedule,
} from "./performanceSchedule.js";

export function compileModelParameterPlan(
  semanticMotion: CompiledSemanticMotion,
  options: CompileOptions,
  stageRegistry: ModelEngineStageRegistry = createModelEngineStageRegistry(),
): CompileResult {
  const performanceScheduleResult = compilePerformanceSchedule({
    assistantText: options.assistantText,
    durationMs: semanticMotion.timing.timing.duration_ms,
    sequenceDurationWeights: semanticMotion.kind === "sequence"
      ? semanticMotion.steps.map((step) => step.durationWeight)
      : undefined,
  });
  if (!performanceScheduleResult.ok) {
    return failCompile(
      performanceScheduleResult.reason,
      semanticMotion,
      undefined,
      "performance_schedule",
    );
  }
  const performanceSchedule = performanceScheduleResult.schedule;
  if (semanticMotion.kind === "sequence") {
    return compileMotionSequenceIntent(
      semanticMotion,
      performanceSchedule,
      options,
      stageRegistry,
    );
  }
  return compileModelParameterPose(
    semanticMotion,
    performanceSchedule,
    options,
    stageRegistry,
  );
}

function compileModelParameterPose(
  semanticMotion: Extract<CompiledSemanticMotion, { kind: "pose" }>,
  performanceSchedule: PerformanceSchedule,
  options: CompileOptions,
  stageRegistry: ModelEngineStageRegistry,
): CompileResult {
  let context: ModelParameterCompileContext;
  try {
    context = createModelParameterCompileContext(
      semanticMotion,
      performanceSchedule,
      options,
      normalizeModelEngineSettings(options.settings),
    );
  } catch (error) {
    return failCompile(
      error instanceof Error ? error.message : "model_parameter_context_invalid",
      semanticMotion,
    );
  }
  const modelParameterStages = stageRegistry.resolve(context, "model_parameter");
  const pipelineResult = runCompilePipeline(context, modelParameterStages);
  if (!pipelineResult.ok) {
    return failCompile(
      pipelineResult.reason,
      semanticMotion,
      context,
      pipelineResult.stageId,
    );
  }

  return buildSuccessCompileResult(context);
}

function compileMotionSequenceIntent(
  semanticMotion: Extract<CompiledSemanticMotion, { kind: "sequence" }>,
  performanceSchedule: PerformanceSchedule,
  options: CompileOptions,
  stageRegistry: ModelEngineStageRegistry,
): CompileResult {
  const stepResults = semanticMotion.steps.map((step, index) =>
    compileModelParameterPose(
      {
        ...semanticMotion,
        kind: "pose",
        axes: step.axes,
        diagnostics: step.diagnostics,
      },
      performanceSchedule,
      {
        ...options,
        allowNeutralAxisPose: true,
        speechActive: index === 0 ? options.speechActive : false,
      },
      stageRegistry,
    ),
  );
  const failedStepIndex = stepResults.findIndex((result) => !result.ok || !result.plan);
  if (failedStepIndex >= 0) {
    const failed = stepResults[failedStepIndex];
    return {
      ...failed,
      reason: `motion_sequence_step_failed:${failedStepIndex}:${failed.reason}`,
      feedback: {
        code: `motion_sequence_step_failed:${failedStepIndex}`,
        message: failed.reason,
        fields: failed.feedback?.fields ?? [],
      },
    };
  }

  const plans = stepResults.map((result) => result.plan!);
  const firstPlan = plans[0];
  const profile = options.model.semantic_axis_profile;
  if (!profile) {
    return {
      ok: false,
      plan: null,
      reason: "parameter_track_graph_profile_missing",
      diagnostics: stepResults[0].diagnostics,
      feedback: {
        code: "parameter_track_graph_profile_missing",
        message: "parameter_track_graph_profile_missing",
        fields: [],
      },
    };
  }
  const trackGraph = compileParameterSequenceTrackGraph({
    schedule: performanceSchedule,
    stepPlans: plans,
    profile,
  });
  if (!trackGraph.ok) {
    const failedStepIndex = Math.min(trackGraph.stepIndex, stepResults.length - 1);
    return {
      ok: false,
      plan: null,
      reason: trackGraph.reason,
      diagnostics: stepResults[failedStepIndex].diagnostics,
      feedback: {
        code: trackGraph.code,
        message: trackGraph.reason,
        fields: trackGraph.parameterId ? [trackGraph.parameterId] : [],
      },
    };
  }

  const warnings = Array.from(new Set(
    stepResults.flatMap((result) => result.diagnostics.warnings ?? []),
  ));
  const diagnostics = {
    ...stepResults[0].diagnostics,
    compiledParameterCount: trackGraph.parameters.length,
    compiledParameters: trackGraph.parameters.map((item) => item.parameter_id),
    warnings: [...warnings, ...trackGraph.warnings],
    transformTrace: stepResults[0].diagnostics.transformTrace
      ? {
          ...stepResults[0].diagnostics.transformTrace,
          rawAxisLevels: undefined,
          compiledParameters: trackGraph.parameters.map((item) => item.parameter_id),
          rawMotionSteps: undefined,
          performanceSchedule: buildPerformanceScheduleTrace(performanceSchedule),
          sequenceSteps: stepResults.map((result, index) => ({
            index,
            durationWeight: performanceSchedule.semanticSteps[index].durationWeight,
            resolvedAxes: { ...(result.diagnostics.transformTrace?.resolvedAxes ?? {}) },
            constrainedAxes: { ...(result.diagnostics.transformTrace?.constrainedAxes ?? {}) },
            axisSampling: result.diagnostics.transformTrace?.axisSampling
              ? {
                  ...result.diagnostics.transformTrace.axisSampling,
                  perAxisRandom: {
                    ...result.diagnostics.transformTrace.axisSampling.perAxisRandom,
                  },
                  sampledValues: {
                    ...result.diagnostics.transformTrace.axisSampling.sampledValues,
                  },
                  sampleBounds: Object.fromEntries(
                    Object.entries(
                      result.diagnostics.transformTrace.axisSampling.sampleBounds,
                    ).map(([axisId, bounds]) => [axisId, { ...bounds }]),
                  ),
                }
              : undefined,
          })),
        }
      : undefined,
  };
  return {
    ok: true,
    reason: "",
    diagnostics,
    semanticMotion,
    plan: {
      ...firstPlan,
      timing: trackGraph.timing,
      parameters: trackGraph.parameters,
      diagnostics: {
        ...firstPlan.diagnostics,
        warnings: diagnostics.warnings,
      },
      summary: {
        ...firstPlan.summary,
        parameter_count: trackGraph.parameters.length,
        target_duration_ms: trackGraph.timing.duration_ms,
      },
    },
  };
}

function failCompile(
  reason: string,
  semanticMotion: CompiledSemanticMotion,
  context?: ModelParameterCompileContext,
  failureStage?: string,
): CompileResult {
  const diagnostics = buildModelParameterDiagnostics(semanticMotion, context, failureStage);
  return {
    ok: false,
    plan: null,
    reason,
    diagnostics,
    feedback: {
      code: reason,
      message: reason,
      fields: [],
    },
  };
}

function buildSuccessCompileResult(
  context: ModelParameterCompileContext,
): CompileResult {
  const profile = context.state.profile;
  const semanticMotion = context.semanticMotion;
  const diagnostics = buildModelParameterDiagnostics(semanticMotion, context);
  const plan: SemanticParameterPlan = {
    schema_version: SCHEMA_PARAMETER_PLAN_V3,
    profile_id: profile.profile_id,
    profile_revision: profile.revision,
    model_id: profile.model_id,
    mode: semanticMotion.mode,
    emotion_label: semanticMotion.emotionLabel,
    resource: context.state.expressionResource
      ? {
          kind: "expression",
          resource_id: context.state.expressionResource.resourceId,
          expression_id: context.state.expressionResource.expressionId,
          parameter_ids: [...context.state.expressionResource.parameterIds],
        }
      : undefined,
    timing: semanticMotion.timing.timing,
    parameters: context.state.parameters,
    diagnostics: {
      warnings: [...context.state.warnings],
    },
    summary: {
      axis_count: semanticMotion.axes.length,
      parameter_count: context.state.parameters.length,
      target_duration_ms: semanticMotion.timing.resolvedDurationMs,
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
    semanticMotion,
  };
}

function buildModelParameterDiagnostics(
  semanticMotion: CompiledSemanticMotion,
  context?: ModelParameterCompileContext,
  failureStage?: string,
): CompileResult["diagnostics"] {
  const parameters = context?.state.parameters ?? [];
  const resource = context?.state.expressionResource;
  return {
    ...semanticMotion.diagnostics,
    compiledParameterCount: parameters.length,
    compiledParameters: parameters.map((item) => item.parameter_id),
    failureStage,
    warnings: context
      ? [...context.state.warnings]
      : [...(semanticMotion.diagnostics.warnings ?? [])],
    transformTrace: semanticMotion.diagnostics.transformTrace
      ? {
          ...semanticMotion.diagnostics.transformTrace,
          resolvedResource: resource
            ? {
                resourceId: resource.resourceId,
                resourceType: "expression",
                parameterIds: [...resource.parameterIds],
              }
            : undefined,
          compiledParameters: parameters.map((item) => item.parameter_id),
          performanceSchedule: context
            ? buildPerformanceScheduleTrace(context.performanceSchedule)
            : undefined,
        }
      : undefined,
  };
}
