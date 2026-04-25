import type {
  DirectParameterAxisName,
  DirectParameterPlan,
  DirectParameterPlanSupplementaryParam,
  DirectParameterPlanTiming,
} from "../types/protocol";
import { DIRECT_PARAMETER_AXIS_NAMES } from "./constants";
import type { MotionIntent, NormalizedMotionPayload } from "./contracts";

interface ParseFailure {
  ok: false;
  reason: string;
}

interface ParseSuccess<TValue> {
  ok: true;
  value: TValue;
}

type ParseResult<TValue> = ParseFailure | ParseSuccess<TValue>;

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampAxisValue(value: unknown): number {
  try {
    const number = Math.round(Number(value));
    return Math.max(0, Math.min(100, number));
  } catch {
    return 50;
  }
}

function normalizeKeyAxes(
  value: unknown,
): Record<DirectParameterAxisName, { value: number }> | null {
  if (!isObject(value)) {
    return null;
  }

  const keyAxes = {} as Record<DirectParameterAxisName, { value: number }>;
  for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
    const axisPayload = value[axisName];
    if (!isObject(axisPayload) || !("value" in axisPayload)) {
      return null;
    }

    const axisValue = axisPayload.value;
    if (!isFiniteNumber(axisValue)) {
      return null;
    }

    if (axisValue < 0 || axisValue > 100) {
      return null;
    }

    keyAxes[axisName] = { value: clampAxisValue(axisValue) };
  }

  return keyAxes;
}

function normalizeTiming(value: unknown): DirectParameterPlanTiming | null {
  if (!isObject(value)) {
    return null;
  }

  const durationMs = value.duration_ms;
  const blendInMs = value.blend_in_ms;
  const holdMs = value.hold_ms;
  const blendOutMs = value.blend_out_ms;
  if (
    !isFiniteNumber(durationMs)
    || !isFiniteNumber(blendInMs)
    || !isFiniteNumber(holdMs)
    || !isFiniteNumber(blendOutMs)
  ) {
    return null;
  }

  if (durationMs < 0 || blendInMs < 0 || holdMs < 0 || blendOutMs < 0) {
    return null;
  }

  return {
    duration_ms: Math.round(durationMs),
    blend_in_ms: Math.round(blendInMs),
    hold_ms: Math.round(holdMs),
    blend_out_ms: Math.round(blendOutMs),
  };
}

function normalizeSupplementary(
  value: unknown,
): DirectParameterPlanSupplementaryParam[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const supplementary: DirectParameterPlanSupplementaryParam[] = [];
  for (const item of value) {
    if (!isObject(item)) {
      return null;
    }

    const parameterId = normalizeText(item.parameter_id);
    const sourceAtomId = normalizeText(item.source_atom_id);
    const channel = normalizeText(item.channel);
    const targetValue = item.target_value;
    const weight = item.weight;
    if (!parameterId || !sourceAtomId || !channel) {
      return null;
    }
    if (!isFiniteNumber(targetValue) || !isFiniteNumber(weight)) {
      return null;
    }
    if (targetValue < -1 || targetValue > 1 || weight < 0 || weight > 1) {
      return null;
    }

    supplementary.push({
      parameter_id: parameterId,
      target_value: targetValue,
      weight,
      source_atom_id: sourceAtomId,
      channel,
    });
  }

  return supplementary;
}

export function normalizeTurnId(turnId: string | null): string | null {
  const normalized = normalizeText(turnId);
  return normalized || null;
}

function warnNormalizeFailure(reason: string, value: unknown): void {
  console.warn("[ModelEngine] motion payload rejected:", reason, value);
}

