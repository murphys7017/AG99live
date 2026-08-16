import type { SemanticParameterPlan } from "../../../types/protocol.js";
import type {
  ModelParameterCompileContext,
  ModelParameterCompileStage,
  ModelParameterStageResult,
} from "../modelParameterCompileContext.js";
import {
  buildStagedPartParameterTrack,
  isStagedPartParameterTrackActive,
} from "../parameterTrackGraphCompiler.js";
import {
  compileFaceTrackTiming,
  compileGazeTrackTiming,
  registerPerformanceParameterNodes,
  resolvePerformancePartTrackStrategy,
} from "../performanceSchedule.js";

// Owns composition of already-generated parameter tracks. Semantic binding
// resolves static targets; this stage projects pose part timing and attaches
// the independent speech track. Sequence part timing is projected once by the
// final sequence track graph compiler.
export const parameterTrackGraphStage: ModelParameterCompileStage = {
  id: "parameterTrackGraph",
  run: runParameterTrackGraphStage,
};

export function runParameterTrackGraphStage(
  context: ModelParameterCompileContext,
): ModelParameterStageResult {
  const partTrackResult = attachPosePartTracks(context);
  if (!partTrackResult.ok) {
    return partTrackResult;
  }
  const gestures = Object.entries(context.state.pendingSpeechGestures);
  if (gestures.length === 0) {
    return { ok: true };
  }

  const parametersByAxis = new Map<string, SemanticParameterPlan["parameters"]>();
  for (const parameter of context.state.parameters) {
    const parameters = parametersByAxis.get(parameter.axis_id) ?? [];
    parameters.push(parameter);
    parametersByAxis.set(parameter.axis_id, parameters);
  }

  let attachedTrackCount = 0;
  for (const [axisId, gesture] of gestures) {
    const parameters = parametersByAxis.get(axisId);
    if (!parameters?.length) {
      return {
        ok: false,
        reason: `parameter_track_graph_speech_binding_missing:${axisId}`,
      };
    }
    for (const parameter of parameters) {
      if (parameter.modulation) {
        return {
          ok: false,
          reason: `parameter_track_graph_modulation_conflict:${parameter.parameter_id}`,
        };
      }
      const nodeResult = registerPerformanceParameterNodes(
        context.performanceSchedule,
        gesture.points.map((point, nodeIndex) => ({
          parameterId: parameter.parameter_id,
          axisId,
          trackKind: "speech_modulation" as const,
          nodeIndex,
          eventId: point.eventId,
          atMs: gesture.delayMs + point.at_ms,
          transitionMs: point.transition_ms,
        })),
      );
      if (!nodeResult.ok) {
        return { ok: false, reason: nodeResult.reason };
      }
      parameter.modulation = {
        kind: "speech_gesture_track",
        preset: gesture.preset,
        amplitude: parameter.dynamics.max_speech_offset * gesture.amplitudeRatio,
        direction: 1,
        delay_ms: gesture.delayMs,
        points: gesture.points.map(({ eventId: _eventId, ...point }) => point),
      };
      attachedTrackCount += 1;
    }
  }

  context.state.warnings = [
    ...context.state.warnings,
    `parameter_track_graph_speech_tracks:${attachedTrackCount}`,
  ];
  return { ok: true };
}

function attachPosePartTracks(
  context: ModelParameterCompileContext,
): ModelParameterStageResult {
  if (context.performanceSchedule.semanticSteps.length > 0) {
    return { ok: true };
  }
  const parametersByAxis = new Map<string, SemanticParameterPlan["parameters"]>();
  for (const parameter of context.state.parameters) {
    const parameters = parametersByAxis.get(parameter.axis_id) ?? [];
    parameters.push(parameter);
    parametersByAxis.set(parameter.axis_id, parameters);
  }

  let gazeTrackCount = 0;
  let faceTrackCount = 0;
  for (const axis of context.state.profile.axes) {
    const strategy = resolvePerformancePartTrackStrategy(axis.semantic_group);
    if (!strategy) {
      continue;
    }
    const parameters = parametersByAxis.get(axis.id);
    if (
      !parameters?.length
      || !isStagedPartParameterTrackActive(parameters, axis.neutral)
    ) {
      continue;
    }
    const timingOptions = {
      schedule: context.performanceSchedule,
      semanticAxisId: axis.id,
      semanticGroup: axis.semantic_group,
      changedStepIndices: [0],
      blendOutMs: context.semanticMotion.timing.timing.blend_out_ms,
      allowTailExtension: false,
    } as const;
    const timing = strategy === "gaze"
      ? compileGazeTrackTiming(timingOptions)
      : compileFaceTrackTiming(timingOptions);
    if (!timing.ok) {
      return { ok: false, reason: timing.reason };
    }
    for (const parameter of parameters) {
      if (parameter.keyframes) {
        return {
          ok: false,
          reason: `parameter_track_graph_keyframe_conflict:${parameter.parameter_id}`,
        };
      }
      const track = buildStagedPartParameterTrack(
        [parameter],
        timing.value,
        axis.neutral,
      );
      if (!track.ok || !track.points) {
        return {
          ok: false,
          reason: track.ok
            ? `parameter_track_graph_${strategy}_points_missing:${parameter.parameter_id}`
            : track.reason,
        };
      }
      const nodeResult = registerPerformanceParameterNodes(
        context.performanceSchedule,
        track.points.map((point, nodeIndex) => ({
          parameterId: parameter.parameter_id,
          axisId: axis.id,
          trackKind: "keyframe" as const,
          nodeIndex,
          eventId: timing.value.parameterEvents[nodeIndex].id,
          atMs: point.at_ms,
          transitionMs: point.transition_ms,
        })),
      );
      if (!nodeResult.ok) {
        return { ok: false, reason: nodeResult.reason };
      }
      parameter.keyframes = track.points;
      if (strategy === "gaze") {
        gazeTrackCount += 1;
      } else {
        faceTrackCount += 1;
      }
    }
  }

  if (gazeTrackCount > 0 || faceTrackCount > 0) {
    context.state.warnings = [
      ...context.state.warnings,
      `parameter_track_graph_gaze_tracks:${gazeTrackCount}`,
      `parameter_track_graph_face_tracks:${faceTrackCount}`,
      ...(gazeTrackCount > 0
        ? ["parameter_track_graph_gaze_release:plan_blend"]
        : []),
      ...(faceTrackCount > 0
        ? ["parameter_track_graph_face_release:plan_blend"]
        : []),
    ];
  }
  return { ok: true };
}
