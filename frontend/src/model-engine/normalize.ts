import type {
  CatalogMotionPayload,
  DirectParameterPlanTiming,
  SemanticMotionIntent,
  SemanticParameterPlan,
} from "../types/protocol.js";
import {
  SCHEMA_CATALOG_MOTION_V1,
  SCHEMA_MOTION_INTENT_V2,
  SCHEMA_MOTION_INTENT_V3,
  SCHEMA_PARAMETER_PLAN_V2,
} from "../types/protocol.js";
import {
  MAX_MOTION_DURATION_MS,
  MIN_MOTION_DURATION_MS,
} from "./constants.js";
import type { NormalizedMotionPayload } from "./contracts.js";
import { parseSemanticParameterPlan, type ParseResult } from "./planParser.js";
import {
  isFiniteNumber,
  isObject,
  normalizeStringArray,
  normalizeText,
} from "../utils/guards.js";

function normalizeDynamicAxesV2(value: unknown): Record<string, number> | null {
  if (!isObject(value)) {
    return null;
  }

  const axes: Record<string, number> = {};
  for (const [axisId, axisPayload] of Object.entries(value)) {
    const normalizedAxisId = normalizeText(axisId);
    if (!normalizedAxisId || !isObject(axisPayload) || !("value" in axisPayload)) {
      return null;
    }
    const axisValue = axisPayload.value;
    if (!isFiniteNumber(axisValue)) {
      return null;
    }
    axes[normalizedAxisId] = axisValue;
  }

  return Object.keys(axes).length > 0 ? axes : null;
}

function normalizeDynamicAxesV3(value: unknown): Record<string, number> | null {
  if (!isObject(value)) {
    return null;
  }

  const axes: Record<string, number> = {};
  for (const [axisId, axisValue] of Object.entries(value)) {
    const normalizedAxisId = normalizeText(axisId);
    if (!normalizedAxisId || isObject(axisValue) || !isFiniteNumber(axisValue)) {
      return null;
    }
    axes[normalizedAxisId] = axisValue;
  }

  return Object.keys(axes).length > 0 ? axes : null;
}

export function normalizeTurnId(turnId: string | null): string | null {
  const normalized = normalizeText(turnId);
  return normalized || null;
}

function warnNormalizeFailure(reason: string, value: unknown): void {
  console.warn("[ModelEngine] motion payload rejected:", reason, value);
}

function parseSemanticMotionIntent(value: unknown): ParseResult<SemanticMotionIntent> {
  if (!isObject(value)) {
    return { ok: false, reason: "motion_intent_not_object" };
  }

  const schemaVersion = normalizeText(value.schema_version);
  if (schemaVersion !== SCHEMA_MOTION_INTENT_V2 && schemaVersion !== SCHEMA_MOTION_INTENT_V3) {
    return { ok: false, reason: "motion_intent.invalid_schema_version" };
  }

  const profileId = normalizeText(value.profile_id);
  const modelId = normalizeText(value.model_id);
  const profileRevision = value.profile_revision;
  if (!profileId) {
    return { ok: false, reason: "motion_intent.profile_id_empty" };
  }
  if (!modelId) {
    return { ok: false, reason: "motion_intent.model_id_empty" };
  }
  if (!isFiniteNumber(profileRevision) || profileRevision <= 0) {
    return { ok: false, reason: "motion_intent.profile_revision_invalid" };
  }

  const modeRaw = normalizeText(value.mode || "expressive").toLowerCase();
  if (modeRaw !== "idle" && modeRaw !== "expressive") {
    return { ok: false, reason: "motion_intent.invalid_mode" };
  }

  const axes = schemaVersion === SCHEMA_MOTION_INTENT_V3
    ? normalizeDynamicAxesV3(value.axes)
    : normalizeDynamicAxesV2(value.axes);
  if (!axes) {
    return {
      ok: false,
      reason: schemaVersion === SCHEMA_MOTION_INTENT_V3
        ? "motion_intent_v3.invalid_flat_axes"
        : "motion_intent_v2.invalid_axes",
    };
  }

  const emotionLabel = normalizeText(value.emotion_label);
  if (!emotionLabel) {
    return { ok: false, reason: "motion_intent.emotion_label_empty" };
  }

  const durationHintRaw = value.duration_hint_ms;
  let durationHintMs: number | null = null;
  if (durationHintRaw !== undefined && durationHintRaw !== null) {
    if (!isFiniteNumber(durationHintRaw)) {
      return { ok: false, reason: "motion_intent.duration_hint_ms_not_number" };
    }
    if (durationHintRaw < 0) {
      return { ok: false, reason: "motion_intent.duration_hint_ms_negative" };
    }
    durationHintMs = Math.round(durationHintRaw);
    if (durationHintMs < MIN_MOTION_DURATION_MS || durationHintMs > MAX_MOTION_DURATION_MS) {
      return { ok: false, reason: "motion_intent.duration_hint_ms_out_of_range" };
    }
  }

  return {
    ok: true,
    value: {
      schema_version: schemaVersion,
      profile_id: profileId,
      profile_revision: Math.round(profileRevision),
      model_id: modelId,
      mode: modeRaw,
      emotion_label: emotionLabel,
      duration_hint_ms: durationHintMs,
      fallback_pose_id: normalizeText(value.fallback_pose_id) || undefined,
      axes,
      summary: normalizeMotionVisibilitySummary(value.summary),
    },
  };
}

