import type { SemanticMotionIntent } from "../../../types/protocol.js";
import type { SemanticAxisProfile } from "../../../types/semantic-axis-profile.js";
import type {
  MotionCompileContext,
  MotionCompileStage,
  MotionStageResult,
} from "../compileContext.js";

// Reads:
// - context.intent
// - context.options.model.semantic_axis_profile
// - context.options.speechActive
//
// Writes:
// - context.state.profile
// - context.state.axisById
//
// Does not own:
// - axis filtering
// - warnings
// - timing
// - parameter generation
export const intentValidatorStage: MotionCompileStage = {
  id: "intentValidator",
  run: runIntentValidator,
};

export function runIntentValidator(
  context: MotionCompileContext,
): MotionStageResult {
  const profile = context.options.model.semantic_axis_profile;
  const failureReason = validateProfileForIntent(
    context.intent,
    profile,
    context.options.speechActive === true,
  );
  if (failureReason) {
    return { ok: false, reason: failureReason };
  }

  const resolvedProfile = profile as SemanticAxisProfile;
  context.state.profile = resolvedProfile;
  context.state.axisById = new Map(
    resolvedProfile.axes.map((axis) => [axis.id, axis]),
  );
  if (resolvedProfile.revision !== context.intent.profile_revision) {
    context.state.warnings = [
      ...context.state.warnings,
      `semantic_profile_revision_mismatch:${context.intent.profile_revision}:${resolvedProfile.revision}`,
    ];
  }

  return { ok: true };
}

function validateProfileForIntent(
  intent: SemanticMotionIntent,
  profile: SemanticAxisProfile | null | undefined,
  speechActive: boolean,
): string {
  if (!profile) {
    return "semantic_profile_missing";
  }
  if (profile.profile_id !== intent.profile_id) {
    return `semantic_profile_id_mismatch:${intent.profile_id}`;
  }
  if (profile.model_id !== intent.model_id) {
    return `semantic_profile_model_mismatch:${intent.model_id}`;
  }
  if (!intent.emotion_label.trim()) {
    return "emotion_label_empty";
  }
  if (!speechActive && !Object.keys(intent.axes).length) {
    return "semantic_intent_axes_empty";
  }
  return "";
}
