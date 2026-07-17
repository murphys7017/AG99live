import { onScopeDispose, reactive, readonly } from "vue";
import type {
  CatalogMotionPayload,
  ModelSummary,
  SemanticParameterPlan,
} from "../types/protocol.js";
import { SCHEMA_PARAMETER_PLAN_V2 } from "../types/protocol.js";
import type { DirectParameterPlanTerminalEvent } from "../types/live2d-runtime.d.ts";
import { isObject, normalizeText } from "../utils/guards.js";
import { parseSemanticParameterPlan } from "../model-engine/planParser.js";

type PreviewPlayerStatus = "idle" | "preparing" | "playing" | "finished" | "failed";

interface ParsedParameterPlan {
  plan: SemanticParameterPlan;
  totalDurationMs: number;
}

interface PlayPlanOptions {
  softHandoff?: boolean;
  onStarted?: (plan: SemanticParameterPlan, runId: string) => void;
  onFinished?: (event: DirectParameterPlanTerminalEvent) => void;
}

interface PlayCatalogMotionOptions {
  onStarted?: (motion: CatalogMotionPayload, runId: string) => void;
  onFinished?: (event: DirectParameterPlanTerminalEvent) => void;
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

    if (state.status === "playing" || state.status === "preparing") {
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
    const playbackPlan = parsed;
    console.info(
      "[MotionPlayer] parse OK. mode=",
      playbackPlan.plan.mode,
      "emotion=",
      playbackPlan.plan.emotion_label,
      "parameters=",
      playbackPlan.plan.parameters.length,
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

    const hadActiveDirectPlan = Boolean(activeTerminalRunId);

    if (activeMotionStop) {
      stopActiveCatalogMotion("direct_parameter_plan_replaced");
    }

    const expressionResource = playbackPlan.plan.resource?.kind === "expression"
      ? playbackPlan.plan.resource
      : null;
    if (expressionResource) {
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
        expressionResource.expression_id,
      );
      if (!expressionStarted) {
        const expressionReason = adapter.getExpressionStartError();
        const reason = `表情资源执行失败：${expressionResource.resource_id}`
          + (expressionReason ? `（${expressionReason}）` : "");
        if (!hadActiveDirectPlan) {
          state.status = "failed";
          state.message = reason;
          state.finishedAt = new Date().toISOString();
        }
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
      if (expressionResource) {
        adapter.stopExpression?.();
      }
      const runtimeReason = typeof adapter.getDirectParameterPlanError === "function"
        ? normalizeText(adapter.getDirectParameterPlanError())
        : "";
      const reason = runtimeReason
        ? `动作计划执行失败：${runtimeReason}`
        : "动作计划执行失败：Direct Parameter 计划被运行时拒绝。";
      console.warn("[MotionPlayer]", reason);
      if (hadActiveDirectPlan) {
        adapter.stopDirectParameterPlan?.(
          "direct_parameter_plan_replacement_failed",
          "stopped",
        );
        notifyActiveStopped("direct_parameter_plan_replacement_failed");
      }
      state.status = "failed";
      state.message = reason;
      state.finishedAt = new Date().toISOString();
      return false;
    }

    if (!expressionResource) {
      adapter.stopExpression?.();
    }

    if (options.softHandoff) {
      notifyActiveStopped("direct_parameter_plan_replaced");
    }

    activeRunId += 1;
    const runId = activeRunId;
    clearActiveTimers();

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
        const reason = "direct_parameter_plan_terminal_timeout";
        console.warn(
          "[MotionPlayer] direct parameter plan terminal timeout. runId=",
          playbackRunId,
        );
        adapter.stopDirectParameterPlan?.(reason, "failed");
        if (state.status !== "playing") {
          return;
        }
        state.status = "failed";
        state.message = "参数计划完成事件超时。";
        state.finishedAt = new Date().toISOString();
        clearActiveTimers();
        clearActiveTerminalCallback(playbackRunId);
        options.onFinished?.({
          runId: playbackRunId,
          status: "failed",
          reason,
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
    const catalogDurationMs = motion.duration_ms;
    if (
      typeof catalogDurationMs !== "number"
      || !Number.isFinite(catalogDurationMs)
      || catalogDurationMs <= 0
    ) {
      const reason = `现成 motion 缺少有效 duration_ms：${motion.motion_id}。`;
      state.status = "failed";
      state.message = reason;
      state.finishedAt = new Date().toISOString();
      return false;
    }
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

    const failCatalogMotion = (reason: string) => {
      if (activeRunId !== runId || activeTerminalRunId !== playbackRunId) {
        return;
      }
      activeMotionStop = null;
      state.status = "failed";
      state.message = `现成 motion 执行失败：${motion.motion_id}（${reason}）。`;
      state.finishedAt = new Date().toISOString();
      clearActiveTimers();
      clearActiveTerminalCallback(playbackRunId);
      options.onFinished?.({ runId: playbackRunId, status: "failed", reason });
    };
    const completeCatalogMotion = () => {
      if (activeRunId !== runId || activeTerminalRunId !== playbackRunId) {
        return;
      }
      activeMotionStop = null;
      state.status = "finished";
      state.message = "现成 motion 执行完成。";
      state.finishedAt = new Date().toISOString();
      clearActiveTimers();
      clearActiveTerminalCallback(playbackRunId);
      options.onFinished?.({ runId: playbackRunId, status: "completed" });
    };

    state.status = "preparing";
    state.message = `正在准备现成 motion（${motion.label || motion.motion_id}）...`;
    state.keyAxesCount = 0;
    state.parameterCount = 0;
    state.startedAt = "";
    state.finishedAt = "";
    setActiveTerminalCallback(playbackRunId, options.onFinished);

    const handle = adapter.startMotion(
      motion.group,
      motion.index,
      motion.priority || 3,
      {
        onStarted: () => {
          if (activeRunId !== runId) {
            return;
          }
          state.status = "playing";
          state.message = `正在执行现成 motion（${motion.label || motion.motion_id}）...`;
          state.startedAt = new Date().toISOString();
          activeMotionStop = () => adapter.stopMotion?.();
          scheduleTimer(runId, catalogDurationMs + 800, () => {
            if (state.status === "playing") {
              failCatalogMotion("catalog_motion_terminal_timeout");
              adapter.stopMotion?.();
            }
          });
          options.onStarted?.(motion, playbackRunId);
        },
        onFinished: () => {
          const motionStartError = getMotionStartError();
          if (motionStartError) {
            failCatalogMotion(motionStartError);
            return;
          }
          completeCatalogMotion();
        },
        onFailed: failCatalogMotion,
        onInterrupted: (reason) => {
          if (activeRunId !== runId || activeTerminalRunId !== playbackRunId) {
            return;
          }
          activeMotionStop = null;
          state.status = "idle";
          state.message = `现成 motion 已停止（${reason}）。`;
          state.finishedAt = new Date().toISOString();
          clearActiveTimers();
          clearActiveTerminalCallback(playbackRunId);
          options.onFinished?.({ runId: playbackRunId, status: "stopped", reason });
        },
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
      clearActiveTerminalCallback(playbackRunId);
      return false;
    }
    if (state.status === "preparing") {
      activeMotionStop = () => adapter.stopMotion?.();
      scheduleTimer(runId, 3000, () => {
        if (state.status === "preparing") {
          failCatalogMotion("catalog_motion_start_timeout");
          adapter.stopMotion?.();
        }
      });
    }
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
