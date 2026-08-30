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
  MAX_PARAMETER_KEYFRAME_COUNT,
  MIN_PARAMETER_KEYFRAME_COUNT,
} from "../constants.js";
import {
  compileFaceTrackTiming,
  finalizePerformancePlanRelease,
  compileGazeTrackTiming,
  compileSemanticTrackTiming,
  registerPerformanceParameterNodes,
  resolvePerformancePartTrackStrategy,
  type PerformancePartTrackTiming,
  type PerformancePartTrackStrategy,
  type PerformanceStagedPartTrackStrategy,
  type PerformanceSchedule,
  type PerformanceScheduleMutationResult,
} from "./performanceSchedule.js";

const GAZE_LEAD_TARGET_RATIO = 0.72;
const GAZE_PHRASE_TRANSFER_TARGET_RATIO = 0.86;
const FACE_ENTER_TARGET_RATIO = 0.68;

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
  let gazeTrackCount = 0;
  let faceTrackCount = 0;
  const timingsByAxis = new Map<string, PerformancePartTrackTiming>();
  const changedStepsByAxis = new Map<string, readonly number[]>();
  const activeStagedPartAxes = resolveActiveStagedPartAxes(
    parameterStepsResult.parameterSteps,
    axisById,
  );
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
    const reversalStepIndices = resolveParameterReversalStepIndices(
      parameterSteps,
      changedStepIndices,
      axis.neutral,
    );
    const strategy = resolvePartTrackStrategy(
      axis.semantic_group,
      activeStagedPartAxes.has(axis.id),
    );
    const timing = resolvePartTrackTiming(
      timingsByAxis,
      schedule,
      axis,
      changedStepIndices,
      reversalStepIndices,
      strategy,
      firstPlan.timing.blend_out_ms,
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
    const keyframes = buildScheduledParameterTrack(
      parameterSteps,
      timing.value,
      axis.neutral,
    );
    if (!keyframes.ok) {
      return {
        ok: false,
        reason: keyframes.reason,
        code: "parameter_track_graph_schedule_event_invalid",
        stepIndex: changedStepIndices[changedStepIndices.length - 1] ?? 0,
        parameterId: baseParameter.parameter_id,
      };
    }
    if (
      keyframes.points
      && keyframes.points.length !== timing.value.parameterEvents.length
    ) {
      return {
        ok: false,
        reason: `parameter_track_graph_event_node_count_mismatch:${baseParameter.parameter_id}:${timing.value.parameterEvents.length}:${keyframes.points.length}`,
        code: "parameter_track_graph_event_node_count_mismatch",
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
    if (keyframes.points && timing.value.strategy === "gaze") {
      gazeTrackCount += 1;
    }
    if (keyframes.points && timing.value.strategy === "face") {
      faceTrackCount += 1;
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
          eventId: timing.value.parameterEvents[nodeIndex].id,
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

  const releaseResult = finalizePerformancePlanRelease({
    schedule,
    releaseAtMs: graphDurationMs - firstPlan.timing.blend_out_ms,
    blendOutMs: firstPlan.timing.blend_out_ms,
  });
  if (!releaseResult.ok) {
    return {
      ok: false,
      reason: releaseResult.reason,
      code: "parameter_track_graph_plan_release_invalid",
      stepIndex: stepPlans.length - 1,
    };
  }

  const warnings = [
    `parameter_track_graph_compiled:${parameters.length}`,
    `parameter_track_graph_staggered_tracks:${staggeredTrackCount}`,
    `parameter_track_graph_residual_tracks:${residualTrackCount}`,
    `parameter_track_graph_gaze_tracks:${gazeTrackCount}`,
    `parameter_track_graph_face_tracks:${faceTrackCount}`,
    `motion_sequence_compiled:${stepPlans.length}`,
  ];
  if (compressedTrackCount > 0) {
    warnings.push(
      `parameter_track_graph_compressed_tracks:${compressedTrackCount}`,
    );
  }
  if (gazeTrackCount > 0) {
    warnings.push("parameter_track_graph_gaze_release:plan_blend");
  }
  if (faceTrackCount > 0) {
    warnings.push("parameter_track_graph_face_release:plan_blend");
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
  events: PerformancePartTrackTiming["parameterEvents"],
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

export function buildStagedPartParameterTrack(
  parameterSteps: readonly SemanticParameterPlanEntry[],
  timing: PerformancePartTrackTiming,
  axisNeutralValue: number,
): ParameterTrackBuildResult {
  const trackEvents = timing.parameterEvents;
  const strategy = timing.strategy;
  if (strategy === "semantic") {
    return {
      ok: false,
      reason: "parameter_track_graph_staged_part_strategy_invalid:semantic",
    };
  }
  if (
    trackEvents.length < MIN_PARAMETER_KEYFRAME_COUNT
    || trackEvents.length > MAX_PARAMETER_KEYFRAME_COUNT
  ) {
    return {
      ok: false,
      reason: `parameter_track_graph_${strategy}_event_count_invalid:${trackEvents.length}`,
    };
  }
  const points: NonNullable<SemanticParameterPlanEntry["keyframes"]> = [];
  const hasSettleEvent = trackEvents.some((event) => (
    event.kind === "gaze_dwell" || event.kind === "face_settle"
  ));
  for (const event of trackEvents) {
    const parameter = event.stepIndex === undefined
      ? parameterSteps[parameterSteps.length - 1]
      : parameterSteps[event.stepIndex];
    if (!parameter) {
      return {
        ok: false,
        reason: `parameter_track_graph_${strategy}_event_step_out_of_range:${event.id}`,
      };
    }
    const targetRatio = resolveStagedPartTargetRatio(
      strategy,
      event,
      hasSettleEvent,
    );
    if (targetRatio === null) {
      return {
        ok: false,
        reason: `parameter_track_graph_${strategy}_event_kind_invalid:${event.id}:${event.kind}`,
      };
    }
    points.push({
      at_ms: event.atMs,
      transition_ms: event.transitionMs,
      target_value: interpolateTargetValue(
        parameter.neutral_target_value,
        parameter.target_value,
        targetRatio,
      ),
      input_value: parameter.input_value === undefined
        ? undefined
        : interpolateTargetValue(
            axisNeutralValue,
            parameter.input_value,
            targetRatio,
          ),
    });
  }
  return { ok: true, points };
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

function resolveParameterReversalStepIndices(
  parameterSteps: readonly SemanticParameterPlanEntry[],
  changedStepIndices: readonly number[],
  axisNeutralValue: number,
): number[] {
  const reversalStepIndices: number[] = [];
  for (let index = 1; index < changedStepIndices.length; index += 1) {
    const previous = parameterSteps[changedStepIndices[index - 1]];
    const current = parameterSteps[changedStepIndices[index]];
    if (!previous || !current) {
      continue;
    }
    const previousValue = previous.input_value;
    const currentValue = current.input_value;
    if (previousValue === undefined || currentValue === undefined) {
      continue;
    }
    const previousDelta = previousValue - axisNeutralValue;
    const currentDelta = currentValue - axisNeutralValue;
    if (
      Math.abs(previousDelta) > 0.000001
      && Math.abs(currentDelta) > 0.000001
      && previousDelta * currentDelta < 0
    ) {
      reversalStepIndices.push(changedStepIndices[index]);
    }
  }
  return reversalStepIndices;
}

function buildScheduledParameterTrack(
  parameterSteps: SemanticParameterPlanEntry[],
  timing: PerformancePartTrackTiming,
  axisNeutralValue: number,
): ParameterTrackBuildResult {
  if (timing.strategy !== "semantic") {
    return buildStagedPartParameterTrack(
      parameterSteps,
      timing,
      axisNeutralValue,
    );
  }
  return buildSemanticTrack(parameterSteps, timing.parameterEvents);
}

function resolvePartTrackTiming(
  timingsByAxis: Map<string, PerformancePartTrackTiming>,
  schedule: PerformanceSchedule,
  axis: SemanticAxisDefinition,
  changedStepIndices: readonly number[],
  reversalStepIndices: readonly number[],
  strategy: PerformancePartTrackStrategy,
  blendOutMs: number,
): PerformanceScheduleMutationResult<PerformancePartTrackTiming> {
  const existing = timingsByAxis.get(axis.id);
  if (existing) {
    if (existing.strategy !== strategy) {
      return {
        ok: false,
        value: null,
        reason: `performance_schedule_axis_strategy_mismatch:${axis.id}:${existing.strategy}:${strategy}`,
      };
    }
    return { ok: true, value: existing, reason: "" };
  }
  if (strategy === "semantic" && changedStepIndices.length === 1) {
    const timing: PerformancePartTrackTiming = {
      strategy: "semantic",
      events: [],
      parameterEvents: [],
      requiredOwnedUntilMs: 0,
      staggered: false,
      residual: false,
      compressed: false,
    };
    timingsByAxis.set(axis.id, timing);
    return { ok: true, value: timing, reason: "" };
  }
  const timing = strategy === "gaze"
    ? compileGazeTrackTiming({
        schedule,
        semanticAxisId: axis.id,
        semanticGroup: axis.semantic_group,
        changedStepIndices,
        blendOutMs,
        allowTailExtension: true,
      })
    : strategy === "face"
      ? compileFaceTrackTiming({
          schedule,
          semanticAxisId: axis.id,
          semanticGroup: axis.semantic_group,
          changedStepIndices,
          blendOutMs,
          allowTailExtension: true,
        })
    : compileSemanticTrackTiming({
        schedule,
        semanticAxisId: axis.id,
        semanticGroup: axis.semantic_group,
        changedStepIndices,
        blendOutMs,
        reversalStepIndices,
      });
  if (timing.ok) {
    timingsByAxis.set(axis.id, timing.value);
  }
  return timing;
}

export function isStagedPartParameterTrackActive(
  parameterSteps: readonly SemanticParameterPlanEntry[],
  axisNeutralValue: number,
): boolean {
  return parameterSteps.some((parameter) => (
    Math.abs(parameter.target_value - parameter.neutral_target_value) > 0.000001
    || (
      parameter.input_value !== undefined
      && Math.abs(parameter.input_value - axisNeutralValue) > 0.000001
    )
  ));
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

function interpolateTargetValue(
  neutralValue: number,
  targetValue: number,
  ratio: number,
): number {
  return roundValue(neutralValue + (targetValue - neutralValue) * ratio);
}

function resolveStagedPartTargetRatio(
  strategy: PerformanceStagedPartTrackStrategy,
  event: PerformancePartTrackTiming["parameterEvents"][number],
  hasSettleEvent: boolean,
): number | null {
  if (strategy === "gaze") {
    if (event.kind === "gaze_lead") {
      return hasSettleEvent ? GAZE_LEAD_TARGET_RATIO : 1;
    }
    if (event.kind === "gaze_dwell") {
      return 1;
    }
    if (event.kind === "gaze_transfer") {
      return event.stepIndex === undefined
        ? GAZE_PHRASE_TRANSFER_TARGET_RATIO
        : 1;
    }
    return null;
  }
  if (event.kind === "face_enter") {
    return hasSettleEvent ? FACE_ENTER_TARGET_RATIO : 1;
  }
  if (event.kind === "face_settle" || event.kind === "face_transfer") {
    return 1;
  }
  return null;
}

function resolveActiveStagedPartAxes(
  parameterStepsById: Map<string, SemanticParameterPlanEntry[]>,
  axisById: Map<string, SemanticAxisDefinition>,
): Set<string> {
  const activeAxisIds = new Set<string>();
  for (const parameterSteps of parameterStepsById.values()) {
    const axis = axisById.get(parameterSteps[0].axis_id);
    if (
      axis
      && resolvePerformancePartTrackStrategy(axis.semantic_group)
      && isStagedPartParameterTrackActive(parameterSteps, axis.neutral)
    ) {
      activeAxisIds.add(axis.id);
    }
  }
  return activeAxisIds;
}

function resolvePartTrackStrategy(
  semanticGroup: string,
  active: boolean,
): PerformancePartTrackStrategy {
  if (!active) {
    return "semantic";
  }
  return resolvePerformancePartTrackStrategy(semanticGroup) ?? "semantic";
}
