import { reactive, readonly } from "vue";
import type {
  DirectParameterAxisCalibration,
  DirectParameterAxisName,
  DirectParameterCalibrationProfile,
  DirectParameterPlan,
  ModelSummary,
} from "../types/protocol";

type PreviewPlayerStatus = "idle" | "playing" | "finished" | "failed";

const AXIS_NAMES = [
  "head_yaw",
  "head_roll",
  "head_pitch",
  "body_yaw",
  "body_roll",
  "gaze_x",
  "gaze_y",
  "eye_open_left",
  "eye_open_right",
  "mouth_open",
  "mouth_smile",
  "brow_bias",
] as const satisfies readonly DirectParameterAxisName[];

interface ParsedParameterPlan {
  plan: DirectParameterPlan;
  totalDurationMs: number;
}

interface PlayPlanOptions {
  softHandoff?: boolean;
  targetDurationMs?: number | null;
}

const state = reactive({
  status: "idle" as PreviewPlayerStatus,
  message: "等待播放动作计划。",
  keyAxesCount: 0,
  supplementaryCount: 0,
  startedAt: "",
  finishedAt: "",
});

let activeRunId = 0;
let activeTimerHandles: number[] = [];
let lastStartedPlanSignature = "";
let lastStartedPlanAtMs = 0;

const PLAN_RESTART_DEDUP_WINDOW_MS = 700;
const PLAN_RESTART_GUARD_MS = 180;

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeNullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeRange(
  value: unknown,
): DirectParameterAxisCalibration["recommended_range"] {
  if (!isObject(value)) {
    return null;
  }

  const min = isFiniteNumber(value.min) ? value.min : null;
  const max = isFiniteNumber(value.max) ? value.max : null;
  if (min === null && max === null) {
    return null;
  }

  if (min !== null && max !== null) {
    return min <= max ? { min, max } : { min: max, max: min };
  }

  return { min, max };
}

function normalizeAxisCalibration(
  value: unknown,
): DirectParameterAxisCalibration | null {
  if (!isObject(value)) {
    return null;
  }

  const parameterId = normalizeText(value.parameter_id);
  const parameterIds = Array.isArray(value.parameter_ids)
    ? value.parameter_ids
      .map((item) => normalizeText(item))
      .filter((item) => item.length > 0)
    : [];
  const direction = isFiniteNumber(value.direction)
    ? value.direction
    : typeof value.direction === "string"
      ? normalizeText(value.direction)
      : null;
  const baseline = isFiniteNumber(value.baseline) ? value.baseline : null;
  const recommendedRange = normalizeRange(
    value.recommended_range ?? value.recommended ?? value.recommendedRange,
  );
  const observedRange = normalizeRange(
    value.observed_range ?? value.observed ?? value.observedRange,
  );
  const confidence = normalizeText(value.confidence);
  const source = normalizeText(value.source);
  const recommended = normalizeNullableBoolean(value.recommended);
  const safeToApply = normalizeNullableBoolean(value.safe_to_apply);
  const skipReason = normalizeText(value.skip_reason);

  if (
    !parameterId
    && parameterIds.length === 0
    && direction === null
    && baseline === null
    && !recommendedRange
    && !observedRange
    && !confidence
    && !source
    && recommended === null
    && safeToApply === null
    && !skipReason
  ) {
    return null;
  }

  return {
    parameter_id: parameterId || undefined,
    parameter_ids: parameterIds.length > 0 ? parameterIds : undefined,
    direction: direction ?? undefined,
    baseline,
    recommended_range: recommendedRange,
    observed_range: observedRange,
    confidence: confidence || undefined,
    source: source || undefined,
    recommended: recommended ?? undefined,
    safe_to_apply: safeToApply ?? undefined,
    skip_reason: skipReason || undefined,
  };
}

