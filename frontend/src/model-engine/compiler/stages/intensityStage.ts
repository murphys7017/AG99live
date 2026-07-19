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
  const nextWarnings = [...context.state.warnings];

  for (const [axisId, rawValue] of Object.entries(context.state.controlledValues)) {
    const axis = context.state.axisById.get(axisId);
    if (!axis) {
      continue;
    }

    const intensityResult = applySemanticIntensity(
      rawValue,
      axis,
      context.intent.mode,
      context.settings.motionIntensityScale,
      context.state.axisSampling?.sampleBounds[axisId],
    );
    nextControlledValues[axisId] = intensityResult.value;

    if (intensityResult.warning) {
      nextWarnings.push(intensityResult.warning);
      console.warn(
        "[ModelEngine] semantic intensity adjusted:",
        intensityResult.warning,
        {
          axisId,
          inputValue: rawValue,
          outputValue: intensityResult.value,
        },
      );
    }
  }

  replaceControlledAxisValues(context.state, nextControlledValues);
  refreshAllAxisValues(context.state);
  context.state.warnings = nextWarnings;

  return { ok: true };
}

function applySemanticIntensity(
  value: number,
  axis: SemanticAxisDefinition,
  mode: SemanticMotionIntent["mode"],
  motionIntensityScale: number,
  levelBounds?: { min: number; max: number },
): { value: number; warning: string } {
  if (mode !== "expressive") {
    return { value, warning: "" };
  }

  const scaled =
    axis.neutral + (value - axis.neutral) * motionIntensityScale;
  if (levelBounds) {
    const bounded = Math.max(levelBounds.min, Math.min(levelBounds.max, scaled));
    return {
      value: bounded,
      warning: Math.abs(bounded - scaled) > 0.0001
        ? `semantic_intensity_limited_to_level:${axis.id}:${scaled}->${bounded}`
        : "",
    };
  }
  // Range constraints belong to the relation graph stage, which is the single
  // owner of final axis values. Intensity only contributes a candidate.
  return { value: scaled, warning: "" };
}
