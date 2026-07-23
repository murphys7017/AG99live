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
// - coupling
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
      context.settings.motionIntensityScale,
    );
  }

  replaceControlledAxisValues(context.state, nextControlledValues);
  refreshAllAxisValues(context.state);

  return { ok: true };
}

function applySemanticIntensity(
  value: number,
  axis: SemanticAxisDefinition,
  mode: SemanticMotionIntent["mode"],
  motionIntensityScale: number,
): number {
  if (mode !== "expressive") {
    return value;
  }

  // Range constraints belong to the relation graph stage, which is the single
  // owner of final axis values. Intensity only contributes a candidate.
  return axis.neutral + (value - axis.neutral) * motionIntensityScale;
}
