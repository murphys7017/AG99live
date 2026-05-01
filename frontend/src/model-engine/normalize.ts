import type {
  DirectParameterPlanTiming,
  SemanticMotionIntent,
  SemanticParameterPlan,
} from "../types/protocol";
import {
  SCHEMA_MOTION_INTENT_V2,
  SCHEMA_PARAMETER_PLAN_V2,
} from "../types/protocol";
import {
  MAX_MOTION_DURATION_MS,
  MIN_MOTION_DURATION_MS,
} from "./constants";
import type { NormalizedMotionPayload } from "./contracts";
import { parseSemanticParameterPlan, type ParseResult } from "./planParser";
import { isFiniteNumber, isObject, normalizeText } from "../utils/guards";

function normalizeDynamicAxes(value: unknown): Record<string, { value: number }> | null {
  if (!isObject(value)) {
    return null;
  }

  const axes: Record<string, { value: number }> = {};
  for (const [axisId, axisPayload] of Object.entries(value)) {
    const normalizedAxisId = normalizeText(axisId);
    if (!normalizedAxisId || !isObject(axisPayload) || !("value" in axisPayload)) {
      return null;
    }
    const axisValue = axisPayload.value;
    if (!isFiniteNumber(axisValue)) {
      return null;
    }
    axes[normalizedAxisId] = { value: axisValue };
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
    return { ok: false, reason: "motion_intent_v2_not_object" };
  }

  if (normalizeText(value.schema_version) !== SCHEMA_MOTION_INTENT_V2) {
    return { ok: false, reason: "motion_intent_v2.invalid_schema_version" };
  }

  const profileId = normalizeText(value.profile_id);
  const modelId = normalizeText(value.model_id);
  const profileRevision = value.profile_revision;
  if (!profileId) {
    return { ok: false, reason: "motion_intent_v2.profile_id_empty" };
  }
  if (!modelId) {
    return { ok: false, reason: "motion_intent_v2.model_id_empty" };
  }
  if (!isFiniteNumber(profileRevision) || profileRevision <= 0) {
    return { ok: false, reason: "motion_intent_v2.profile_revision_invalid" };
  }

  const modeRaw = normalizeText(value.mode).toLowerCase();
  if (modeRaw !== "idle" && modeRaw !== "expressive") {
    return { ok: false, reason: "motion_intent_v2.invalid_mode" };
  }

  const axes = normalizeDynamicAxes(value.axes);
  if (!axes) {
    return { ok: false, reason: "motion_intent_v2.invalid_axes" };
  }

  const emotionLabel = normalizeText(value.emotion_label);
  if (!emotionLabel) {
    return { ok: false, reason: "motion_intent_v2.emotion_label_empty" };
  }

  const durationHintRaw = value.duration_hint_ms;
  let durationHintMs: number | null = null;
  if (durationHintRaw !== undefined && durationHintRaw !== null) {
    if (!isFiniteNumber(durationHintRaw)) {
      return { ok: false, reason: "motion_intent_v2.duration_hint_ms_not_number" };
    }
    if (durationHintRaw < 0) {
      return { ok: false, reason: "motion_intent_v2.duration_hint_ms_negative" };
    }
    durationHintMs = Math.round(durationHintRaw);
    if (durationHintMs < MIN_MOTION_DURATION_MS || durationHintMs > MAX_MOTION_DURATION_MS) {
      return { ok: false, reason: "motion_intent_v2.duration_hint_ms_out_of_range" };
    }
  }

  return {
    ok: true,
    value: {
      schema_version: SCHEMA_MOTION_INTENT_V2,
      profile_id: profileId,
      profile_revision: Math.round(profileRevision),
      model_id: modelId,
      mode: modeRaw,
      emotion_label: emotionLabel,
      duration_hint_ms: durationHintMs,
      axes,
      summary: isObject(value.summary)
        ? {
          axis_count: isFiniteNumber(value.summary.axis_count)
            ? Math.round(value.summary.axis_count)
            : undefined,
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
  if (schemaVersion === SCHEMA_MOTION_INTENT_V2) {
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
