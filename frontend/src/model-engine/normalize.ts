import type {
  CatalogMotionPayload,
  DirectParameterPlanTiming,
  PerformanceCurveHint,
  MotionAxisLevel,
  MotionAxisLevelMap,
  SemanticMotionIntent,
  SemanticParameterPlan,
} from "../types/protocol.js";
import {
  SCHEMA_CATALOG_MOTION_V1,
  SCHEMA_MOTION_INTENT_V3,
  SCHEMA_MOTION_INTENT_V4,
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

function normalizeAxisLevelsV4(value: unknown): MotionAxisLevelMap | null {
  if (!isObject(value)) {
    return null;
  }
  const levels: MotionAxisLevelMap = {};
  for (const [axisId, rawLevel] of Object.entries(value)) {
    const normalizedAxisId = normalizeText(axisId);
    if (!normalizedAxisId || typeof rawLevel !== "number" || !Number.isInteger(rawLevel)) {
      return null;
    }
    if (rawLevel < -3 || rawLevel > 3) {
      return null;
    }
    levels[normalizedAxisId] = rawLevel as MotionAxisLevel;
  }
  return Object.keys(levels).length > 0 ? levels : null;
}

function normalizeIntentTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const tags: string[] = [];
  for (const item of value) {
    const tag = normalizeText(item);
    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return tags.length > 0 ? tags.slice(0, 6) : null;
}

const PERFORMANCE_CURVE_SCHEMA_VERSION = "ag99.performance_curve_hint.v1";
const CURVE_FAMILIES = [
  "default",
  "quick_in_hold_soft_out",
  "slow_in_hold_quick_out",
  "pulse_then_settle",
  "soft_breathe",
] as const;
const CURVE_ENTRIES = ["instant", "quick", "soft", "slow"] as const;
const CURVE_HOLDS = ["short", "steady", "long", "breathing"] as const;
const CURVE_EXITS = ["quick", "soft", "slow"] as const;
const CURVE_EMPHASES = ["none", "early", "middle", "late", "punctuated"] as const;
const CURVE_ENERGIES = ["low", "medium", "high", "teasing", "calm"] as const;

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
  if (schemaVersion !== SCHEMA_MOTION_INTENT_V3 && schemaVersion !== SCHEMA_MOTION_INTENT_V4) {
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
  const mode: "idle" | "expressive" = modeRaw;

  const isV4 = schemaVersion === SCHEMA_MOTION_INTENT_V4;
  const axisLevels = isV4 ? normalizeAxisLevelsV4(value.axis_levels) : null;
  if (isV4 && (!axisLevels || Object.prototype.hasOwnProperty.call(value, "axes"))) {
    return { ok: false, reason: "motion_intent_v4.invalid_axis_levels" };
  }
  if (!isV4 && Object.prototype.hasOwnProperty.call(value, "axis_levels")) {
    return { ok: false, reason: "motion_intent_v3.axis_levels_forbidden" };
  }
  const axes = isV4 ? null : normalizeDynamicAxesV3(value.axes);
  if (!isV4 && !axes) {
    return {
      ok: false,
      reason: "motion_intent_v3.invalid_flat_axes",
    };
  }

  const emotionLabel = normalizeText(value.emotion_label);
  if (!emotionLabel) {
    return { ok: false, reason: "motion_intent.emotion_label_empty" };
  }
  const intentTags = normalizeIntentTags(value.intent_tags);
  if (!intentTags) {
    return { ok: false, reason: "motion_intent.intent_tags_empty" };
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

  const rawPerformanceCurveHint = value.performance_curve_hint;
  let performanceCurveHint: PerformanceCurveHint | undefined;
  if (rawPerformanceCurveHint !== undefined) {
    performanceCurveHint = normalizePerformanceCurveHint(rawPerformanceCurveHint);
    if (!performanceCurveHint) {
      return { ok: false, reason: "motion_intent.performance_curve_hint_invalid" };
    }
  }

  const common = {
    profile_id: profileId,
    profile_revision: Math.round(profileRevision),
    model_id: modelId,
    mode,
    intent_tags: intentTags,
    emotion_label: emotionLabel,
    duration_hint_ms: durationHintMs,
    performance_curve_hint: performanceCurveHint,
    summary: normalizeMotionVisibilitySummary(value.summary),
  };
  if (isV4) {
    if (!axisLevels) {
      return { ok: false, reason: "motion_intent_v4.invalid_axis_levels" };
    }
    if (Object.prototype.hasOwnProperty.call(value, "resource_id")) {
      return {
        ok: false,
        reason: "motion_intent_v4.resource_id_forbidden_use_typed_resource_fields",
      };
    }
    const expressionResourceId = normalizeText(value.expression_resource_id) || undefined;
    const motionResourceId = normalizeText(value.motion_resource_id) || undefined;
    if (expressionResourceId && motionResourceId) {
      return { ok: false, reason: "motion_intent_v4.multiple_resource_layers_forbidden" };
    }
    return {
      ok: true,
      value: {
        ...common,
        schema_version: SCHEMA_MOTION_INTENT_V4,
        axis_levels: axisLevels,
        expression_resource_id: expressionResourceId,
        motion_resource_id: motionResourceId,
      },
    };
  }
  if (!axes) {
    return { ok: false, reason: "motion_intent_v3.invalid_flat_axes" };
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "expression_resource_id")
    || Object.prototype.hasOwnProperty.call(value, "motion_resource_id")
  ) {
    return { ok: false, reason: "motion_intent_v3.typed_resource_fields_forbidden" };
  }
  return {
    ok: true,
    value: {
      ...common,
      schema_version: SCHEMA_MOTION_INTENT_V3,
      axes,
      resource_id: normalizeText(value.resource_id) || undefined,
    },
  };
}

export function normalizePerformanceCurveHint(value: unknown): PerformanceCurveHint | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  if (normalizeText(value.schema_version) !== PERFORMANCE_CURVE_SCHEMA_VERSION) {
    return undefined;
  }
  const curveFamily = normalizeEnum(value.curve_family, CURVE_FAMILIES);
  const entry = normalizeEnum(value.entry, CURVE_ENTRIES);
  const hold = normalizeEnum(value.hold, CURVE_HOLDS);
  const exit = normalizeEnum(value.exit, CURVE_EXITS);
  const emphasis = normalizeEnum(value.emphasis, CURVE_EMPHASES);
  const energy = normalizeEnum(value.energy, CURVE_ENERGIES);
  if (!curveFamily || !entry || !hold || !exit || !emphasis || !energy) {
    return undefined;
  }

  return {
    schema_version: PERFORMANCE_CURVE_SCHEMA_VERSION,
    curve_family: curveFamily,
    entry,
    hold,
    exit,
    emphasis,
    energy,
  };
}

function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  const normalized = normalizeText(value).toLowerCase();
  return allowed.includes(normalized as T) ? normalized as T : undefined;
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

  if (schemaVersion === SCHEMA_MOTION_INTENT_V3 || schemaVersion === SCHEMA_MOTION_INTENT_V4) {
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
  };
}
