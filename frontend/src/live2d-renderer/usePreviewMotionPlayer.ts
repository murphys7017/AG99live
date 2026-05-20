import { onScopeDispose, reactive, readonly } from "vue";
import type {
  ModelSummary,
  SemanticParameterPlan,
} from "../types/protocol";
import { SCHEMA_PARAMETER_PLAN_V2 } from "../types/protocol";
import { isFiniteNumber, isObject, normalizeText } from "../utils/guards";
import { parseSemanticParameterPlan } from "../model-engine/planParser";

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

export function usePreviewMotionPlayer() {
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

  function parseParameterPlan(plan: unknown): ParsedParameterPlan | null {
    if (!isObject(plan) || normalizeText(plan.schema_version) !== SCHEMA_PARAMETER_PLAN_V2) {
      return null;
    }
    const result = parseSemanticParameterPlan(plan);
    if (!result.ok) {
      if (result.reason === "parameter_plan_v2.emotion_label_empty") {
        console.warn("[MotionPlayer] parseSemanticParameterPlan: emotion_label_empty");
      }
      return null;
    }
    const timing = result.value.timing;
    const totalDurationMs = Math.max(
      timing.duration_ms,
      timing.blend_in_ms + timing.hold_ms + timing.blend_out_ms,
    );
    return {
      plan: result.value,
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

  function playPlan(
    plan: unknown,
    _model: ModelSummary | null = null,
    options: PlayPlanOptions = {},
  ): boolean {
    console.info("[MotionPlayer] playPlan called. plan type:", typeof plan, "plan:", JSON.stringify(plan)?.slice(0, 200));

    const parsed = parseParameterPlan(plan);
    if (!parsed) {
      const reason = `动作计划无效：仅支持 ${SCHEMA_PARAMETER_PLAN_V2}。`;
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
        state.message = `复用当前参数计划（mode=${playbackPlan.plan.mode}, emotion=${playbackPlan.plan.emotion_label}）...`;
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

  onScopeDispose(() => {
    stopPlan("unmount");
  });

  return {
    state: readonly(state),
    playPlan,
    stopPlan,
  };
}
