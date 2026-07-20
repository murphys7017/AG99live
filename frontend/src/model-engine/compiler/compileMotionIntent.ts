import type {
  DirectParameterPlanTiming,
  NormalizedSemanticMotionIntentV4,
  SemanticMotionIntent,
  SemanticParameterPlanEntry,
  SemanticParameterPlan,
} from "../../types/protocol.js";
import { SCHEMA_PARAMETER_PLAN_V2 } from "../../types/protocol.js";
import type {
  CompileOptions,
  CompileResult,
  CompiledSemanticMotion,
} from "./contracts.js";
import { runCompilePipeline } from "./pipeline.js";
import {
  createModelEngineStageRegistry,
  type ModelEngineStageRegistry,
} from "./registry.js";
import { compileSemanticMotion } from "./compileSemanticMotion.js";
import {
  createModelParameterCompileContext,
  type ModelParameterCompileContext,
} from "./modelParameterCompileContext.js";
import { normalizeModelEngineSettings } from "../settings.js";

export function compileMotionIntent(
  intent: SemanticMotionIntent,
  options: CompileOptions,
  stageRegistry: ModelEngineStageRegistry = createModelEngineStageRegistry(),
): CompileResult {
  const semanticResult = compileSemanticMotion(intent, options, stageRegistry);
  if (!semanticResult.ok) {
    return {
      ok: false,
      plan: null,
      reason: semanticResult.reason,
      diagnostics: semanticResult.diagnostics,
      feedback: semanticResult.feedback,
    };
  }
  if (semanticResult.motion.kind === "sequence") {
    return compileMotionSequenceIntent(
      semanticResult.motion,
      intent as NormalizedSemanticMotionIntentV4 & {
        motion_steps: NonNullable<NormalizedSemanticMotionIntentV4["motion_steps"]>;
      },
      options,
      stageRegistry,
    );
  }
  return compileModelParameterPose(
    semanticResult.motion,
    intent,
    options,
    stageRegistry,
  );
}

