import type {
  MotionCompileContext,
  MotionCompileStage,
  MotionStageResult,
} from "./compileContext.js";

export function runCompilePipeline(
  context: MotionCompileContext,
  stages: MotionCompileStage[],
): MotionStageResult {
  for (const stage of stages) {
    const result = stage.run(context);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}