function parseCatalogMotionPayload(value: unknown): ParseResult<CatalogMotionPayload> {
  if (!isObject(value)) {
    return { ok: false, reason: "catalog_motion_v1_not_object" };
  }
  if (normalizeText(value.schema_version) !== SCHEMA_CATALOG_MOTION_V1) {
    return { ok: false, reason: "catalog_motion_v1.invalid_schema_version" };
  }

  const modelId = normalizeText(value.model_id);
  const motionId = normalizeText(value.motion_id);
  const group = normalizeText(value.group);
  const file = normalizeText(value.file);
  if (!modelId) {
    return { ok: false, reason: "catalog_motion_v1.model_id_empty" };
  }
  if (!motionId) {
    return { ok: false, reason: "catalog_motion_v1.motion_id_empty" };
  }
  if (!group) {
    return { ok: false, reason: "catalog_motion_v1.group_empty" };
  }
  if (!file) {
    return { ok: false, reason: "catalog_motion_v1.file_empty" };
  }
  if (!isFiniteNumber(value.index) || value.index < 0) {
    return { ok: false, reason: "catalog_motion_v1.index_invalid" };
  }

  let durationMs: number | null = null;
  if (value.duration_ms !== undefined && value.duration_ms !== null) {
    if (!isFiniteNumber(value.duration_ms)) {
      return { ok: false, reason: "catalog_motion_v1.duration_ms_not_number" };
    }
    durationMs = Math.round(value.duration_ms);
    if (durationMs < MIN_MOTION_DURATION_MS || durationMs > MAX_MOTION_DURATION_MS) {
      return { ok: false, reason: "catalog_motion_v1.duration_ms_out_of_range" };
    }
  }

  let priority = 3;
  if (value.priority !== undefined && value.priority !== null) {
    if (!isFiniteNumber(value.priority)) {
      return { ok: false, reason: "catalog_motion_v1.priority_invalid" };
    }
    priority = Math.max(1, Math.min(5, Math.round(value.priority)));
  }

  return {
    ok: true,
    value: {
      schema_version: SCHEMA_CATALOG_MOTION_V1,
      model_id: modelId,
      motion_id: motionId,
      group,
      index: Math.round(value.index),
      file,
      label: normalizeText(value.label),
      emotion_label: normalizeText(value.emotion_label) || normalizeText(value.label) || motionId,
      duration_ms: durationMs,
      priority,
      summary: isObject(value.summary)
        ? {
          source: normalizeText(value.summary.source) || undefined,
        }
        : undefined,
    },
  };
}

export function normalizeMotionPayload(
  value: unknown,
):
  | { ok: true; payload: NormalizedMotionPayload }
  | { ok: false; reason: string } {
  if (!isObject(value)) {
    warnNormalizeFailure("motion_payload_not_object", value);
    return { ok: false, reason: "motion_payload_not_object" };
  }

  const schemaVersion = normalizeText(value.schema_version);
  if (schemaVersion === SCHEMA_CATALOG_MOTION_V1) {
    const motion = parseCatalogMotionPayload(value);
    if (!motion.ok) {
      warnNormalizeFailure(motion.reason, value);
      return { ok: false, reason: motion.reason };
    }
    return { ok: true, payload: { kind: "catalog_motion", motion: motion.value } };
  }

  if (schemaVersion === SCHEMA_MOTION_INTENT_V2 || schemaVersion === SCHEMA_MOTION_INTENT_V3) {
    const intent = parseSemanticMotionIntent(value);
    if (!intent.ok) {
      warnNormalizeFailure(intent.reason, value);
      return { ok: false, reason: intent.reason };
    }
    return { ok: true, payload: { kind: "semantic_intent", intent: intent.value } };
  }

  if (schemaVersion === SCHEMA_PARAMETER_PLAN_V2) {
    const plan = parseSemanticParameterPlan(value);
    if (!plan.ok) {
      warnNormalizeFailure(plan.reason, value);
      return { ok: false, reason: plan.reason };
    }
    return { ok: true, payload: { kind: "semantic_plan", plan: plan.value } };
  }

  warnNormalizeFailure(
    schemaVersion
      ? `unsupported_motion_payload:${schemaVersion}`
      : "invalid_motion_payload",
    value,
  );
  return {
    ok: false,
    reason: schemaVersion
      ? `unsupported_motion_payload:${schemaVersion}`
      : "invalid_motion_payload",
  };
}

function normalizeMotionVisibilitySummary(value: unknown): SemanticMotionIntent["summary"] {
  if (!isObject(value)) {
    return undefined;
  }
  return {
    axis_count: isFiniteNumber(value.axis_count) ? Math.round(value.axis_count) : undefined,
    active_groups: normalizeStringArray(value.active_groups),
    skeleton_groups: normalizeStringArray(value.skeleton_groups),
    skeleton_groups_present: normalizeStringArray(value.skeleton_groups_present),
    missing_skeleton_groups: normalizeStringArray(value.missing_skeleton_groups),
    max_delta_from_neutral: isFiniteNumber(value.max_delta_from_neutral)
      ? value.max_delta_from_neutral
      : undefined,
    neutralish_axis_count: isFiniteNumber(value.neutralish_axis_count)
      ? Math.round(value.neutralish_axis_count)
      : undefined,
    expressive_axis_count: isFiniteNumber(value.expressive_axis_count)
      ? Math.round(value.expressive_axis_count)
      : undefined,
    neutralish_axes: normalizeStringArray(value.neutralish_axes),
    expressive_axes: normalizeStringArray(value.expressive_axes),
    outside_soft_range_axes: normalizeStringArray(value.outside_soft_range_axes),
    pose_descriptors: normalizeStringArray(value.pose_descriptors),
    skeleton_repair_added_axes: normalizeStringArray(value.skeleton_repair_added_axes),
    skeleton_repair_replaced_axes: normalizeStringArray(value.skeleton_repair_replaced_axes),
  };
}
