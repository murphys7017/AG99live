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
// - context.settings.axisIntensityScale
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
      context.settings.axisIntensityScale[axisId] ?? 1,
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
  axisIntensityScale: number,
): { value: number; warning: string } {
  if (mode !== "expressive") {
    return { value, warning: "" };
  }

  const [minValue, maxValue] = axis.value_range;
  const scaled =
    axis.neutral + (value - axis.neutral) * motionIntensityScale * axisIntensityScale;

  if (scaled < minValue || scaled > maxValue) {
    const clampedValue = Math.max(minValue, Math.min(maxValue, scaled));
    return {
      value: clampedValue,
      warning: `semantic_intensity_clamped:${axis.id}:${scaled}->${clampedValue}`,
    };
  }

  return { value: scaled, warning: "" };
}