function parseMotionIntent(value: unknown): ParseResult<MotionIntent> {
  if (!isObject(value)) {
    return { ok: false, reason: "motion_intent_not_object" };
  }

  if (normalizeText(value.schema_version) !== "engine.motion_intent.v1") {
    return { ok: false, reason: "motion_intent.invalid_schema_version" };
  }

  const modeRaw = normalizeText(value.mode).toLowerCase();
  if (modeRaw !== "idle" && modeRaw !== "expressive") {
    return { ok: false, reason: "motion_intent.invalid_mode" };
  }

  const keyAxes = normalizeKeyAxes(value.key_axes);
  if (!keyAxes) {
    return { ok: false, reason: "motion_intent.invalid_key_axes" };
  }

  const emotionLabel = normalizeText(value.emotion_label);
  if (!emotionLabel) {
    return { ok: false, reason: "motion_intent.emotion_label_empty" };
  }

  const durationHintRaw = value.duration_hint_ms;
  const durationHintMs = isFiniteNumber(durationHintRaw)
    ? Math.max(0, Math.round(durationHintRaw))
    : null;

  return {
    ok: true,
    value: {
      schema_version: "engine.motion_intent.v1",
      mode: modeRaw,
      emotion_label: emotionLabel,
      duration_hint_ms: durationHintMs,
      key_axes: keyAxes,
      summary: isObject(value.summary)
        ? {
          key_axes_count: isFiniteNumber(value.summary.key_axes_count)
            ? Math.round(value.summary.key_axes_count)
            : undefined,
        }
        : undefined,
    },
  };
}

function parseDirectParameterPlan(value: unknown): ParseResult<DirectParameterPlan> {
  if (!isObject(value)) {
    return { ok: false, reason: "parameter_plan_not_object" };
  }

  if (normalizeText(value.schema_version) !== "engine.parameter_plan.v1") {
    return { ok: false, reason: "parameter_plan.invalid_schema_version" };
  }

  const modeRaw = normalizeText(value.mode).toLowerCase();
  if (modeRaw !== "idle" && modeRaw !== "expressive") {
    return { ok: false, reason: "parameter_plan.invalid_mode" };
  }

  const timing = normalizeTiming(value.timing);
  const keyAxes = normalizeKeyAxes(value.key_axes);
  const supplementary = normalizeSupplementary(value.supplementary_params);
  if (!timing || !keyAxes || !supplementary) {
    return { ok: false, reason: "parameter_plan.invalid_body" };
  }

  const emotionLabel = normalizeText(value.emotion_label);
  if (!emotionLabel) {
    return { ok: false, reason: "parameter_plan.emotion_label_empty" };
  }

  return {
    ok: true,
    value: {
      schema_version: "engine.parameter_plan.v1",
      mode: modeRaw,
      emotion_label: emotionLabel,
      timing,
      key_axes: keyAxes,
      supplementary_params: supplementary,
      calibration_profile: isObject(value.calibration_profile)
        ? (value.calibration_profile as DirectParameterPlan["calibration_profile"])
        : undefined,
      model_calibration_profile: isObject(value.model_calibration_profile)
        ? (value.model_calibration_profile as DirectParameterPlan["model_calibration_profile"])
        : undefined,
      summary: isObject(value.summary)
        ? {
          key_axes_count: isFiniteNumber(value.summary.key_axes_count)
            ? Math.round(value.summary.key_axes_count)
            : undefined,
          supplementary_count: isFiniteNumber(value.summary.supplementary_count)
            ? Math.round(value.summary.supplementary_count)
            : undefined,
          target_duration_ms: isFiniteNumber(value.summary.target_duration_ms)
            ? Math.round(value.summary.target_duration_ms)
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
  if (schemaVersion === "engine.motion_intent.v1") {
    const intent = parseMotionIntent(value);
    if (!intent.ok) {
      warnNormalizeFailure(intent.reason, value);
      return { ok: false, reason: intent.reason };
    }
    return { ok: true, payload: { kind: "intent", intent: intent.value } };
  }

  if (schemaVersion === "engine.parameter_plan.v1") {
    const plan = parseDirectParameterPlan(value);
    if (!plan.ok) {
      warnNormalizeFailure(plan.reason, value);
      return { ok: false, reason: plan.reason };
    }
    return { ok: true, payload: { kind: "plan", plan: plan.value } };
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
