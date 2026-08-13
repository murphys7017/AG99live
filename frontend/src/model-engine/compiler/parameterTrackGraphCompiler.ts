import type {
  DirectParameterPlanTiming,
  SemanticParameterPlan,
  SemanticParameterPlanEntry,
} from "../../types/protocol.js";
import type {
  SemanticAxisDefinition,
  SemanticAxisProfile,
} from "../../types/semantic-axis-profile.js";
import type { PerformanceSchedule } from "./performanceSchedule.js";

interface ParameterTrackTimingPolicy {
  transitionOffsetMs: number;
  transitionMs: number;
  preferredHoldMs: number;
  residualMs: number;
}

interface ParameterTrackGraphInput {
  schedule: PerformanceSchedule;
  stepPlans: SemanticParameterPlan[];
  profile: SemanticAxisProfile;
}

interface ParameterTrackBuildResult {
  points: SemanticParameterPlanEntry["keyframes"];
  requiredOwnedUntilMs: number;
  compressed: boolean;
}

export type ParameterTrackGraphCompileResult =
  | {
    ok: true;
    timing: DirectParameterPlanTiming;
    parameters: SemanticParameterPlanEntry[];
    warnings: string[];
  }
  | {
    ok: false;
    reason: string;
    code: string;
    stepIndex: number;
    parameterId?: string;
  };

export function compileParameterSequenceTrackGraph(
  input: ParameterTrackGraphInput,
): ParameterTrackGraphCompileResult {
  const { schedule, stepPlans, profile } = input;
  if (stepPlans.length !== schedule.semanticSteps.length) {
    return {
      ok: false,
      reason: `parameter_track_graph_schedule_step_count_mismatch:${stepPlans.length}:${schedule.semanticSteps.length}`,
      code: "parameter_track_graph_schedule_step_count_mismatch",
      stepIndex: 0,
    };
  }
  const firstPlan = stepPlans[0];
  const mismatchedTimingIndex = stepPlans.findIndex(
    (plan) => plan.timing.duration_ms !== schedule.durationMs,
  );
  if (!firstPlan || mismatchedTimingIndex >= 0) {
    return {
      ok: false,
      reason: `parameter_track_graph_schedule_timing_mismatch:${Math.max(0, mismatchedTimingIndex)}`,
      code: "parameter_track_graph_schedule_timing_mismatch",
      stepIndex: Math.max(0, mismatchedTimingIndex),
    };
  }
  const scheduleDurationMs = schedule.durationMs;
  const stepStartTimes = schedule.semanticSteps.map((step) => step.startMs);
  const axisById = new Map(profile.axes.map((axis) => [axis.id, axis]));
  const parameterStepsResult = resolveParameterSteps(stepPlans, axisById);
  if (!parameterStepsResult.ok) {
    return parameterStepsResult;
  }

  const parameters: SemanticParameterPlanEntry[] = [];
  let graphDurationMs = scheduleDurationMs;
  let staggeredTrackCount = 0;
  let residualTrackCount = 0;
  let compressedTrackCount = 0;
  for (const parameterSteps of parameterStepsResult.parameterSteps.values()) {
    const baseParameter = parameterSteps[0];
    const axis = axisById.get(baseParameter.axis_id);
    if (!axis) {
      return {
        ok: false,
        reason: `parameter_track_graph_axis_missing:${baseParameter.axis_id}`,
        code: "parameter_track_graph_axis_missing",
        stepIndex: 0,
        parameterId: baseParameter.parameter_id,
      };
    }
    const policy = resolveTrackTimingPolicy(axis.semantic_group);
    const keyframes = buildSemanticTrack(
      parameterSteps,
      stepStartTimes,
      scheduleDurationMs,
      policy,
    );
    if (keyframes.points && policy.transitionOffsetMs !== 0) {
      staggeredTrackCount += 1;
    }
    if (keyframes.points && policy.residualMs > 0) {
      residualTrackCount += 1;
    }
    if (keyframes.compressed) {
      compressedTrackCount += 1;
    }
    graphDurationMs = Math.max(
      graphDurationMs,
      keyframes.requiredOwnedUntilMs + firstPlan.timing.blend_out_ms,
    );
    parameters.push({
      ...baseParameter,
      keyframes: keyframes.points,
    });
  }

  const warnings = [
    `parameter_track_graph_compiled:${parameters.length}`,
    `parameter_track_graph_staggered_tracks:${staggeredTrackCount}`,
    `parameter_track_graph_residual_tracks:${residualTrackCount}`,
    `motion_sequence_compiled:${stepPlans.length}`,
  ];
  if (compressedTrackCount > 0) {
    warnings.push(
      `parameter_track_graph_compressed_tracks:${compressedTrackCount}`,
    );
  }
  if (graphDurationMs > scheduleDurationMs) {
    warnings.push(
      `parameter_track_graph_tail_extended:${scheduleDurationMs}->${graphDurationMs}`,
    );
  }

  return {
    ok: true,
    timing: retimePlan(firstPlan.timing, graphDurationMs),
    parameters,
    warnings,
  };
}

