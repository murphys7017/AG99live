import type {
  CatalogMotionPayload,
  DirectParameterPlanTiming,
  PerformanceCurvePresetName,
  SemanticParameterPlan,
  SemanticPlanResource,
} from "../types/protocol.js";
import {
  SCHEMA_PARAMETER_PLAN_V2,
  isSemanticParameterPlanSource,
} from "../types/protocol.js";
import {
  isFiniteNumber,
  isObject,
  normalizeStringArray,
  normalizeText,
} from "../utils/guards.js";

interface ParseFailure {
  ok: false;
  reason: string;
}

interface ParseSuccess<TValue> {
  ok: true;
  value: TValue;
}

export type ParseResult<TValue> = ParseFailure | ParseSuccess<TValue>;

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

  const curvePreset = value.curve_preset;
  const validCurvePresets: readonly PerformanceCurvePresetName[] = [
    "smooth_hold",
    "snap_hold_soft_release",
    "slow_build_quick_release",
    "pulse_settle",
    "breathing_swell",
  ];
  if (curvePreset !== undefined && (
    typeof curvePreset !== "string"
    || !validCurvePresets.includes(curvePreset as PerformanceCurvePresetName)
  )) {
    return null;
  }

  return {
    duration_ms: Math.round(durationMs),
    blend_in_ms: Math.round(blendInMs),
    hold_ms: Math.round(holdMs),
    blend_out_ms: Math.round(blendOutMs),
    curve_preset: curvePreset as PerformanceCurvePresetName | undefined,
  };
}

function normalizePlanResource(value: unknown): SemanticPlanResource | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isObject(value)) {
    return null;
  }
  const resourceId = normalizeText(value.resource_id);
  const parameterIds = normalizeStringArray(value.parameter_ids) ?? [];
  if (!resourceId || parameterIds.length === 0) {
    return null;
  }
  if (value.kind === "expression") {
    const expressionId = normalizeText(value.expression_id);
    return expressionId
      ? {
          kind: "expression",
          resource_id: resourceId,
          expression_id: expressionId,
          parameter_ids: parameterIds,
        }
      : null;
  }
  if (value.kind === "motion" && isObject(value.motion)) {
    const motion = normalizeCatalogMotion(value.motion);
    return motion
      ? {
          kind: "motion",
          resource_id: resourceId,
          parameter_ids: parameterIds,
          motion,
        }
      : null;
  }
  return null;
}

function normalizeCatalogMotion(value: Record<string, unknown>): CatalogMotionPayload | null {
  const modelId = normalizeText(value.model_id);
  const motionId = normalizeText(value.motion_id);
  const group = normalizeText(value.group);
  const file = normalizeText(value.file);
  if (
    normalizeText(value.schema_version) !== "engine.catalog_motion.v1"
    || !modelId
    || !motionId
    || !group
    || !file
    || !isFiniteNumber(value.index)
    || value.index < 0
    || !isFiniteNumber(value.priority)
  ) {
    return null;
  }
  return {
    schema_version: "engine.catalog_motion.v1",
    model_id: modelId,
    motion_id: motionId,
    group,
    index: Math.round(value.index),
    file,
    label: normalizeText(value.label),
    emotion_label: normalizeText(value.emotion_label) || motionId,
    duration_ms: isFiniteNumber(value.duration_ms) ? Math.round(value.duration_ms) : null,
    priority: Math.round(value.priority),
    summary: isObject(value.summary)
      ? { source: normalizeText(value.summary.source) || undefined }
      : undefined,
  };
}

export function parseSemanticParameterPlan(
  value: unknown,
): ParseResult<SemanticParameterPlan> {
  if (!isObject(value)) {
    return { ok: false, reason: "parameter_plan_v2_not_object" };
  }

  if (normalizeText(value.schema_version) !== SCHEMA_PARAMETER_PLAN_V2) {
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
      if (!isSemanticParameterPlanSource(item.source)) {
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
      modulation: isObject(item.modulation)
        && normalizeText(item.modulation.kind) === "speech_pose_cycle"
        && isFiniteNumber(item.modulation.neutral)
        && isFiniteNumber(item.modulation.amplitude)
        && isFiniteNumber(item.modulation.phase)
        ? {
          kind: "speech_pose_cycle",
          neutral: Number(item.modulation.neutral),
          amplitude: Number(item.modulation.amplitude),
          phase: Number(item.modulation.phase),
          frequency_hz: isFiniteNumber(item.modulation.frequency_hz)
            && item.modulation.frequency_hz > 0
            ? Number(item.modulation.frequency_hz)
            : undefined,
          direction: item.modulation.direction === -1 ? -1 : 1,
        }
        : undefined,
    });
  }

  const emotionLabel = normalizeText(value.emotion_label);
  if (!emotionLabel) {
    return { ok: false, reason: "parameter_plan_v2.emotion_label_empty" };
  }

  const resource = normalizePlanResource(value.resource);
  if (resource === null) {
    return { ok: false, reason: "parameter_plan_v2.resource_invalid" };
  }
  if (resource?.kind === "expression") {
    const planParameterIds = new Set(parameters.map((item) => item.parameter_id));
    const conflicts = resource.parameter_ids.filter((parameterId) =>
      planParameterIds.has(parameterId),
    );
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason: `parameter_plan_v2.expression_resource_conflict:${conflicts.join(",")}`,
      };
    }
  }

  return {
    ok: true,
    value: {
      schema_version: SCHEMA_PARAMETER_PLAN_V2,
      profile_id: profileId,
      profile_revision: Math.round(profileRevision),
      model_id: modelId,
      mode: modeRaw,
      emotion_label: emotionLabel,
      resource,
      timing,
      parameters,
      diagnostics: isObject(value.diagnostics)
        ? {
          warnings: Array.isArray(value.diagnostics.warnings)
            ? value.diagnostics.warnings.map((item) => normalizeText(item)).filter(Boolean)
            : undefined,
        }
        : undefined,
      summary: normalizePlanSummary(value.summary),
    },
  };
}

export function cloneSemanticParameterPlan(plan: unknown): SemanticParameterPlan | null {
  const result = parseSemanticParameterPlan(plan);
  if (!result.ok) {
    return null;
  }
  const parsed = result.value;
  const planObj = plan as Record<string, unknown>;
  return {
    ...planObj,
    schema_version: parsed.schema_version,
    profile_id: parsed.profile_id,
    profile_revision: parsed.profile_revision,
    model_id: parsed.model_id,
    mode: parsed.mode,
    emotion_label: parsed.emotion_label,
    resource: parsed.resource,
    timing: parsed.timing,
    parameters: parsed.parameters,
    diagnostics: isObject(planObj.diagnostics)
      ? { ...planObj.diagnostics, warnings: parsed.diagnostics?.warnings }
      : parsed.diagnostics,
    summary: isObject(planObj.summary)
      ? { ...planObj.summary, ...parsed.summary }
      : parsed.summary,
  } as SemanticParameterPlan;
}

function normalizePlanSummary(value: unknown): SemanticParameterPlan["summary"] {
  if (!isObject(value)) {
    return undefined;
  }
  return {
    axis_count: isFiniteNumber(value.axis_count)
      ? Math.round(value.axis_count)
      : undefined,
    parameter_count: isFiniteNumber(value.parameter_count)
      ? Math.round(value.parameter_count)
      : undefined,
    target_duration_ms: isFiniteNumber(value.target_duration_ms)
      ? Math.round(value.target_duration_ms)
      : undefined,
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