function normalizeCalibrationProfile(
  value: unknown,
): DirectParameterCalibrationProfile | null {
  if (!isObject(value)) {
    return null;
  }

  const axesPayload = isObject(value.axes)
    ? value.axes
    : isObject(value.axis_calibrations)
      ? value.axis_calibrations
      : value;

  const axes: Partial<Record<DirectParameterAxisName, DirectParameterAxisCalibration | null>> = {};
  let axisCount = 0;

  for (const axisName of AXIS_NAMES) {
    const normalizedAxis = normalizeAxisCalibration(axesPayload[axisName]);
    if (!normalizedAxis) {
      continue;
    }
    axes[axisName] = normalizedAxis;
    axisCount += 1;
  }

  if (axisCount === 0) {
    return null;
  }

  return {
    schema_version: normalizeText(value.schema_version) || undefined,
    axes,
  };
}

function parseParameterPlan(plan: unknown): ParsedParameterPlan | null {
  if (!isObject(plan)) {
    return null;
  }

  if (normalizeText(plan.schema_version) !== "engine.parameter_plan.v1") {
    return null;
  }

  const modeRaw = normalizeText(plan.mode).toLowerCase();
  if (modeRaw !== "expressive" && modeRaw !== "idle") {
    return null;
  }
  const mode = modeRaw as DirectParameterPlan["mode"];

  const timingRaw = plan.timing;
  if (!isObject(timingRaw)) {
    return null;
  }

  const durationMs = timingRaw.duration_ms;
  const blendInMs = timingRaw.blend_in_ms;
  const holdMs = timingRaw.hold_ms;
  const blendOutMs = timingRaw.blend_out_ms;
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

  const keyAxesRaw = plan.key_axes;
  if (!isObject(keyAxesRaw)) {
    return null;
  }

  const keyAxes = {} as DirectParameterPlan["key_axes"];
  for (const axisName of AXIS_NAMES) {
    const axisPayload = keyAxesRaw[axisName];
    if (!isObject(axisPayload) || !isFiniteNumber(axisPayload.value)) {
      return null;
    }
    if (axisPayload.value < 0 || axisPayload.value > 100) {
      return null;
    }
    keyAxes[axisName] = { value: axisPayload.value };
  }

  const supplementaryRaw = plan.supplementary_params;
  if (!Array.isArray(supplementaryRaw)) {
    return null;
  }

  const supplementary: DirectParameterPlan["supplementary_params"] = [];
  for (const item of supplementaryRaw) {
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

  const timing: DirectParameterPlan["timing"] = {
    duration_ms: Math.round(durationMs),
    blend_in_ms: Math.round(blendInMs),
    hold_ms: Math.round(holdMs),
    blend_out_ms: Math.round(blendOutMs),
  };
  const totalDurationMs = Math.max(
    timing.duration_ms,
    timing.blend_in_ms + timing.hold_ms + timing.blend_out_ms,
  );

  const normalizedPlan: DirectParameterPlan = {
    schema_version: "engine.parameter_plan.v1",
    mode,
    emotion_label: normalizeText(plan.emotion_label) || "neutral",
    timing,
    key_axes: keyAxes,
    supplementary_params: supplementary,
    calibration_profile: normalizeCalibrationProfile(plan.calibration_profile),
  };

  return {
    plan: normalizedPlan,
    totalDurationMs,
  };
}

function retimePlanForPlayback(
  parsed: ParsedParameterPlan,
  targetDurationMs: number | null | undefined,
): ParsedParameterPlan {
  if (!isFiniteNumber(targetDurationMs)) {
    return parsed;
  }

  const requestedDurationMs = Math.max(320, Math.min(15000, Math.round(targetDurationMs)));
  if (Math.abs(requestedDurationMs - parsed.totalDurationMs) <= 80) {
    return parsed;
  }

  const sourceTiming = parsed.plan.timing;
  const sourceTotalMs = Math.max(
    parsed.totalDurationMs,
    sourceTiming.blend_in_ms + sourceTiming.hold_ms + sourceTiming.blend_out_ms,
    1,
  );
  const blendInRatio = sourceTiming.blend_in_ms / sourceTotalMs;
  const blendOutRatio = sourceTiming.blend_out_ms / sourceTotalMs;

  let blendInMs = Math.max(60, Math.round(requestedDurationMs * blendInRatio));
  let blendOutMs = Math.max(80, Math.round(requestedDurationMs * blendOutRatio));
  let holdMs = requestedDurationMs - blendInMs - blendOutMs;
  let durationMs = requestedDurationMs;

  if (holdMs < 120) {
    holdMs = 120;
    durationMs = blendInMs + holdMs + blendOutMs;
  }

  const retimedPlan: DirectParameterPlan = {
    ...parsed.plan,
    timing: {
      duration_ms: durationMs,
      blend_in_ms: blendInMs,
      hold_ms: holdMs,
      blend_out_ms: blendOutMs,
    },
  };

  return {
    plan: retimedPlan,
    totalDurationMs: durationMs,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildPlanSignature(plan: DirectParameterPlan): string {
  const normalizedSupplementary = [...plan.supplementary_params]
    .map((item) => ({
      parameter_id: item.parameter_id,
      target_value: Math.round(item.target_value * 10000) / 10000,
      weight: Math.round(item.weight * 10000) / 10000,
      source_atom_id: item.source_atom_id,
      channel: item.channel,
    }))
    .sort((left, right) => {
      if (left.parameter_id !== right.parameter_id) {
        return left.parameter_id.localeCompare(right.parameter_id);
      }
      if (left.channel !== right.channel) {
        return left.channel.localeCompare(right.channel);
      }
      return left.source_atom_id.localeCompare(right.source_atom_id);
    });

  const normalizedAxes: Record<string, number> = {};
  for (const axisName of AXIS_NAMES) {
    normalizedAxes[axisName] = Number(plan.key_axes[axisName]?.value ?? 50);
  }

  return stableStringify({
    schema_version: plan.schema_version,
    mode: plan.mode,
    emotion_label: plan.emotion_label,
    timing: plan.timing,
    key_axes: normalizedAxes,
    supplementary_params: normalizedSupplementary,
  });
}

function clearActiveTimers(): void {
  for (const handle of activeTimerHandles) {
    window.clearTimeout(handle);
  }
  activeTimerHandles = [];
}

function scheduleTimer(runId: number, delayMs: number, fn: () => void): void {
  const timerHandle = window.setTimeout(() => {
    if (runId !== activeRunId) {
      return;
    }
    fn();
  }, Math.max(0, Math.round(delayMs)));
  activeTimerHandles.push(timerHandle);
}

function stopPlan(reason = "stopped"): void {
  activeRunId += 1;
  clearActiveTimers();

  const adapter = window.getLAppAdapter?.();
  if (adapter && typeof adapter.stopDirectParameterPlan === "function") {
    adapter.stopDirectParameterPlan();
  }

  if (state.status === "playing") {
    state.status = "idle";
    state.message = reason === "stopped"
      ? "参数计划已停止。"
      : `参数计划已停止（${reason}）。`;
    state.finishedAt = new Date().toISOString();
  }
}

function playPlan(
  plan: unknown,
  model: ModelSummary | null = null,
  options: PlayPlanOptions = {},
): boolean {
  console.info("[MotionPlayer] playPlan called. plan type:", typeof plan, "plan:", JSON.stringify(plan)?.slice(0, 200));

  const parsed = parseParameterPlan(plan);
  if (!parsed) {
    const reason = "动作计划无效：仅支持 engine.parameter_plan.v1 且必须包含完整 12 轴。";
    console.warn("[MotionPlayer] parse failed:", reason, "plan keys:", plan && typeof plan === "object" ? Object.keys(plan as object) : "N/A");
    state.status = "failed";
    state.message = reason;
    state.finishedAt = new Date().toISOString();
    return false;
  }
  const playbackPlan = retimePlanForPlayback(parsed, options.targetDurationMs);
  console.info(
    "[MotionPlayer] parse OK. mode=",
    playbackPlan.plan.mode,
    "emotion=",
    playbackPlan.plan.emotion_label,
    "axes=",
    AXIS_NAMES.length,
    "supplementary=",
    playbackPlan.plan.supplementary_params.length,
    "targetDurationMs=",
    options.targetDurationMs ?? "N/A",
    "resolvedDurationMs=",
    playbackPlan.totalDurationMs,
    "softHandoff=",
    Boolean(options.softHandoff),
  );

  const planCalibration = normalizeCalibrationProfile(playbackPlan.plan.calibration_profile);
  const modelCalibration = normalizeCalibrationProfile(model?.calibration_profile);

  if (planCalibration) {
    playbackPlan.plan.calibration_profile = planCalibration;
  } else {
    delete playbackPlan.plan.calibration_profile;
  }
  if (modelCalibration) {
    playbackPlan.plan.model_calibration_profile = modelCalibration;
  } else {
    delete playbackPlan.plan.model_calibration_profile;
  }
  const planSignature = buildPlanSignature(playbackPlan.plan);
  const nowMs = performance.now();
  if (options.softHandoff && state.status === "playing") {
    const elapsedSinceLastStartMs = Math.max(0, nowMs - lastStartedPlanAtMs);
    if (
      planSignature === lastStartedPlanSignature
      && elapsedSinceLastStartMs <= PLAN_RESTART_DEDUP_WINDOW_MS
    ) {
      console.info(
        "[MotionPlayer] skip duplicate plan restart. elapsedMs=",
        elapsedSinceLastStartMs,
      );
      return true;
    }
    if (elapsedSinceLastStartMs <= PLAN_RESTART_GUARD_MS) {
      console.info(
        "[MotionPlayer] skip rapid plan restart. elapsedMs=",
        elapsedSinceLastStartMs,
      );
      return true;
    }
  }

  const adapter = window.getLAppAdapter?.();
  if (!adapter || typeof adapter.startDirectParameterPlan !== "function") {
    const reason = "动作计划无法执行：Live2D 运行时未提供 Direct Parameter 接口。";
    console.warn("[MotionPlayer]", reason);
    state.status = "failed";
    state.message = reason;
    state.finishedAt = new Date().toISOString();
    return false;
  }

  activeRunId += 1;
  const runId = activeRunId;
  clearActiveTimers();

  if (!options.softHandoff && typeof adapter.stopDirectParameterPlan === "function") {
    adapter.stopDirectParameterPlan();
  }

  console.info("[MotionPlayer] calling startDirectParameterPlan...");
  const started = adapter.startDirectParameterPlan(playbackPlan.plan);
  console.info("[MotionPlayer] startDirectParameterPlan returned:", started);
  if (!started) {
    const runtimeReason = typeof adapter.getDirectParameterPlanError === "function"
      ? normalizeText(adapter.getDirectParameterPlanError())
      : "";
    const reason = runtimeReason
      ? `动作计划执行失败：${runtimeReason}`
      : "动作计划执行失败：Direct Parameter 计划被运行时拒绝。";
    console.warn("[MotionPlayer]", reason);
    state.status = "failed";
    state.message = reason;
    state.finishedAt = new Date().toISOString();
    return false;
  }

  console.info("[MotionPlayer] plan started successfully. totalDurationMs=", playbackPlan.totalDurationMs);
  lastStartedPlanSignature = planSignature;
  lastStartedPlanAtMs = performance.now();
  state.status = "playing";
  state.message = `正在执行参数计划（mode=${playbackPlan.plan.mode}, emotion=${playbackPlan.plan.emotion_label}）...`;
  state.keyAxesCount = AXIS_NAMES.length;
  state.supplementaryCount = playbackPlan.plan.supplementary_params.length;
  state.startedAt = new Date().toISOString();
  state.finishedAt = "";

  scheduleTimer(runId, playbackPlan.totalDurationMs + 40, () => {
    state.status = "finished";
    state.message = "参数计划执行完成。";
    state.finishedAt = new Date().toISOString();
    activeTimerHandles = [];
  });

  return true;
}

export function usePreviewMotionPlayer() {
  return {
    state: readonly(state),
    playPlan,
    stopPlan,
  };
}
