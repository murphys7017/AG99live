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
    return {
      ok: false,
      reason: `semantic_profile_revision_mismatch:${context.intent.profile_revision}:${resolvedProfile.revision}`,
    };
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
  for (const axis of profile.axes) {
    const dynamics = axis.dynamics;
    if (
      !dynamics
      || !Number.isFinite(dynamics.max_velocity)
      || dynamics.max_velocity <= 0
      || !Number.isFinite(dynamics.max_acceleration)
      || dynamics.max_acceleration <= 0
      || !Number.isFinite(dynamics.life_motion_scale)
      || dynamics.life_motion_scale < 0
      || dynamics.life_motion_scale > 1
      || !Number.isFinite(dynamics.max_speech_offset_ratio)
      || dynamics.max_speech_offset_ratio < 0
      || dynamics.max_speech_offset_ratio > 0.5
    ) {
      return `semantic_axis_dynamics_invalid:${axis.id}`;
    }
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
  if (
    intent.schema_version === "engine.motion_intent.v4"
    && !("axis_levels" in intent)
  ) {
    return "motion_sequence_must_compile_at_root";
  }
  const inputAxisCount = intent.schema_version === "engine.motion_intent.v4"
    ? Object.keys(intent.axis_levels ?? {}).length
    : Object.keys(intent.axes).length;
  if (!speechActive && inputAxisCount === 0) {
    return "semantic_intent_axes_empty";
  }
  return "";
}
