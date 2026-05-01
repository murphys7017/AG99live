import type {
  DirectParameterPlanTiming,
  SemanticParameterPlan,
} from "../types/protocol";
import { SCHEMA_PARAMETER_PLAN_V2 } from "../types/protocol";
import { isFiniteNumber, isObject, normalizeText } from "../utils/guards";

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

  return {
    duration_ms: Math.round(durationMs),
    blend_in_ms: Math.round(blendInMs),
    hold_ms: Math.round(holdMs),
    blend_out_ms: Math.round(blendOutMs),
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
      schema_version: SCHEMA_PARAMETER_PLAN_V2,
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
