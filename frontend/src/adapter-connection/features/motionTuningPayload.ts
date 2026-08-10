import { cloneJson } from "../../utils/cloneJson.js";
import type { DesktopMotionTuningSample } from "../../types/desktop.js";
import type { MotionTuningSampleProtocolPayload } from "../../types/protocol.js";
import { cloneCompiledSemanticMotion } from "../../types/compiledSemanticMotion.js";
import { SCHEMA_MOTION_TUNING_SAMPLE_V2 } from "../../types/protocolSchema.generated.js";

export function serializeMotionTuningSample(
  sample: DesktopMotionTuningSample,
): MotionTuningSampleProtocolPayload {
  return {
    schema_version: SCHEMA_MOTION_TUNING_SAMPLE_V2,
    id: sample.id,
    created_at: sample.createdAt,
    source_record_id: sample.sourceRecordId,
    turn_id: sample.turnId,
    message_id: sample.messageId,
    model_name: sample.modelName,
    profile_id: sample.profileId ?? "",
    profile_revision: sample.profileRevision ?? 0,
    profile_hash: sample.profileHash ?? "",
    transform_version: sample.transformVersion ?? "",
    emotion_label: sample.emotionLabel,
    feedback: sample.feedback,
    tags: [...sample.tags],
    enabled_for_llm_reference: Boolean(sample.enabledForLlmReference),
    original_axes: { ...sample.originalAxes },
    raw_axis_levels: { ...(sample.rawAxisLevels ?? {}) },
    resolved_axes: { ...(sample.resolvedAxes ?? {}) },
    constrained_axes: { ...(sample.constrainedAxes ?? {}) },
    adjusted_axes: sample.adjustedAxes ? { ...sample.adjustedAxes } : undefined,
    compiled_semantic_motion: cloneJson(sample.compiledSemanticMotion),
  };
}

export function normalizeMotionTuningSamplePayload(
  sample: unknown,
): DesktopMotionTuningSample | null {
  if (!sample || typeof sample !== "object") {
    return null;
  }

  const candidate = sample as Partial<MotionTuningSampleProtocolPayload>;
  const schemaVersion = candidate.schema_version === SCHEMA_MOTION_TUNING_SAMPLE_V2
    ? candidate.schema_version
    : "";
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const createdAt = typeof candidate.created_at === "string" ? candidate.created_at.trim() : "";
  const sourceRecordId = typeof candidate.source_record_id === "string"
    ? candidate.source_record_id.trim()
    : "";
  const turnId = typeof candidate.turn_id === "string" ? candidate.turn_id.trim() : "";
  const messageId = typeof candidate.message_id === "string" ? candidate.message_id.trim() : "";
  const modelName = typeof candidate.model_name === "string" ? candidate.model_name.trim() : "";
  const profileId = typeof candidate.profile_id === "string" ? candidate.profile_id.trim() : "";
  const profileRevision = typeof candidate.profile_revision === "number"
    && Number.isFinite(candidate.profile_revision)
    && candidate.profile_revision > 0
    ? Math.round(candidate.profile_revision)
    : 0;
  if (
    !schemaVersion
    || !id
    || !createdAt
    || !sourceRecordId
    || !turnId
    || !messageId
    || !modelName
    || !profileId
    || profileRevision <= 0
  ) {
    return null;
  }

  const compiledSemanticMotion = cloneCompiledSemanticMotion(candidate.compiled_semantic_motion);
  if (!compiledSemanticMotion) {
    return null;
  }

  return {
    schemaVersion,
    id,
    createdAt,
    sourceRecordId,
    turnId,
    messageId,
    modelName,
    profileId,
    profileRevision,
    profileHash: typeof candidate.profile_hash === "string"
      ? candidate.profile_hash.trim()
      : "",
    transformVersion: typeof candidate.transform_version === "string"
      ? candidate.transform_version.trim()
      : "",
    emotionLabel: typeof candidate.emotion_label === "string" && candidate.emotion_label.trim()
      ? candidate.emotion_label.trim()
      : "manual_tuning",
    userText: typeof candidate.user_text === "string"
      ? candidate.user_text.trim()
      : "",
    assistantText: typeof candidate.assistant_text === "string"
      ? candidate.assistant_text.trim()
      : "",
    feedback: typeof candidate.feedback === "string" ? candidate.feedback.trim() : "",
    tags: Array.isArray(candidate.tags)
      ? candidate.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : [],
    enabledForLlmReference: Boolean(candidate.enabled_for_llm_reference),
    originalAxes: normalizeMotionTuningAxisRecord(candidate.original_axes),
    rawAxisLevels: normalizeMotionTuningAxisRecord(candidate.raw_axis_levels),
    resolvedAxes: normalizeMotionTuningAxisRecord(candidate.resolved_axes),
    constrainedAxes: normalizeMotionTuningAxisRecord(candidate.constrained_axes),
    adjustedAxes: candidate.adjusted_axes === undefined
      ? undefined
      : normalizeMotionTuningAxisRecord(candidate.adjusted_axes),
    compiledSemanticMotion,
  };
}

function normalizeMotionTuningAxisRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof key !== "string" || !key.trim()) {
      continue;
    }
    if (typeof item !== "number" || !Number.isFinite(item)) {
      continue;
    }
    result[key.trim()] = item;
  }
  return result;
}
