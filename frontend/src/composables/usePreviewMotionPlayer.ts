import { reactive, readonly } from "vue";
import type {
  ModelSummary,
  SemanticParameterPlan,
} from "../types/protocol";

type PreviewPlayerStatus = "idle" | "playing" | "finished" | "failed";

interface ParsedParameterPlan {
  plan: SemanticParameterPlan;
  totalDurationMs: number;
}

interface PlayPlanOptions {
  softHandoff?: boolean;
  targetDurationMs?: number | null;
  onStarted?: (plan: SemanticParameterPlan) => void;
}

const state = reactive({
  status: "idle" as PreviewPlayerStatus,
  message: "等待播放动作计划。",
  keyAxesCount: 0,
  parameterCount: 0,
  startedAt: "",
  finishedAt: "",
});

let activeRunId = 0;
let activeTimerHandles: number[] = [];
let lastStartedPlanSignature = "";
let lastStartedPlanAtMs = 0;

const PLAN_RESTART_DEDUP_WINDOW_MS = 700;

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
  if (!isObject(plan) || normalizeText(plan.schema_version) !== "engine.parameter_plan.v2") {
    return null;
  }
  return parseSemanticParameterPlan(plan);
}

function parseSemanticParameterPlan(plan: Record<string, unknown>): ParsedParameterPlan | null {
  const profileId = normalizeText(plan.profile_id);
  const modelId = normalizeText(plan.model_id);
  const profileRevision = plan.profile_revision;
  if (!profileId || !modelId || !isFiniteNumber(profileRevision) || profileRevision <= 0) {
    return null;
  }

  const modeRaw = normalizeText(plan.mode).toLowerCase();
  if (modeRaw !== "expressive" && modeRaw !== "idle") {
    return null;
  }
  const mode = modeRaw as SemanticParameterPlan["mode"];

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

  const parametersRaw = plan.parameters;
  if (!Array.isArray(parametersRaw) || parametersRaw.length === 0) {
    return null;
  }

  const parameterIds = new Set<string>();
  const parameters: SemanticParameterPlan["parameters"] = [];
  for (const item of parametersRaw) {
    if (!isObject(item)) {
      return null;
    }
    const axisId = normalizeText(item.axis_id);
    const parameterId = normalizeText(item.parameter_id);
    const targetValue = item.target_value;
    const weight = item.weight;
    const inputValue = item.input_value;
    if (!axisId || !parameterId || parameterIds.has(parameterId)) {
      return null;
    }
    if (!isFiniteNumber(targetValue) || !isFiniteNumber(weight) || weight < 0 || weight > 1) {
      return null;
    }
    if (inputValue !== undefined && !isFiniteNumber(inputValue)) {
      return null;
    }
    parameterIds.add(parameterId);
    let source: SemanticParameterPlan["parameters"][number]["source"] | undefined;
    if (item.source !== undefined) {
      if (item.source !== "semantic_axis" && item.source !== "coupling" && item.source !== "manual") {
        return null;
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

  const emotionLabel = normalizeText(plan.emotion_label);
  if (!emotionLabel) {
    console.warn("[MotionPlayer] parseSemanticParameterPlan: emotion_label_empty");
    return null;
  }

  const timing: SemanticParameterPlan["timing"] = {
    duration_ms: Math.round(durationMs),
    blend_in_ms: Math.round(blendInMs),
    hold_ms: Math.round(holdMs),
    blend_out_ms: Math.round(blendOutMs),
  };
  const totalDurationMs = Math.max(
    timing.duration_ms,
    timing.blend_in_ms + timing.hold_ms + timing.blend_out_ms,
  );

  return {
    plan: {
      schema_version: "engine.parameter_plan.v2",
      profile_id: profileId,
      profile_revision: Math.round(profileRevision),
      model_id: modelId,
      mode,
      emotion_label: emotionLabel,
      timing,
      parameters,
      diagnostics: isObject(plan.diagnostics)
        ? {
          warnings: Array.isArray(plan.diagnostics.warnings)
            ? plan.diagnostics.warnings.map((item) => normalizeText(item)).filter(Boolean)
            : undefined,
        }
        : undefined,
      summary: isObject(plan.summary)
        ? {
          axis_count: isFiniteNumber(plan.summary.axis_count)
            ? Math.round(plan.summary.axis_count)
            : undefined,
          parameter_count: isFiniteNumber(plan.summary.parameter_count)
            ? Math.round(plan.summary.parameter_count)
            : undefined,
          target_duration_ms: isFiniteNumber(plan.summary.target_duration_ms)
            ? Math.round(plan.summary.target_duration_ms)
            : undefined,
        }
        : undefined,
    },
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
  const blendOutMs = Math.max(80, Math.round(requestedDurationMs * blendOutRatio));
  let holdMs = requestedDurationMs - blendInMs - blendOutMs;
  let durationMs = requestedDurationMs;

  if (holdMs < 120) {
    holdMs = 120;
    durationMs = blendInMs + holdMs + blendOutMs;
  }

  return {
    plan: {
      ...parsed.plan,
      timing: {
        duration_ms: durationMs,
        blend_in_ms: blendInMs,
        hold_ms: holdMs,
        blend_out_ms: blendOutMs,
      },
    },
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

function buildPlanSignature(plan: SemanticParameterPlan): string {
  return stableStringify({
    schema_version: plan.schema_version,
    profile_id: plan.profile_id,
    profile_revision: plan.profile_revision,
    model_id: plan.model_id,
    mode: plan.mode,
    emotion_label: plan.emotion_label,
    timing: plan.timing,
    parameters: plan.parameters.map((item) => ({
      axis_id: item.axis_id,
      parameter_id: item.parameter_id,
      target_value: Math.round(item.target_value * 10000) / 10000,
      weight: Math.round(item.weight * 10000) / 10000,
      input_value: item.input_value === undefined
        ? undefined
        : Math.round(item.input_value * 10000) / 10000,
      source: item.source,
    })).sort((left, right) => left.parameter_id.localeCompare(right.parameter_id)),
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
  _model: ModelSummary | null = null,
  options: PlayPlanOptions = {},
): boolean {
  console.info("[MotionPlayer] playPlan called. plan type:", typeof plan, "plan:", JSON.stringify(plan)?.slice(0, 200));

  const parsed = parseParameterPlan(plan);
  if (!parsed) {
    const reason = "动作计划无效：仅支持 engine.parameter_plan.v2。";
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
    "parameters=",
    playbackPlan.plan.parameters.length,
    "targetDurationMs=",
    options.targetDurationMs ?? "N/A",
    "resolvedDurationMs=",
    playbackPlan.totalDurationMs,
    "softHandoff=",
    Boolean(options.softHandoff),
  );

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
  state.keyAxesCount = playbackPlan.plan.summary?.axis_count ?? playbackPlan.plan.parameters.length;
  state.parameterCount = playbackPlan.plan.parameters.length;
  state.startedAt = new Date().toISOString();
  state.finishedAt = "";

  scheduleTimer(runId, playbackPlan.totalDurationMs + 40, () => {
    state.status = "finished";
    state.message = "参数计划执行完成。";
    state.finishedAt = new Date().toISOString();
    activeTimerHandles = [];
  });

  options.onStarted?.(playbackPlan.plan);
  return true;
}

export function usePreviewMotionPlayer() {
  return {
    state: readonly(state),
    playPlan,
    stopPlan,
  };
}
