import type { SemanticParameterPlan } from "../../../types/protocol.js";
import type {
  ModelParameterCompileContext,
  ModelParameterCompileStage,
  ModelParameterStageResult,
} from "../modelParameterCompileContext.js";
import { registerPerformanceParameterNodes } from "../performanceSchedule.js";

// Owns composition of already-generated parameter tracks. Semantic binding
// resolves static targets; this stage attaches the independent speech track.
export const parameterTrackGraphStage: ModelParameterCompileStage = {
  id: "parameterTrackGraph",
  run: runParameterTrackGraphStage,
};

export function runParameterTrackGraphStage(
  context: ModelParameterCompileContext,
): ModelParameterStageResult {
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
