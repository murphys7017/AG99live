import { modelParameterStages } from "./stages.js";
import type {
  SemanticParameterPlan,
} from "../../types/protocol.js";
import { SCHEMA_PARAMETER_PLAN_V3 } from "../../types/protocol.js";
import type {
  CompiledSemanticAxis,
  CompiledSemanticMotion,
} from "../../types/compiledSemanticMotion.js";
import type {
  CompileOptions,
  CompileResult,
} from "./contracts.js";
import { runCompilePipeline } from "./pipeline.js";
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
import { performanceGovernor } from "./performanceGovernor.js";
import { MOTION_PHASE_JITTER_RATIO } from "../normalize.js";

export function compileModelParameterPlan(
  semanticMotion: CompiledSemanticMotion,
  options: CompileOptions,
): CompileResult {
  if (semanticMotion.phases) return compilePhaseParameterPlan(semanticMotion as Extract<CompiledSemanticMotion, { kind: "pose" }> & { phases: NonNullable<CompiledSemanticMotion["phases"]> }, options);
  const governed = performanceGovernor.govern(semanticMotion, options.continuityEnvelope ?? null);
  semanticMotion = {
    ...governed.motion,
    diagnostics: {
      ...governed.motion.diagnostics,
      performanceGovernor: {
        version: governed.diagnostics.version,
        budget: { ...governed.diagnostics.budget },
        truncatedAxisIds: [...governed.diagnostics.truncatedAxisIds],
        truncatedStepCount: governed.diagnostics.truncatedStepCount,
        repeatedDirectionAxisIds: [...governed.diagnostics.repeatedDirectionAxisIds],
        warnings: [...governed.diagnostics.warnings],
      },
    },
  };
  const performanceScheduleResult = compilePerformanceSchedule({
    assistantText: options.assistantText,
    speechCues: options.speechCues,
    durationMs: semanticMotion.timing.timing.duration_ms,
    intentTags: semanticMotion.intentTags,
    sequenceSteps: semanticMotion.kind === "sequence"
      ? semanticMotion.steps
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
    );
  }
  return compileModelParameterPose(
    semanticMotion,
    performanceSchedule,
    options,
  );
}

