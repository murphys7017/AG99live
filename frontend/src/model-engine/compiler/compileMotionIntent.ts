import type {
  NormalizedSemanticMotionIntentV4,
  SemanticMotionIntent,
  SemanticParameterPlanEntry,
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
import {
  createModelEngineStageRegistry,
  type ModelEngineStageRegistry,
} from "./registry.js";

export function compileMotionIntent(
  intent: SemanticMotionIntent,
  options: CompileOptions,
  stageRegistry: ModelEngineStageRegistry = createModelEngineStageRegistry(),
): CompileResult {
  if (
    intent.schema_version === "engine.motion_intent.v4"
    && Array.isArray(intent.motion_steps)
  ) {
    return compileMotionSequenceIntent(
      intent as NormalizedSemanticMotionIntentV4 & {
        motion_steps: NonNullable<NormalizedSemanticMotionIntentV4["motion_steps"]>;
      },
      options,
      stageRegistry,
    );
  }
  return compileSingleMotionIntent(intent, options, stageRegistry);
}

function compileSingleMotionIntent(
  intent: SemanticMotionIntent,
  options: CompileOptions,
  stageRegistry: ModelEngineStageRegistry,
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

  const pipelineResult = runCompilePipeline(context, stageRegistry.resolve(context));
  if (!pipelineResult.ok) {
    return failCompile(pipelineResult.reason, context);
  }

  return buildSuccessCompileResult(context);
}

function compileMotionSequenceIntent(
  intent: NormalizedSemanticMotionIntentV4 & {
    motion_steps: NonNullable<NormalizedSemanticMotionIntentV4["motion_steps"]>;
  },
  options: CompileOptions,
  stageRegistry: ModelEngineStageRegistry,
): CompileResult {
  const stepResults = intent.motion_steps.map((step) =>
    compileSingleMotionIntent(
      {
        ...intent,
        axis_levels: step.axis_levels,
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
  const stepSignatures = intent.motion_steps.map((step) =>
    JSON.stringify(Object.entries(step.axis_levels).sort(([left], [right]) =>
      left.localeCompare(right),
    )),
  );
  const hasTransition = stepSignatures.some(
    (signature, index) => index > 0 && signature !== stepSignatures[index - 1],
  );
  const allNeutral = intent.motion_steps.every((step) =>
    Object.values(step.axis_levels).every((level) => level === 0),
  );
  if (!hasTransition || allNeutral) {
    const reason = allNeutral
      ? "motion_sequence_all_neutral"
      : "motion_sequence_has_no_transition";
    return {
      ok: false,
      plan: null,
      reason,
      diagnostics: stepResults[0].diagnostics,
      feedback: {
        code: reason,
        message: reason,
        fields: [],
      },
    };
  }
  const firstPlan = plans[0];

  const totalWeight = intent.motion_steps.reduce(
    (sum, step) => sum + step.duration_weight,
    0,
  );
  const totalDurationMs = firstPlan.timing.duration_ms;
  let elapsedWeight = 0;
  const stepStartTimes = intent.motion_steps.map((step, index) => {
    const atMs = index === 0
      ? 0
      : Math.round((elapsedWeight / totalWeight) * totalDurationMs);
    elapsedWeight += step.duration_weight;
    return atMs;
  });
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
      parameters,
      diagnostics: {
        ...firstPlan.diagnostics,
        warnings: diagnostics.warnings,
      },
      summary: {
        ...firstPlan.summary,
        parameter_count: parameters.length,
      },
    },
  };
}

function resolveSequenceTransitionDurations(
  parameterSteps: Map<string, SemanticParameterPlanEntry[]>,
  stepStartTimes: number[],
  totalDurationMs: number,
): { ok: true; values: number[] } | { ok: false; reason: string; stepIndex: number } {
  const values: number[] = stepStartTimes.map((_, index) => index === 0 ? 0 : 80);
  const initialAvailableMs = stepStartTimes[1] ?? totalDurationMs;
  let initialRequiredMs = 0;
  for (const steps of parameterSteps.values()) {
    const first = steps[0];
    if (!first.dynamics || first.neutral_target_value === undefined) {
      continue;
    }
    initialRequiredMs = Math.max(
      initialRequiredMs,
      resolveMinimumRestToRestTransitionMs(
        Math.abs(first.target_value - first.neutral_target_value),
        first.dynamics.max_velocity,
        first.dynamics.max_acceleration,
      ),
    );
  }
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
    let requiredMs = Math.max(80, Math.round(availableMs * 0.3));
    for (const steps of parameterSteps.values()) {
      const previous = steps[index - 1];
      const current = steps[index];
      const dynamics = current.dynamics;
      if (!dynamics) {
        return {
          ok: false,
          reason: `motion_sequence_dynamics_missing:${index}:${current.parameter_id}`,
          stepIndex: index,
        };
      }
      const distance = Math.abs(current.target_value - previous.target_value);
      if (distance <= 0.0001) {
        continue;
      }
      requiredMs = Math.max(
        requiredMs,
        resolveMinimumRestToRestTransitionMs(
          distance,
          dynamics.max_velocity,
          dynamics.max_acceleration,
        ),
      );
    }
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
