import type {
  DirectParameterPlanTiming,
  SemanticParameterPlan,
  SemanticParameterPlanEntry,
} from "../../types/protocol.js";
import type {
  SemanticAxisDefinition,
  SemanticAxisProfile,
} from "../../types/semantic-axis-profile.js";
import {
  compileSemanticTrackTiming,
  registerPerformanceParameterNodes,
  type PerformanceSchedule,
  type PerformanceScheduleMutationResult,
  type PerformanceSemanticTrackTiming,
} from "./performanceSchedule.js";

interface ParameterTrackGraphInput {
  schedule: PerformanceSchedule;
  stepPlans: SemanticParameterPlan[];
  profile: SemanticAxisProfile;
}

type ParameterTrackBuildResult =
  | { ok: true; points: SemanticParameterPlanEntry["keyframes"] }
  | { ok: false; reason: string };

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
  const timingsByAxis = new Map<string, PerformanceSemanticTrackTiming>();
  const changedStepsByAxis = new Map<string, readonly number[]>();
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
    const changedStepIndices = resolveChangedStepIndices(parameterSteps);
    const axisChangedStepIndices = changedStepsByAxis.get(axis.id);
    if (
      axisChangedStepIndices
      && !areSameStepIndices(axisChangedStepIndices, changedStepIndices)
    ) {
      return {
        ok: false,
        reason: `parameter_track_graph_axis_step_mismatch:${axis.id}:${baseParameter.parameter_id}`,
        code: "parameter_track_graph_axis_step_mismatch",
        stepIndex: changedStepIndices[changedStepIndices.length - 1] ?? 0,
        parameterId: baseParameter.parameter_id,
      };
    }
    changedStepsByAxis.set(axis.id, changedStepIndices);
    const timing = resolveSemanticTrackTiming(
      timingsByAxis,
      schedule,
      axis,
      changedStepIndices,
    );
    if (!timing.ok) {
      return {
        ok: false,
        reason: timing.reason,
        code: "parameter_track_graph_schedule_event_invalid",
        stepIndex: changedStepIndices[changedStepIndices.length - 1] ?? 0,
        parameterId: baseParameter.parameter_id,
      };
    }
    const keyframes = buildSemanticTrack(parameterSteps, timing.value.events);
    if (!keyframes.ok) {
      return {
        ok: false,
        reason: keyframes.reason,
        code: "parameter_track_graph_schedule_event_invalid",
        stepIndex: changedStepIndices[changedStepIndices.length - 1] ?? 0,
        parameterId: baseParameter.parameter_id,
      };
    }
    if (keyframes.points && timing.value.staggered) {
      staggeredTrackCount += 1;
    }
    if (keyframes.points && timing.value.residual) {
      residualTrackCount += 1;
    }
    if (timing.value.compressed) {
      compressedTrackCount += 1;
    }
    graphDurationMs = Math.max(
      graphDurationMs,
      keyframes.points
        ? timing.value.requiredOwnedUntilMs + firstPlan.timing.blend_out_ms
        : scheduleDurationMs,
    );
    if (keyframes.points) {
      const nodeResult = registerPerformanceParameterNodes(
        schedule,
        keyframes.points.map((point, nodeIndex) => ({
          parameterId: baseParameter.parameter_id,
          axisId: baseParameter.axis_id,
          trackKind: "keyframe" as const,
          nodeIndex,
          eventId: timing.value.events[nodeIndex].id,
          atMs: point.at_ms,
          transitionMs: point.transition_ms,
        })),
      );
      if (!nodeResult.ok) {
        return {
          ok: false,
          reason: nodeResult.reason,
          code: "parameter_track_graph_parameter_node_invalid",
          stepIndex: changedStepIndices[changedStepIndices.length - 1] ?? 0,
          parameterId: baseParameter.parameter_id,
        };
      }
    }
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
  events: PerformanceSemanticTrackTiming["events"],
): ParameterTrackBuildResult {
  if (events.length === 0) {
    return {
      ok: true,
      points: undefined,
    };
  }
  const points: NonNullable<SemanticParameterPlanEntry["keyframes"]> = [];
  for (const event of events) {
    const stepIndex = event.stepIndex;
    if (stepIndex === undefined) {
      return { ok: false, reason: `parameter_track_graph_event_step_missing:${event.id}` };
    }
    const parameter = parameterSteps[stepIndex];
    if (!parameter) {
      return { ok: false, reason: `parameter_track_graph_event_step_out_of_range:${event.id}` };
    }
    points.push({
      at_ms: event.atMs,
      transition_ms: event.transitionMs,
      target_value: parameter.target_value,
      input_value: parameter.input_value,
    });
  }
  return {
    ok: true,
    points,
  };
}

function areSameStepIndices(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return left.length === right.length
    && left.every((stepIndex, index) => stepIndex === right[index]);
}

function resolveChangedStepIndices(
  parameterSteps: readonly SemanticParameterPlanEntry[],
): number[] {
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
  return changedStepIndices;
}

function resolveSemanticTrackTiming(
  timingsByAxis: Map<string, PerformanceSemanticTrackTiming>,
  schedule: PerformanceSchedule,
  axis: SemanticAxisDefinition,
  changedStepIndices: readonly number[],
): PerformanceScheduleMutationResult<PerformanceSemanticTrackTiming> {
  if (changedStepIndices.length === 1) {
    return {
      ok: true,
      reason: "",
      value: {
        events: [],
        requiredOwnedUntilMs: 0,
        staggered: false,
        residual: false,
        compressed: false,
      },
    };
  }
  const existing = timingsByAxis.get(axis.id);
  if (existing) {
    return { ok: true, value: existing, reason: "" };
  }
  const timing = compileSemanticTrackTiming({
    schedule,
    semanticAxisId: axis.id,
    semanticGroup: axis.semantic_group,
    changedStepIndices,
  });
  if (timing.ok) {
    timingsByAxis.set(axis.id, timing.value);
  }
  return timing;
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
