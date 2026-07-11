import { onScopeDispose, reactive, readonly } from "vue";
import type {
  CatalogMotionPayload,
  ModelSummary,
  SemanticParameterPlan,
} from "../types/protocol.js";
import { SCHEMA_PARAMETER_PLAN_V2 } from "../types/protocol.js";
import type { DirectParameterPlanTerminalEvent } from "../types/live2d-runtime.d.ts";
import { isFiniteNumber, isObject, normalizeText } from "../utils/guards.js";
import { parseSemanticParameterPlan } from "../model-engine/planParser.js";

type PreviewPlayerStatus = "idle" | "playing" | "finished" | "failed";

interface ParsedParameterPlan {
  plan: SemanticParameterPlan;
  totalDurationMs: number;
}

interface PlayPlanOptions {
  softHandoff?: boolean;
  targetDurationMs?: number | null;
  onStarted?: (plan: SemanticParameterPlan, runId?: string) => void;
  onFinished?: (event: DirectParameterPlanTerminalEvent) => void;
}

interface PlayCatalogMotionOptions {
  onStarted?: (motion: CatalogMotionPayload, runId?: string) => void;
  onFinished?: (event: DirectParameterPlanTerminalEvent) => void;
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
  let activeTerminalRunId = "";
  let activeTerminalCallback: ((event: DirectParameterPlanTerminalEvent) => void) | null = null;
  let activeMotionStop: (() => void) | null = null;

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

  function setActiveTerminalCallback(
    runId: string,
    callback: ((event: DirectParameterPlanTerminalEvent) => void) | undefined,
  ): void {
    activeTerminalRunId = runId;
    activeTerminalCallback = callback ?? null;
  }

  function clearActiveTerminalCallback(runId: string): void {
    if (activeTerminalRunId !== runId) {
      return;
    }
    activeTerminalRunId = "";
    activeTerminalCallback = null;
  }

  function notifyActiveStopped(reason: string): void {
    if (!activeTerminalRunId) {
      return;
    }
    const runId = activeTerminalRunId;
    const callback = activeTerminalCallback;
    activeTerminalRunId = "";
    activeTerminalCallback = null;
    callback?.({
      runId,
      status: "stopped",
      reason,
    });
  }

  function stopActiveCatalogMotion(reason: string): void {
    const stop = activeMotionStop;
    activeMotionStop = null;
    stop?.();
    notifyActiveStopped(reason);
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
      adapter.stopDirectParameterPlan(reason, "stopped");
    }
    adapter?.stopExpression?.();
    stopActiveCatalogMotion(reason);
    notifyActiveStopped(reason);

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

    if (activeMotionStop) {
      stopActiveCatalogMotion("direct_parameter_plan_replaced");
    }

    adapter.stopExpression?.();
    if (playbackPlan.plan.resource?.kind === "expression") {
      if (
        typeof adapter.setExpression !== "function"
        || typeof adapter.getExpressionStartError !== "function"
      ) {
        const reason = "表情资源无法执行：Live2D 运行时未提供严格 expression 接口。";
        state.status = "failed";
        state.message = reason;
        state.finishedAt = new Date().toISOString();
        return false;
      }
      const expressionStarted = adapter.setExpression(
        playbackPlan.plan.resource.expression_id,
      );
      if (!expressionStarted) {
        const expressionReason = adapter.getExpressionStartError();
        const reason = `表情资源执行失败：${playbackPlan.plan.resource.resource_id}`
          + (expressionReason ? `（${expressionReason}）` : "");
        state.status = "failed";
        state.message = reason;
        state.finishedAt = new Date().toISOString();
        return false;
      }
    }

    if (!options.softHandoff && typeof adapter.stopDirectParameterPlan === "function") {
      adapter.stopDirectParameterPlan();
      notifyActiveStopped("direct_parameter_plan_replaced");
    }

