import type { NormalizedMotionPayload } from "../contracts.js";
import type {
  ModelSummary,
  SemanticMotionIntent,
} from "../../types/protocol.js";

export function buildSpeechOnlyMotionPayload(
  model: ModelSummary | null,
): Extract<NormalizedMotionPayload, { kind: "semantic_intent" }> | null {
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

  const intent: SemanticMotionIntent = {
    schema_version: "engine.motion_intent.v3",
    profile_id: profile.profile_id,
    profile_revision: profile.revision,
    model_id: profile.model_id,
    mode: "idle",
    emotion_label: "speech",
    duration_hint_ms: null,
    axes: {},
  };
  return {
    kind: "semantic_intent",
    intent,
  };
}