function resolveParameterSteps(
  plans: SemanticParameterPlan[],
  axisById: Map<string, SemanticAxisDefinition>,
):
  | { ok: true; parameterSteps: Map<string, SemanticParameterPlanEntry[]> }
  | Extract<ParameterTrackGraphCompileResult, { ok: false }> {
  const templates = new Map<string, SemanticParameterPlanEntry>();
  for (const plan of plans) {
    for (const parameter of plan.parameters) {
      if (!templates.has(parameter.parameter_id)) {
        templates.set(parameter.parameter_id, parameter);
      }
    }
  }

  const parameterSteps = new Map<string, SemanticParameterPlanEntry[]>();
  for (const template of templates.values()) {
    const steps: SemanticParameterPlanEntry[] = [];
    for (let index = 0; index < plans.length; index += 1) {
      const existing = plans[index].parameters.find(
        (parameter) => parameter.parameter_id === template.parameter_id,
      );
      const parameter = existing ?? resolveNeutralParameter(template, axisById);
      if (!parameter || (!existing && template.source === "semantic_axis")) {
        return {
          ok: false,
          reason: `parameter_track_graph_parameter_set_mismatch:${index}:${template.parameter_id}`,
          code: "parameter_track_graph_parameter_set_mismatch",
          stepIndex: index,
          parameterId: template.parameter_id,
        };
      }
      steps.push(parameter);
    }
    parameterSteps.set(template.parameter_id, steps);
  }
  return { ok: true, parameterSteps };
}

function buildSemanticTrack(
  parameterSteps: SemanticParameterPlanEntry[],
  stepStartTimes: number[],
  scheduleDurationMs: number,
  policy: ParameterTrackTimingPolicy,
): ParameterTrackBuildResult {
  const changedStepIndices = [0];
  for (let index = 1; index < parameterSteps.length; index += 1) {
    const current = parameterSteps[index];
    const previous = parameterSteps[changedStepIndices[changedStepIndices.length - 1]];
    if (
      Math.abs(current.target_value - previous.target_value) > 0.000001
      || Math.abs((current.input_value ?? 0) - (previous.input_value ?? 0)) > 0.000001
    ) {
      changedStepIndices.push(index);
    }
  }
  if (changedStepIndices.length === 1) {
    return {
      points: undefined,
      requiredOwnedUntilMs: 0,
      compressed: false,
    };
  }

  const points: NonNullable<SemanticParameterPlanEntry["keyframes"]> = [{
    at_ms: 0,
    transition_ms: 0,
    target_value: parameterSteps[0].target_value,
    input_value: parameterSteps[0].input_value,
  }];
  const transitionStarts: number[] = [];
  let previousAtMs = 0;
  for (let position = 1; position < changedStepIndices.length; position += 1) {
    const stepIndex = changedStepIndices[position];
    const desiredAtMs = Math.max(
      1,
      Math.round(stepStartTimes[stepIndex] + policy.transitionOffsetMs),
    );
    const atMs = Math.max(desiredAtMs, previousAtMs + 1);
    transitionStarts.push(atMs);
    previousAtMs = atMs;
  }

  let compressed = false;
  let finalTransitionEndMs = 0;
  for (let position = 0; position < transitionStarts.length; position += 1) {
    const stepIndex = changedStepIndices[position + 1];
    const atMs = transitionStarts[position];
    const nextAtMs = transitionStarts[position + 1];
    const availableWindowMs = nextAtMs === undefined
      ? Math.max(0, scheduleDurationMs - atMs)
      : nextAtMs - atMs;
    const transition = nextAtMs === undefined && availableWindowMs === 0
      ? { transitionMs: policy.transitionMs, compressed: false }
      : resolveTransitionWindow(availableWindowMs, policy);
    compressed ||= transition.compressed;
    points.push({
      at_ms: atMs,
      transition_ms: transition.transitionMs,
      target_value: parameterSteps[stepIndex].target_value,
      input_value: parameterSteps[stepIndex].input_value,
    });
    finalTransitionEndMs = atMs + transition.transitionMs;
  }

  return {
    points,
    requiredOwnedUntilMs: finalTransitionEndMs + policy.residualMs,
    compressed,
  };
}

