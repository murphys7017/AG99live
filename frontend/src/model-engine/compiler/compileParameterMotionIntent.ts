import type { SemanticMotionIntent } from "../../types/protocol.js";
import type { CompileOptions, CompileResult } from "./contracts.js";
import { compileModelParameterPlan } from "./compileModelParameterPlan.js";
import { compileSemanticMotion } from "./compileSemanticMotion.js";
import {
  createModelEngineStageRegistry,
  type ModelEngineStageRegistry,
} from "./registry.js";

/** Compiles only axis- or sequence-based intents into a direct parameter plan. */
export function compileParameterMotionIntent(
  intent: Exclude<SemanticMotionIntent, { motion_resource_id: string }>,
  options: CompileOptions,
  stageRegistry: ModelEngineStageRegistry = createModelEngineStageRegistry(),
): CompileResult {
  const semanticResult = compileSemanticMotion(intent, options, stageRegistry);
  if (!semanticResult.ok) {
    return {
      ok: false,
      plan: null,
      reason: semanticResult.reason,
      diagnostics: semanticResult.diagnostics,
      feedback: semanticResult.feedback,
    };
  }
  return compileModelParameterPlan(
    semanticResult.motion,
    options,
    stageRegistry,
  );
}
