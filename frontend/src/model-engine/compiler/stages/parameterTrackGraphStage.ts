import type { SemanticParameterPlan } from "../../../types/protocol.js";
import type {
  ModelParameterCompileContext,
  ModelParameterCompileStage,
  ModelParameterStageResult,
} from "../modelParameterCompileContext.js";
import {
  buildGazeParameterTrack,
  isGazeParameterTrackActive,
} from "../parameterTrackGraphCompiler.js";
import {
  compileGazeTrackTiming,
  registerPerformanceParameterNodes,
} from "../performanceSchedule.js";

// Owns composition of already-generated parameter tracks. Semantic binding
// resolves static targets; this stage projects pose gaze timing and attaches
// the independent speech track. Sequence gaze is projected once by the final
// sequence track graph compiler.
export const parameterTrackGraphStage: ModelParameterCompileStage = {
  id: "parameterTrackGraph",
  run: runParameterTrackGraphStage,
};

export function runParameterTrackGraphStage(
  context: ModelParameterCompileContext,
): ModelParameterStageResult {
  const gazeResult = attachPoseGazeTracks(context);
  if (!gazeResult.ok) {
    return gazeResult;
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

function attachPoseGazeTracks(
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

  let attachedTrackCount = 0;
  for (const axis of context.state.profile.axes) {
    if (axis.semantic_group.trim().toLowerCase() !== "gaze") {
      continue;
    }
    const parameters = parametersByAxis.get(axis.id);
    if (!parameters?.length || !isGazeParameterTrackActive(parameters, axis.neutral)) {
      continue;
    }
    const timing = compileGazeTrackTiming({
      schedule: context.performanceSchedule,
      semanticAxisId: axis.id,
      semanticGroup: axis.semantic_group,
      changedStepIndices: [0],
      blendOutMs: context.semanticMotion.timing.timing.blend_out_ms,
      allowTailExtension: false,
    });
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
      const track = buildGazeParameterTrack(
        [parameter],
        timing.value.parameterEvents,
        axis.neutral,
      );
      if (!track.ok || !track.points) {
        return {
          ok: false,
          reason: track.ok
            ? `parameter_track_graph_gaze_points_missing:${parameter.parameter_id}`
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
      attachedTrackCount += 1;
    }
  }

  if (attachedTrackCount > 0) {
    context.state.warnings = [
      ...context.state.warnings,
      `parameter_track_graph_gaze_tracks:${attachedTrackCount}`,
      "parameter_track_graph_gaze_release:plan_blend",
    ];
  }
  return { ok: true };
}