function resolveTransitionWindow(
  availableWindowMs: number,
  policy: ParameterTrackTimingPolicy,
): { transitionMs: number; compressed: boolean } {
  const preferredWindowMs = policy.transitionMs + policy.preferredHoldMs;
  if (availableWindowMs >= preferredWindowMs) {
    return { transitionMs: policy.transitionMs, compressed: false };
  }
  if (availableWindowMs <= 0) {
    return { transitionMs: 0, compressed: true };
  }
  const transitionRatio = policy.transitionMs / preferredWindowMs;
  return {
    transitionMs: Math.min(
      policy.transitionMs,
      Math.max(1, Math.round(availableWindowMs * transitionRatio)),
    ),
    compressed: true,
  };
}

function resolveTrackTimingPolicy(semanticGroup: string): ParameterTrackTimingPolicy {
  const group = semanticGroup.trim().toLowerCase();
  if (group === "gaze") {
    return {
      transitionOffsetMs: -70,
      transitionMs: 80,
      preferredHoldMs: 45,
      residualMs: 20,
    };
  }
  if (group === "head") {
    return {
      transitionOffsetMs: 0,
      transitionMs: 110,
      preferredHoldMs: 55,
      residualMs: 70,
    };
  }
  if (group === "body" || group === "torso" || group === "shoulder") {
    return {
      transitionOffsetMs: 110,
      transitionMs: 140,
      preferredHoldMs: 70,
      residualMs: 150,
    };
  }
  if (group === "eye" || group === "brow" || group === "mouth" || group === "face") {
    return {
      transitionOffsetMs: 25,
      transitionMs: 80,
      preferredHoldMs: 45,
      residualMs: 40,
    };
  }
  return {
    transitionOffsetMs: 0,
    transitionMs: 100,
    preferredHoldMs: 50,
    residualMs: 60,
  };
}

function resolveNeutralParameter(
  template: SemanticParameterPlanEntry,
  axisById: Map<string, SemanticAxisDefinition>,
): SemanticParameterPlanEntry | null {
  if (template.source === "semantic_axis") {
    return null;
  }
  const axis = axisById.get(template.axis_id);
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
    target_value: roundValue(outputMin + (outputMax - outputMin) * mappedRatio),
    modulation: undefined,
  };
}

function retimePlan(
  timing: DirectParameterPlanTiming,
  durationMs: number,
): DirectParameterPlanTiming {
  if (durationMs <= timing.duration_ms) {
    return timing;
  }
  const blendInMs = Math.min(timing.blend_in_ms, durationMs);
  const blendOutMs = Math.min(
    timing.blend_out_ms,
    Math.max(0, durationMs - blendInMs),
  );
  return {
    ...timing,
    duration_ms: durationMs,
    blend_in_ms: blendInMs,
    hold_ms: Math.max(0, durationMs - blendInMs - blendOutMs),
    blend_out_ms: blendOutMs,
  };
}

function roundValue(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}
