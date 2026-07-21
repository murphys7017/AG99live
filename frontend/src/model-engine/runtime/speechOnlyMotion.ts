import type {
  ModelSummary,
  NormalizedSemanticMotionIntentV4,
} from "../../types/protocol.js";

export interface SpeechOnlyMotionRequest {
  kind: "speech_only";
  profileId: string;
  profileRevision: number;
  modelId: string;
}

export function buildSpeechOnlyMotionRequest(
  model: ModelSummary | null,
): SpeechOnlyMotionRequest | null {
  const profile = model?.semantic_axis_profile;
  const voiceFollowingProfile = model?.voice_following_profile;
  if (
    !profile
    || !voiceFollowingProfile
    || voiceFollowingProfile.schema_version !== "ag99.voice_following_profile.v2"
    || !Object.values(voiceFollowingProfile.channels ?? {}).some(
      (channel) =>
        typeof channel?.parameter_id === "string"
        && channel.parameter_id.trim().length > 0
        && profile.axes.some(
          (axis) => axis.id === channel.channel
            && axis.parameter_bindings.some(
              (binding) => binding.parameter_id === channel.parameter_id,
            ),
        )
        && typeof channel.amplitude === "number"
        && Number.isFinite(channel.amplitude)
        && channel.amplitude > 0
        && typeof channel.weight === "number"
        && Number.isFinite(channel.weight)
        && channel.weight > 0,
    )
  ) {
    return null;
  }

  return {
    kind: "speech_only",
    profileId: profile.profile_id,
    profileRevision: profile.revision,
    modelId: profile.model_id,
  };
}

// The compiler pipeline currently operates on semantic intent fields. This
// adapter stays inside ModelEngine and never enters protocol normalization.
export function buildSpeechOnlyCompilerIntent(
  request: SpeechOnlyMotionRequest,
): NormalizedSemanticMotionIntentV4 {
  return {
    schema_version: "engine.motion_intent.v4",
    profile_id: request.profileId,
    profile_revision: request.profileRevision,
    model_id: request.modelId,
    mode: "idle",
    emotion_label: "speech",
    intent_tags: ["speech"],
    duration_hint_ms: null,
    axis_levels: {},
  };
}
