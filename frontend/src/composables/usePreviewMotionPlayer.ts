import { reactive, readonly } from "vue";
import type { ModelSummary } from "../types/protocol";

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
] as const;

type AxisName = (typeof AXIS_NAMES)[number];

interface ParameterAxisValue {
  value: number;
}

interface SupplementaryParam {
  parameter_id: string;
  target_value: number;
  weight: number;
  source_atom_id: string;
  channel: string;
}

interface ParameterPlanTiming {
  duration_ms: number;
  blend_in_ms: number;
  hold_ms: number;
  blend_out_ms: number;
}

interface ParameterPlan {
  schema_version: "engine.parameter_plan.v1";
  mode: "expressive" | "idle";
  emotion_label: string;
  timing: ParameterPlanTiming;
  key_axes: Record<AxisName, ParameterAxisValue>;
  supplementary_params: SupplementaryParam[];
}

interface ParsedParameterPlan {
  plan: ParameterPlan;
  totalDurationMs: number;
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

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  const mode = modeRaw as ParameterPlan["mode"];

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

  const keyAxes = {} as Record<AxisName, ParameterAxisValue>;
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

  const supplementary: SupplementaryParam[] = [];
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

  const timing: ParameterPlanTiming = {
    duration_ms: Math.round(durationMs),
    blend_in_ms: Math.round(blendInMs),
    hold_ms: Math.round(holdMs),
    blend_out_ms: Math.round(blendOutMs),
  };
  const totalDurationMs = Math.max(
    timing.duration_ms,
    timing.blend_in_ms + timing.hold_ms + timing.blend_out_ms,
  );

  const normalizedPlan: ParameterPlan = {
    schema_version: "engine.parameter_plan.v1",
    mode,
    emotion_label: normalizeText(plan.emotion_label) || "neutral",
    timing,
    key_axes: keyAxes,
    supplementary_params: supplementary,
  };

  return {
    plan: normalizedPlan,
    totalDurationMs,
  };
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

function playPlan(plan: unknown, _model: ModelSummary | null = null): boolean {
  const parsed = parseParameterPlan(plan);
  if (!parsed) {
    state.status = "failed";
    state.message = "动作计划无效：仅支持 engine.parameter_plan.v1 且必须包含完整 12 轴。";
    state.finishedAt = new Date().toISOString();
    return false;
  }

  const adapter = window.getLAppAdapter?.();
  if (!adapter || typeof adapter.startDirectParameterPlan !== "function") {
    state.status = "failed";
    state.message = "动作计划无法执行：Live2D 运行时未提供 Direct Parameter 接口。";
    state.finishedAt = new Date().toISOString();
    return false;
  }

  activeRunId += 1;
  const runId = activeRunId;
  clearActiveTimers();

  if (typeof adapter.stopDirectParameterPlan === "function") {
    adapter.stopDirectParameterPlan();
  }

  const started = adapter.startDirectParameterPlan(parsed.plan);
  if (!started) {
    state.status = "failed";
    state.message = "动作计划执行失败：Direct Parameter 计划被运行时拒绝。";
    state.finishedAt = new Date().toISOString();
    return false;
  }

  state.status = "playing";
  state.message = `正在执行参数计划（mode=${parsed.plan.mode}, emotion=${parsed.plan.emotion_label}）...`;
  state.keyAxesCount = AXIS_NAMES.length;
  state.supplementaryCount = parsed.plan.supplementary_params.length;
  state.startedAt = new Date().toISOString();
  state.finishedAt = "";

  scheduleTimer(runId, parsed.totalDurationMs + 40, () => {
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
