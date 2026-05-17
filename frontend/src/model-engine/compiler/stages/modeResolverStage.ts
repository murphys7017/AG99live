import type { SemanticAxisDefinition } from "../../../types/semantic-axis-profile.js";
import type {
  DynamicAxisValues,
  MotionCompileContext,
  MotionCompileStage,
  MotionStageResult,
} from "../compileContext.js";

// Reads:
// - context.intent.mode
// - context.state.allAxisValues
// - context.state.axisById
// - context.state.warnings
//
// Writes:
// - context.state.resolvedMode
// - context.state.warnings
//
// Does not own:
// - timing
// - parameter generation
export const modeResolverStage: MotionCompileStage = {
  id: "modeResolver",
  run: runModeResolverStage,
};

export function runModeResolverStage(
  context: MotionCompileContext,
): MotionStageResult {
  const idleDeadzone = isSemanticIdleDeadzone(
    context.state.allAxisValues,
    context.state.axisById,
  );

  context.state.resolvedMode =
    context.intent.mode === "idle"
      ? "idle"
      : idleDeadzone
        ? "idle"
        : "expressive";

  if (idleDeadzone && context.intent.mode === "expressive") {
    context.state.warnings = [
      ...context.state.warnings,
      "expressive_intent_resolved_to_idle_deadzone",
    ];
  }

  return { ok: true };
}

function isSemanticIdleDeadzone(
  axisValues: DynamicAxisValues,
  axisById: Map<string, SemanticAxisDefinition>,
): boolean {
  for (const [axisId, value] of Object.entries(axisValues)) {
    const axis = axisById.get(axisId);
    if (!axis) {
      return false;
    }

    const [minSoft, maxSoft] = axis.soft_range;
    if (value < minSoft || value > maxSoft) {
      return false;
    }
  }

  return true;
}