function compileModelParameterPose(
  semanticMotion: Extract<CompiledSemanticMotion, { kind: "pose" }>,
  intent: SemanticMotionIntent,
  options: CompileOptions,
  stageRegistry: ModelEngineStageRegistry,
): CompileResult {
  let context: ModelParameterCompileContext;
  try {
    context = createModelParameterCompileContext(
      semanticMotion,
      intent,
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
    return failCompile(pipelineResult.reason, semanticMotion, context);
  }

  return buildSuccessCompileResult(context);
}

function compileMotionSequenceIntent(
  semanticMotion: Extract<CompiledSemanticMotion, { kind: "sequence" }>,
  intent: NormalizedSemanticMotionIntentV4 & {
    motion_steps: NonNullable<NormalizedSemanticMotionIntentV4["motion_steps"]>;
  },
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
      {
        ...intent,
        axis_levels: intent.motion_steps[index].axis_levels,
        motion_steps: undefined,
      } as NormalizedSemanticMotionIntentV4,
      {
        ...options,
        allowNeutralAxisPose: true,
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
  const totalWeight = intent.motion_steps.reduce(
    (sum, step) => sum + step.duration_weight,
    0,
  );
  const firstPlan = plans[0];
  const parameterTemplates = new Map<string, SemanticParameterPlanEntry>();
  for (const plan of plans) {
    for (const parameter of plan.parameters) {
      parameterTemplates.set(parameter.parameter_id, parameter);
    }
  }
  const resolvedParameterSteps = new Map<string, SemanticParameterPlanEntry[]>();
  for (const template of parameterTemplates.values()) {
    const stepParameters: SemanticParameterPlanEntry[] = [];
    for (let index = 0; index < plans.length; index += 1) {
      const existingParameter = plans[index].parameters.find(
        (item) => item.parameter_id === template.parameter_id,
      );
      const parameter = existingParameter
        ?? resolveNeutralSequenceParameter(template, options);
      if (!parameter || (!existingParameter && template.source === "semantic_axis")) {
        return {
          ok: false,
          plan: null,
          reason: `motion_sequence_parameter_set_mismatch:${index}:${template.parameter_id}`,
          diagnostics: stepResults[index].diagnostics,
          feedback: {
            code: "motion_sequence_parameter_set_mismatch",
            message: `motion_sequence_parameter_set_mismatch:${index}:${template.parameter_id}`,
            fields: [template.axis_id],
          },
        };
      }
      stepParameters.push(parameter);
    }
    resolvedParameterSteps.set(template.parameter_id, stepParameters);
  }
  const minimumDurationResult = resolveMinimumSequenceDurationMs(
    resolvedParameterSteps,
    intent.motion_steps.map((step) => step.duration_weight),
  );
  if (!minimumDurationResult.ok) {
    return {
      ok: false,
      plan: null,
      reason: minimumDurationResult.reason,
      diagnostics: stepResults[minimumDurationResult.stepIndex].diagnostics,
      feedback: {
        code: minimumDurationResult.code,
        message: minimumDurationResult.reason,
        fields: minimumDurationResult.parameterId
          ? [minimumDurationResult.parameterId]
          : [],
      },
    };
  }
  const baseDurationMs = firstPlan.timing.duration_ms;
  const totalDurationMs = Math.max(
    baseDurationMs,
    minimumDurationResult.durationMs,
  );
  let elapsedWeight = 0;
  const stepStartTimes = intent.motion_steps.map((step, index) => {
    const atMs = index === 0
      ? 0
      : Math.round((elapsedWeight / totalWeight) * totalDurationMs);
    elapsedWeight += step.duration_weight;
    return atMs;
  });
  const transitionDurations = resolveSequenceTransitionDurations(
    resolvedParameterSteps,
    stepStartTimes,
    totalDurationMs,
  );
  if (!transitionDurations.ok) {
    return {
      ok: false,
      plan: null,
      reason: transitionDurations.reason,
      diagnostics: stepResults[transitionDurations.stepIndex].diagnostics,
      feedback: {
        code: "motion_sequence_transition_budget_exceeded",
        message: transitionDurations.reason,
        fields: [],
      },
    };
  }
  const parameters: SemanticParameterPlanEntry[] = [];
  for (const stepParameters of resolvedParameterSteps.values()) {
    const baseParameter = stepParameters[0];
    parameters.push({
      ...baseParameter,
      keyframes: stepParameters.map((parameter, index) => {
        return {
          at_ms: stepStartTimes[index],
          transition_ms: transitionDurations.values[index],
          target_value: parameter.target_value,
          input_value: parameter.input_value,
        };
      }),
    });
  }

  const warnings = Array.from(new Set(
    stepResults.flatMap((result) => result.diagnostics.warnings ?? []),
  ));
  if (totalDurationMs > baseDurationMs) {
    warnings.push(
      `motion_sequence_duration_extended:${baseDurationMs}->${totalDurationMs}`,
    );
  }
  const diagnostics = {
    ...stepResults[0].diagnostics,
    compiledParameterCount: parameters.length,
    compiledParameters: parameters.map((item) => item.parameter_id),
    warnings: [...warnings, `motion_sequence_compiled:${plans.length}`],
    transformTrace: stepResults[0].diagnostics.transformTrace
      ? {
          ...stepResults[0].diagnostics.transformTrace,
          rawAxisLevels: undefined,
          compiledParameters: parameters.map((item) => item.parameter_id),
          rawMotionSteps: intent.motion_steps.map((step) => ({
            axis_levels: { ...step.axis_levels },
            duration_weight: step.duration_weight,
          })),
          sequenceSteps: stepResults.map((result, index) => ({
            index,
            durationWeight: intent.motion_steps[index].duration_weight,
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
    plan: {
      ...firstPlan,
      timing: retimeSequencePlanTiming(firstPlan.timing, totalDurationMs),
      parameters,
      diagnostics: {
        ...firstPlan.diagnostics,
        warnings: diagnostics.warnings,
      },
      summary: {
        ...firstPlan.summary,
        parameter_count: parameters.length,
        target_duration_ms: totalDurationMs,
      },
    },
  };
}

interface SequenceTransitionRequirement {
  requiredMs: number;
  stepIndex: number;
  parameterId?: string;
}

type MinimumSequenceDurationResult =
  | { ok: true; durationMs: number }
  | {
    ok: false;
    reason: string;
    code: string;
    stepIndex: number;
    parameterId?: string;
  };

type SequenceTransitionRequirementsResult =
  | { ok: true; requirements: SequenceTransitionRequirement[] }
  | {
    ok: false;
    reason: string;
    code: string;
    stepIndex: number;
    parameterId?: string;
  };

function resolveMinimumSequenceDurationMs(
  parameterSteps: Map<string, SemanticParameterPlanEntry[]>,
  durationWeights: number[],
): MinimumSequenceDurationResult {
  const totalWeight = durationWeights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0 || durationWeights.length === 0) {
    return {
      ok: false,
      reason: "motion_sequence_duration_weights_invalid",
      code: "motion_sequence_duration_weights_invalid",
      stepIndex: 0,
    };
  }

  const requirementsResult = resolveSequenceTransitionRequirements(
    parameterSteps,
    durationWeights.length,
  );
  if (!requirementsResult.ok) {
    return requirementsResult;
  }

  const durationMs = requirementsResult.requirements.reduce(
    (minimum, requirement, segmentIndex) => Math.max(
      minimum,
      Math.ceil(
        (requirement.requiredMs * totalWeight) / durationWeights[segmentIndex],
      ),
    ),
    0,
  );
  return { ok: true, durationMs };
}

function resolveSequenceTransitionRequirements(
  parameterSteps: Map<string, SemanticParameterPlanEntry[]>,
  stepCount: number,
): SequenceTransitionRequirementsResult {
  const requirements: SequenceTransitionRequirement[] = [];
  let initialRequirement: SequenceTransitionRequirement = {
    requiredMs: 0,
    stepIndex: 0,
  };
  for (const [parameterId, steps] of parameterSteps.entries()) {
    const first = steps[0];
    if (!first.dynamics || first.neutral_target_value === undefined) {
      continue;
    }
    const requiredMs = resolveMinimumRestToRestTransitionMs(
      Math.abs(first.target_value - first.neutral_target_value),
      first.dynamics.max_velocity,
      first.dynamics.max_acceleration,
    );
    if (requiredMs > initialRequirement.requiredMs) {
      initialRequirement = { requiredMs, stepIndex: 0, parameterId };
    }
  }
  requirements.push(initialRequirement);

  for (let index = 1; index < stepCount; index += 1) {
    let requirement: SequenceTransitionRequirement = {
      requiredMs: 80,
      stepIndex: index,
    };
    for (const [parameterId, steps] of parameterSteps.entries()) {
      const previous = steps[index - 1];
      const current = steps[index];
      if (!current?.dynamics) {
        return {
          ok: false,
          reason: `motion_sequence_dynamics_missing:${index}:${current?.parameter_id ?? parameterId}`,
          code: "motion_sequence_dynamics_missing",
          stepIndex: index,
          parameterId: current?.parameter_id ?? parameterId,
        };
      }
      const requiredMs = resolveMinimumRestToRestTransitionMs(
        Math.abs(current.target_value - previous.target_value),
        current.dynamics.max_velocity,
        current.dynamics.max_acceleration,
      );
      if (requiredMs > requirement.requiredMs) {
        requirement = { requiredMs, stepIndex: index, parameterId };
      }
    }
    requirements.push(requirement);
  }
  return { ok: true, requirements };
}

function retimeSequencePlanTiming(
  timing: DirectParameterPlanTiming,
  durationMs: number,
): DirectParameterPlanTiming {
  if (durationMs <= timing.duration_ms) {
    return timing;
  }
  const scale = durationMs / timing.duration_ms;
  const blendInMs = Math.round(timing.blend_in_ms * scale);
  const blendOutMs = Math.round(timing.blend_out_ms * scale);
  return {
    ...timing,
    duration_ms: durationMs,
    blend_in_ms: blendInMs,
    hold_ms: Math.max(0, durationMs - blendInMs - blendOutMs),
    blend_out_ms: blendOutMs,
  };
}

function resolveSequenceTransitionDurations(
  parameterSteps: Map<string, SemanticParameterPlanEntry[]>,
  stepStartTimes: number[],
  totalDurationMs: number,
): { ok: true; values: number[] } | { ok: false; reason: string; stepIndex: number } {
  const values: number[] = stepStartTimes.map((_, index) => index === 0 ? 0 : 80);
  const requirementsResult = resolveSequenceTransitionRequirements(
    parameterSteps,
    stepStartTimes.length,
  );
  if (!requirementsResult.ok) {
    return {
      ok: false,
      reason: requirementsResult.reason,
      stepIndex: requirementsResult.stepIndex,
    };
  }
  const initialAvailableMs = stepStartTimes[1] ?? totalDurationMs;
  const initialRequiredMs = requirementsResult.requirements[0].requiredMs;
  if (initialRequiredMs > initialAvailableMs) {
    return {
      ok: false,
      reason: `motion_sequence_transition_budget_exceeded:0:${initialRequiredMs}:${initialAvailableMs}`,
      stepIndex: 0,
    };
  }
  for (let index = 1; index < stepStartTimes.length; index += 1) {
    const stepEndMs = index + 1 < stepStartTimes.length
      ? stepStartTimes[index + 1]
      : totalDurationMs;
    const availableMs = Math.max(1, stepEndMs - stepStartTimes[index]);
    const requiredMs = Math.max(
      requirementsResult.requirements[index].requiredMs,
      Math.round(availableMs * 0.3),
    );
    if (requiredMs > availableMs) {
      return {
        ok: false,
        reason: `motion_sequence_transition_budget_exceeded:${index}:${requiredMs}:${availableMs}`,
        stepIndex: index,
      };
    }
    values[index] = requiredMs;
  }
  return { ok: true, values };
}

function resolveMinimumRestToRestTransitionMs(
  distance: number,
  maxVelocity: number,
  maxAcceleration: number,
): number {
  const accelerationDistanceAtMaxVelocity = (maxVelocity * maxVelocity) / maxAcceleration;
  const seconds = distance <= accelerationDistanceAtMaxVelocity
    ? 2 * Math.sqrt(distance / maxAcceleration)
    : distance / maxVelocity + maxVelocity / maxAcceleration;
  return Math.ceil(seconds * 1000);
}

function resolveNeutralSequenceParameter(
  template: SemanticParameterPlanEntry,
  options: CompileOptions,
): SemanticParameterPlanEntry | null {
  if (template.source === "semantic_axis") {
    return null;
  }
  const profile = options.model.semantic_axis_profile;
  const axis = profile?.axes.find((item) => item.id === template.axis_id);
  const binding = axis?.parameter_bindings.find(
    (item) => item.parameter_id === template.parameter_id,
  );
  if (!axis || !binding) {
    return null;
  }
  const [inputMin, inputMax] = binding.input_range;
  const [outputMin, outputMax] = binding.output_range;
  if (inputMax <= inputMin) {
    return null;
  }
  const inputRatio = (axis.neutral - inputMin) / (inputMax - inputMin);
  const mappedRatio = binding.invert ? 1 - inputRatio : inputRatio;
  return {
    ...template,
    input_value: axis.neutral,
    target_value: Math.round(
      (outputMin + (outputMax - outputMin) * mappedRatio) * 1000000,
    ) / 1000000,
  };
}

function failCompile(
  reason: string,
  semanticMotion: CompiledSemanticMotion,
  context?: ModelParameterCompileContext,
): CompileResult {
  const diagnostics = buildModelParameterDiagnostics(semanticMotion, context);
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
    schema_version: SCHEMA_PARAMETER_PLAN_V2,
    profile_id: profile.profile_id,
    profile_revision: profile.revision,
    model_id: profile.model_id,
    mode: semanticMotion.mode,
    emotion_label: semanticMotion.emotionLabel,
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
  };
}

function buildModelParameterDiagnostics(
  semanticMotion: CompiledSemanticMotion,
  context?: ModelParameterCompileContext,
): CompileResult["diagnostics"] {
  const parameters = context?.state.parameters ?? [];
  const resource = context?.state.resource;
  return {
    ...semanticMotion.diagnostics,
    compiledParameterCount: parameters.length,
    compiledParameters: parameters.map((item) => item.parameter_id),
    warnings: context
      ? [...context.state.warnings]
      : [...(semanticMotion.diagnostics.warnings ?? [])],
    transformTrace: semanticMotion.diagnostics.transformTrace
      ? {
          ...semanticMotion.diagnostics.transformTrace,
          resolvedResource: resource
            ? {
                resourceId: resource.resourceId,
                resourceType: resource.resourceType,
                parameterIds: [...resource.parameterIds],
              }
            : undefined,
          compiledParameters: parameters.map((item) => item.parameter_id),
        }
      : undefined,
  };
}
