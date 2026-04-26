import type {
  DirectParameterPlanTiming,
  SemanticMotionIntent,
  SemanticParameterPlan,
} from "../types/protocol";
import {
  MAX_MOTION_DURATION_MS,
  MIN_MOTION_DURATION_MS,
} from "./constants";
import type { NormalizedMotionPayload } from "./contracts";

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

  if (normalizeText(value.schema_version) !== "engine.motion_intent.v2") {
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
      schema_version: "engine.motion_intent.v2",
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

function parseSemanticParameterPlan(value: unknown): ParseResult<SemanticParameterPlan> {
  if (!isObject(value)) {
    return { ok: false, reason: "parameter_plan_v2_not_object" };
  }

  if (normalizeText(value.schema_version) !== "engine.parameter_plan.v2") {
    return { ok: false, reason: "parameter_plan_v2.invalid_schema_version" };
  }

  const profileId = normalizeText(value.profile_id);
  const modelId = normalizeText(value.model_id);
  const profileRevision = value.profile_revision;
  if (!profileId || !modelId || !isFiniteNumber(profileRevision) || profileRevision <= 0) {
    return { ok: false, reason: "parameter_plan_v2.invalid_profile_ref" };
  }

  const modeRaw = normalizeText(value.mode).toLowerCase();
  if (modeRaw !== "idle" && modeRaw !== "expressive") {
    return { ok: false, reason: "parameter_plan_v2.invalid_mode" };
  }

  const timing = normalizeTiming(value.timing);
  if (!timing) {
    return { ok: false, reason: "parameter_plan_v2.invalid_timing" };
  }

  const parametersRaw = value.parameters;
  if (!Array.isArray(parametersRaw) || parametersRaw.length === 0) {
    return { ok: false, reason: "parameter_plan_v2.parameters_empty" };
  }

  const parameterIds = new Set<string>();
  const parameters: SemanticParameterPlan["parameters"] = [];
  for (const item of parametersRaw) {
    if (!isObject(item)) {
      return { ok: false, reason: "parameter_plan_v2.parameter_not_object" };
    }
    const axisId = normalizeText(item.axis_id);
    const parameterId = normalizeText(item.parameter_id);
    const targetValue = item.target_value;
    const weight = item.weight;
    const inputValue = item.input_value;
    if (!axisId || !parameterId) {
      return { ok: false, reason: "parameter_plan_v2.parameter_id_empty" };
    }
    if (parameterIds.has(parameterId)) {
      return { ok: false, reason: `parameter_plan_v2.duplicate_parameter:${parameterId}` };
    }
    if (!isFiniteNumber(targetValue) || !isFiniteNumber(weight)) {
      return { ok: false, reason: "parameter_plan_v2.parameter_not_number" };
    }
    if (weight < 0 || weight > 1) {
      return { ok: false, reason: "parameter_plan_v2.weight_out_of_range" };
    }
    if (inputValue !== undefined && !isFiniteNumber(inputValue)) {
      return { ok: false, reason: "parameter_plan_v2.input_value_not_number" };
    }
    parameterIds.add(parameterId);
    let source: SemanticParameterPlan["parameters"][number]["source"] | undefined;
    if (item.source !== undefined) {
      if (item.source !== "semantic_axis" && item.source !== "coupling" && item.source !== "manual") {
        return { ok: false, reason: "parameter_plan_v2.invalid_parameter_source" };
      }
      source = item.source;
    }
    parameters.push({
      axis_id: axisId,
      parameter_id: parameterId,
      target_value: targetValue,
      weight,
      input_value: isFiniteNumber(inputValue) ? inputValue : undefined,
      source,
    });
  }

  const emotionLabel = normalizeText(value.emotion_label);
  if (!emotionLabel) {
    return { ok: false, reason: "parameter_plan_v2.emotion_label_empty" };
  }

  return {
    ok: true,
    value: {
      schema_version: "engine.parameter_plan.v2",
      profile_id: profileId,
      profile_revision: Math.round(profileRevision),
      model_id: modelId,
      mode: modeRaw,
      emotion_label: emotionLabel,
      timing,
      parameters,
      diagnostics: isObject(value.diagnostics)
        ? {
          warnings: Array.isArray(value.diagnostics.warnings)
            ? value.diagnostics.warnings.map((item) => normalizeText(item)).filter(Boolean)
            : undefined,
        }
        : undefined,
      summary: isObject(value.summary)
        ? {
          axis_count: isFiniteNumber(value.summary.axis_count)
            ? Math.round(value.summary.axis_count)
            : undefined,
          parameter_count: isFiniteNumber(value.summary.parameter_count)
            ? Math.round(value.summary.parameter_count)
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
  if (schemaVersion === "engine.motion_intent.v2") {
    const intent = parseSemanticMotionIntent(value);
    if (!intent.ok) {
      warnNormalizeFailure(intent.reason, value);
      return { ok: false, reason: intent.reason };
    }
    return { ok: true, payload: { kind: "semantic_intent", intent: intent.value } };
  }

  if (schemaVersion === "engine.parameter_plan.v2") {
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
