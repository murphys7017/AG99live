import { cloneJson } from "../utils/cloneJson";
import type { DesktopMotionTuningSample } from "../types/desktop";
import type { MotionTuningSampleProtocolPayload } from "../types/protocol";
import { SCHEMA_PARAMETER_PLAN_V2 } from "../types/protocol";

export function serializeMotionTuningSample(
  sample: DesktopMotionTuningSample,
): MotionTuningSampleProtocolPayload {
  return {
    id: sample.id,
    created_at: sample.createdAt,
    source_record_id: sample.sourceRecordId,
    model_name: sample.modelName,
    profile_id: sample.profileId ?? "",
    profile_revision: sample.profileRevision ?? 0,
    emotion_label: sample.emotionLabel,
    assistant_text: sample.assistantText,
    feedback: sample.feedback,
    tags: [...sample.tags],
    enabled_for_llm_reference: Boolean(sample.enabledForLlmReference),
    original_axes: { ...sample.originalAxes },
    adjusted_axes: { ...sample.adjustedAxes },
    adjusted_plan: cloneJson(sample.adjustedPlan),
  };
}

export function normalizeMotionTuningSamplePayload(
  sample: unknown,
): DesktopMotionTuningSample | null {
  if (!sample || typeof sample !== "object") {
    return null;
  }

  const candidate = sample as Partial<MotionTuningSampleProtocolPayload>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const createdAt = typeof candidate.created_at === "string" ? candidate.created_at.trim() : "";
  const sourceRecordId = typeof candidate.source_record_id === "string"
    ? candidate.source_record_id.trim()
    : "";
  const modelName = typeof candidate.model_name === "string" ? candidate.model_name.trim() : "";
  const profileId = typeof candidate.profile_id === "string" ? candidate.profile_id.trim() : "";
  const profileRevision = typeof candidate.profile_revision === "number"
    && Number.isFinite(candidate.profile_revision)
    && candidate.profile_revision > 0
    ? Math.round(candidate.profile_revision)
    : 0;
  if (!id || !createdAt || !sourceRecordId || !modelName || !profileId || profileRevision <= 0) {
    return null;
  }

  const adjustedPlan = candidate.adjusted_plan;
  if (
    !adjustedPlan
    || typeof adjustedPlan !== "object"
    || adjustedPlan.schema_version !== SCHEMA_PARAMETER_PLAN_V2
  ) {
    return null;
  }

  return {
    id,
    createdAt,
    sourceRecordId,
    modelName,
    profileId,
    profileRevision,
    emotionLabel: typeof candidate.emotion_label === "string" && candidate.emotion_label.trim()
      ? candidate.emotion_label.trim()
      : "manual_tuning",
    assistantText: typeof candidate.assistant_text === "string"
      ? candidate.assistant_text.trim()
      : "",
    feedback: typeof candidate.feedback === "string" ? candidate.feedback.trim() : "",
    tags: Array.isArray(candidate.tags)
      ? candidate.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : [],
    enabledForLlmReference: Boolean(candidate.enabled_for_llm_reference),
    originalAxes: normalizeMotionTuningAxisRecord(candidate.original_axes),
    adjustedAxes: normalizeMotionTuningAxisRecord(candidate.adjusted_axes),
    adjustedPlan: cloneJson(adjustedPlan),
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