function compilePhaseParameterPlan(
  semanticMotion: Extract<CompiledSemanticMotion, { kind: "pose" }> & { phases: NonNullable<CompiledSemanticMotion["phases"]> },
  options: CompileOptions,
): CompileResult {
  const profile = options.model.semantic_axis_profile;
  if (!profile) return failCompile("model_parameter_semantic_profile_mismatch", semanticMotion);
  const catalog = new Map<string, { axisId: string; binding: (typeof profile.axes)[number]["parameter_bindings"][number]; dynamics: (typeof profile.axes)[number]["dynamics"] }>();
  for (const axis of profile.axes) for (const binding of axis.parameter_bindings) catalog.set(binding.parameter_id, { axisId: axis.id, binding, dynamics: axis.dynamics });
  const phaseNames = ["enter", "hold", "release", "settle"] as const;
  const offsets: number[] = []; let offset = 0;
  for (const name of phaseNames) { offsets.push(offset); offset += semanticMotion.phases[name].duration_ms; }
  const parameters: SemanticParameterPlan["parameters"] = [];
  for (const parameterId of new Set(phaseNames.flatMap((name) => Object.keys(semanticMotion.phases[name].parameters)))) {
    const entry = catalog.get(parameterId);
    if (!entry) return failCompile(`motion_phases_unknown_parameter:${parameterId}`, semanticMotion);
    const keyframes = phaseNames.map((name, index) => {
      const sample = semanticMotion.phases[name].parameters[parameterId]
        ?? semanticMotion.phases[phaseNames[Math.max(0, index - 1)]].parameters[parameterId]
        ?? { median: 0, observed_min: 0, observed_max: 0 };
      if (sample.observed_min < entry.binding.output_range[0] || sample.observed_max > entry.binding.output_range[1]) {
        return { at_ms: offsets[index], transition_ms: 0, target_value: Number.NaN };
      }
      const span = Math.max(0, sample.observed_max - sample.observed_min);
      const seed = hashPhase(`${parameterId}:${name}:${options.samplingIdentity?.messageId ?? ""}`);
      const raw = sample.median + (seed * 2 - 1) * span * MOTION_PHASE_JITTER_RATIO;
      const min = entry.binding.output_range[0]; const max = entry.binding.output_range[1];
      return { at_ms: offsets[index], transition_ms: Math.max(1, Math.round(semanticMotion.phases[name].duration_ms * 0.2)), target_value: Math.max(min, Math.min(max, raw)) };
    });
    const last = keyframes[keyframes.length - 1];
    if (keyframes.some((frame) => !Number.isFinite(frame.target_value))) return failCompile(`motion_phases_parameter_out_of_range:${parameterId}`, semanticMotion);
    const neutral = Math.max(entry.binding.output_range[0], Math.min(entry.binding.output_range[1], 0));
    parameters.push({ axis_id: entry.axisId, parameter_id: parameterId, activation_at_ms: 0, target_value: last.target_value, neutral_target_value: neutral, weight: entry.binding.default_weight, source: "manual", keyframes, dynamics: { max_velocity: entry.dynamics.max_velocity, max_acceleration: entry.dynamics.max_acceleration, max_speech_offset: 0, response: { kind: "bounded" } } });
  }
  const plan: SemanticParameterPlan = { schema_version: SCHEMA_PARAMETER_PLAN_V3, profile_id: profile.profile_id, profile_revision: profile.revision, model_id: profile.model_id, mode: semanticMotion.mode, emotion_label: semanticMotion.emotionLabel, timing: semanticMotion.timing.timing, parameters, diagnostics: { warnings: ["motion_phases_parameter_plan_compiled"] }, summary: { axis_count: 0, parameter_count: parameters.length, target_duration_ms: semanticMotion.timing.resolvedDurationMs } };
  return { ok: true, plan, reason: "", diagnostics: { ...semanticMotion.diagnostics, compiledParameterCount: parameters.length, compiledParameters: parameters.map((item) => item.parameter_id) }, semanticMotion };
}

function hashPhase(value: string): number { let hash = 2166136261; for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return (hash >>> 0) / 4294967295; }

function compileModelParameterPose(
  semanticMotion: Extract<CompiledSemanticMotion, { kind: "pose" }>,
  performanceSchedule: PerformanceSchedule,
  options: CompileOptions,
  semanticSequenceStepAxes?: readonly (readonly CompiledSemanticAxis[])[],
): CompileResult {
  let context: ModelParameterCompileContext;
  try {
    context = createModelParameterCompileContext(
      semanticMotion,
      performanceSchedule,
      options,
      normalizeModelEngineSettings(options.settings),
      semanticSequenceStepAxes,
    );
  } catch (error) {
    return failCompile(
      error instanceof Error ? error.message : "model_parameter_context_invalid",
      semanticMotion,
    );
  }
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
): CompileResult {
  const semanticSequenceStepAxes = semanticMotion.steps.map((step) => step.axes);
  const stepResults = semanticMotion.steps.map((step, index) => {
    // A sequence owns one speech modulation track for its shared Schedule;
    // later steps contribute only semantic parameter targets.
    const ownsSpeechPose = index === 0;
    return compileModelParameterPose(
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
        speechActive: ownsSpeechPose && options.speechActive,
      },
      ownsSpeechPose ? semanticSequenceStepAxes : undefined,
    );
  });
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
    [
      ...(semanticMotion.diagnostics.warnings ?? []),
      ...stepResults.flatMap((result) => result.diagnostics.warnings ?? []),
    ],
  ));
  const diagnostics = {
    ...stepResults[0].diagnostics,
    compiledParameterCount: trackGraph.parameters.length,
    compiledParameters: trackGraph.parameters.map((item) => item.parameter_id),
    warnings: [...warnings, ...trackGraph.warnings],
    performanceGovernor: semanticMotion.diagnostics.performanceGovernor,
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
                  groupRandom: {
                    ...result.diagnostics.transformTrace.axisSampling.groupRandom,
                  },
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
    performanceGovernor: semanticMotion.diagnostics.performanceGovernor,
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