    console.info("[MotionPlayer] calling startDirectParameterPlan...");
    const playbackRunId = `motion-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const started = adapter.startDirectParameterPlan(playbackPlan.plan, {
      runId: playbackRunId,
      onTerminal: (event: DirectParameterPlanTerminalEvent) => {
        // 校验 runId 避免 stale callback 收错段
        if (event.runId !== playbackRunId) {
          return;
        }
        if (state.status !== "playing") {
          return;
        }
        if (event.status === "stopped") {
          adapter.stopExpression?.();
          // 手动停止不是失败，保持 idle 语义
          state.status = "idle";
          state.message = "参数计划已停止。";
          state.finishedAt = new Date().toISOString();
          clearActiveTimers();
          clearActiveTerminalCallback(playbackRunId);
          options.onFinished?.(event);
          return;
        }
        state.status = event.status === "completed" ? "finished" : "failed";
        adapter.stopExpression?.();
        state.message = event.reason
          || (event.status === "completed"
            ? "参数计划执行完成。"
            : `参数计划执行失败：${event.status}`);
        state.finishedAt = new Date().toISOString();
        clearActiveTimers();
        clearActiveTerminalCallback(playbackRunId);
        options.onFinished?.(event);
      },
    });
    console.info("[MotionPlayer] startDirectParameterPlan returned:", started);
    if (!started) {
      adapter.stopExpression?.();
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

    if (options.softHandoff) {
      notifyActiveStopped("direct_parameter_plan_replaced");
    }

    console.info("[MotionPlayer] plan started successfully. totalDurationMs=", playbackPlan.totalDurationMs);
    state.status = "playing";
    state.message = `正在执行参数计划（mode=${playbackPlan.plan.mode}, emotion=${playbackPlan.plan.emotion_label}）...`;
    state.keyAxesCount = playbackPlan.plan.summary?.axis_count ?? playbackPlan.plan.parameters.length;
    state.parameterCount = playbackPlan.plan.parameters.length;
    state.startedAt = new Date().toISOString();
    state.finishedAt = "";
    setActiveTerminalCallback(playbackRunId, options.onFinished);

    // watchdog：SDK 完成事件的超时保护
    scheduleTimer(runId, playbackPlan.totalDurationMs + 800, () => {
      if (state.status === "playing") {
        console.warn(
          "[MotionPlayer] direct parameter plan terminal timeout. runId=",
          playbackRunId,
        );
        state.status = "failed";
        state.message = "参数计划完成事件超时。";
        state.finishedAt = new Date().toISOString();
        clearActiveTimers();
        clearActiveTerminalCallback(playbackRunId);
        options.onFinished?.({
          runId: playbackRunId,
          status: "failed",
          reason: "direct_parameter_plan_terminal_timeout",
        });
      }
    });

    options.onStarted?.(playbackPlan.plan, playbackRunId);
    return true;
  }

  function playCatalogMotion(
    motion: CatalogMotionPayload,
    _model: ModelSummary | null = null,
    options: PlayCatalogMotionOptions = {},
  ): boolean {
    const adapter = window.getLAppAdapter?.();
    if (
      !adapter
      || typeof adapter.startMotion !== "function"
      || typeof adapter.stopMotion !== "function"
    ) {
      const reason = "现成 motion 无法执行：Live2D 运行时缺少 startMotion 或 stopMotion 接口。";
      console.warn("[MotionPlayer]", reason);
      state.status = "failed";
      state.message = reason;
      state.finishedAt = new Date().toISOString();
      return false;
    }

    activeRunId += 1;
    const runId = activeRunId;
    const playbackRunId = `catalog-motion-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    clearActiveTimers();
    stopActiveCatalogMotion("catalog_motion_replaced");
    adapter.stopExpression?.();
    if (typeof adapter.stopDirectParameterPlan === "function") {
      adapter.stopDirectParameterPlan();
      notifyActiveStopped("catalog_motion_replaced_direct_plan");
    }

    const getMotionStartError = (): string => (
      typeof adapter.getMotionStartError === "function"
        ? adapter.getMotionStartError().trim()
        : ""
    );

    const handle = adapter.startMotion(
      motion.group,
      motion.index,
      motion.priority || 3,
      () => {
        if (activeRunId !== runId) {
          return;
        }
        activeMotionStop = null;
        const motionStartError = getMotionStartError();
        if (motionStartError) {
          const reason = `现成 motion 执行失败：${motion.motion_id}（${motionStartError}）。`;
          console.warn("[MotionPlayer]", reason);
          state.status = "failed";
          state.message = reason;
          state.finishedAt = new Date().toISOString();
          clearActiveTimers();
          clearActiveTerminalCallback(playbackRunId);
          options.onFinished?.({
            runId: playbackRunId,
            status: "failed",
            reason,
          });
          return;
        }
        state.status = "finished";
        state.message = "现成 motion 执行完成。";
        state.finishedAt = new Date().toISOString();
        clearActiveTimers();
        clearActiveTerminalCallback(playbackRunId);
        options.onFinished?.({
          runId: playbackRunId,
          status: "completed",
        });
      },
    );
    if (handle === -1) {
      const motionStartError = getMotionStartError();
      const reason = motionStartError
        ? `现成 motion 执行失败：${motion.motion_id}（${motionStartError}）。`
        : `现成 motion 执行失败：${motion.motion_id}。`;
      console.warn("[MotionPlayer]", reason);
      state.status = "failed";
      state.message = reason;
      state.finishedAt = new Date().toISOString();
      return false;
    }

    state.status = "playing";
    state.message = `正在执行现成 motion（${motion.label || motion.motion_id}）...`;
    state.keyAxesCount = 0;
    state.parameterCount = 0;
    state.startedAt = new Date().toISOString();
    state.finishedAt = "";
    setActiveTerminalCallback(playbackRunId, options.onFinished);
    activeMotionStop = typeof adapter.stopMotion === "function"
      ? () => adapter.stopMotion?.()
      : null;
    options.onStarted?.(motion, playbackRunId);
    return true;
  }

  onScopeDispose(() => {
    stopPlan("unmount");
  });

  return {
    state: readonly(state),
    playPlan,
    playCatalogMotion,
    stopPlan,
  };
}
