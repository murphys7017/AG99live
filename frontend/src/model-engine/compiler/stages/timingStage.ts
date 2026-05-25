import { resolveMotionTiming } from "../../timing.js";
import type {
  MotionCompileContext,
  MotionCompileStage,
  MotionStageResult,
} from "../compileContext.js";

// Reads:
// - context.intent.duration_hint_ms
// - context.options.targetDurationMs
// - context.options.speechActive
// - context.state.resolvedMode
//
// Writes:
// - context.state.timing
//
// Does not own:
// - parameter generation
export const timingStage: MotionCompileStage = {
  id: "timing",
  run: runTimingStage,
};

export function runTimingStage(
  context: MotionCompileContext,
): MotionStageResult {
  context.state.timing = resolveMotionTiming({
    mode: context.state.resolvedMode,
    durationHintMs: context.intent.duration_hint_ms ?? null,
    targetDurationMs: context.options.targetDurationMs ?? null,
    speechActive: context.options.speechActive === true,
  });

  return { ok: true };
}
