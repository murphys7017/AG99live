import type { SemanticMotionIntent } from "../../../types/protocol.js";
import type { SemanticAxisDefinition } from "../../../types/semantic-axis-profile.js";
import type {
  MotionCompileContext,
  MotionCompileStage,
  MotionStageResult,
} from "../compileContext.js";
import { refreshAllAxisValues, replaceControlledAxisValues } from "../compileContext.js";

// Reads:
// - context.intent.mode
// - context.options.source
// - context.settings.motionIntensityScale
// - context.state.axisById
// - context.state.controlledValues
// - context.state.warnings
//
// Writes:
// - context.state.controlledValues
// - context.state.warnings
//
// Does not own:
// - semantic relation resolution
// - mode resolution
// - timing
// - parameter generation
export const intensityStage: MotionCompileStage = {
  id: "intensity",
  run: runIntensityStage,
};

export function runIntensityStage(
  context: MotionCompileContext,
): MotionStageResult {
  const nextControlledValues = { ...context.state.controlledValues };

  for (const [axisId, rawValue] of Object.entries(context.state.controlledValues)) {
    const axis = context.state.axisById.get(axisId);
    if (!axis) {
      continue;
    }

    nextControlledValues[axisId] = applySemanticIntensity(
      rawValue,
      axis,
      context.intent.mode,
      context.options.source,
      context.settings.motionIntensityScale,
      context.options.conversationExpression === true,
    );
    if (nextControlledValues[axisId] !== rawValue) {
      context.baseDiagnostics.intensityApplied = true;
    }
  }

  replaceControlledAxisValues(context.state, nextControlledValues);
  refreshAllAxisValues(context.state);

  return { ok: true };
}

function applySemanticIntensity(
  value: number,
  axis: SemanticAxisDefinition,
  mode: SemanticMotionIntent["mode"],
  source: string | undefined,
  motionIntensityScale: number,
  conversationExpression: boolean,
): number {
  const shouldApplyScale = mode === "expressive" || source === "idle_motion";
  if (!shouldApplyScale) {
    return value;
  }

  // Range constraints belong to the relation graph stage, which is the single
  // owner of final axis values. Intensity only contributes a candidate.
  const offset = value - axis.neutral;
  if (conversationExpression && mode === "expressive") {
    const group = axis.semantic_group;
    if (["head", "gaze", "body", "torso", "shoulder"].includes(group)) {
      const side = offset < 0 ? 0 : 1;
      const travel = Math.abs(axis.value_range[side] - axis.neutral);
      const softTravel = Math.abs(axis.soft_range[side] - axis.neutral);
      const isBody = group === "body" || group === "torso" || group === "shoulder";
      const limit = Math.min(softTravel, 0.35 * travel) * (isBody ? 0.45 : 1);
      const requested = offset * motionIntensityScale;
      // Keep distinct keyframes ordered while approaching the model's speaking range.
      return limit > 0 ? axis.neutral + requested * limit / (limit + Math.abs(requested)) : axis.neutral;
    }
    // Keep facial cues legible without driving a modest smile to the endpoint.
    return axis.neutral + offset * Math.min(1.15, motionIntensityScale);
  }
  return axis.neutral + offset * motionIntensityScale;
}
