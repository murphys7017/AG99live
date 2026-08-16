import { reactive, readonly } from "vue";
import type {
  CatalogMotionPayload,
  ModelSummary,
  SemanticParameterPlan,
} from "../types/protocol.js";
import { SCHEMA_PARAMETER_PLAN_V3 } from "../types/protocol.js";
import type {
  DirectParameterPlanTerminalEvent,
  MotionPlaybackStartResult,
} from "../types/live2d-runtime.d.ts";
import { isObject, normalizeText } from "../utils/guards.js";
import { parseSemanticParameterPlan } from "../model-engine/planParser.js";
import type { MotionPlaybackClockReader } from "../model-engine/contracts.js";

type PreviewPlayerStatus = "idle" | "preparing" | "playing" | "finished" | "failed";

interface ParsedParameterPlan {
  plan: SemanticParameterPlan;
  totalDurationMs: number;
}

interface PlayPlanOptions {
  playbackClockReader?: MotionPlaybackClockReader | null;
  requiresPlaybackClock?: boolean;
  onStarted?: (plan: SemanticParameterPlan, runId: string) => void;
  onFinished?: (event: DirectParameterPlanTerminalEvent) => void;
}

interface PlayCatalogMotionOptions {
  playbackClockReader?: MotionPlaybackClockReader | null;
  requiresPlaybackClock?: boolean;
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

  let activeDirectPlanRunId = "";
  let activeCatalogMotionRunId = "";
  let activeMotionStop: ((reason: string) => void) | null = null;

  function parseParameterPlan(plan: unknown): ParsedParameterPlan | null {
    if (!isObject(plan) || normalizeText(plan.schema_version) !== SCHEMA_PARAMETER_PLAN_V3) {
      return null;
    }
    const result = parseSemanticParameterPlan(plan);
    if (!result.ok) {
      if (result.reason === "parameter_plan_v3.emotion_label_empty") {
        console.warn("[MotionPlayer] parseSemanticParameterPlan: emotion_label_empty");
      }
      return null;
    }
    const timing = result.value.timing;
    return {
      plan: result.value,
      totalDurationMs: timing.duration_ms,
    };
  }

  function stopActiveCatalogMotion(reason: string): void {
    if (!activeCatalogMotionRunId) {
      if (activeMotionStop) {
        throw new Error("catalog_motion_run_owner_missing");
      }
      return;
    }
    const stop = activeMotionStop;
    if (!stop) {
      throw new Error("catalog_motion_stop_owner_missing");
    }
    activeMotionStop = null;
    try {
      stop(reason);
    } catch (error) {
      if (activeCatalogMotionRunId) {
        activeMotionStop = stop;
      }
      throw error;
    }
    if (activeCatalogMotionRunId) {
      activeMotionStop = stop;
      throw new Error("catalog_motion_stop_not_settled");
    }
  }

  function stopPlan(reason = "stopped"): void {
    const adapter = window.getLAppAdapter?.();
    const stopErrors: unknown[] = [];
    const directPlanRunId = activeDirectPlanRunId;
    if (directPlanRunId) {
      try {
        if (!adapter || typeof adapter.stopDirectParameterPlan !== "function") {
          throw new Error("direct_parameter_plan_stop_api_unavailable");
        }
        adapter.stopDirectParameterPlan(reason, "stopped");
        if (activeDirectPlanRunId === directPlanRunId) {
          throw new Error("direct_parameter_plan_stop_not_settled");
        }
      } catch (error) {
        console.error("[MotionPlayer] direct parameter plan stop failed.", error);
        stopErrors.push(error);
      }
    }
    try {
      stopActiveCatalogMotion(reason);
    } catch (error) {
      console.error("[MotionPlayer] catalog motion stop failed.", error);
      stopErrors.push(error);
    }
    if (stopErrors.length > 0) {
      state.status = "failed";
      state.message = `动作停止失败（${reason}）。`;
      state.finishedAt = new Date().toISOString();
      throw stopErrors[0];
    }
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
  ): MotionPlaybackStartResult {
    console.info("[MotionPlayer] playPlan called. plan type:", typeof plan, "plan:", JSON.stringify(plan)?.slice(0, 200));
    const hadActivePlayback = Boolean(activeDirectPlanRunId || activeCatalogMotionRunId);

    const parsed = parseParameterPlan(plan);
    if (!parsed) {
      const reason = `动作计划无效：仅支持 ${SCHEMA_PARAMETER_PLAN_V3}。`;
      console.warn("[MotionPlayer] parse failed:", reason, "plan keys:", plan && typeof plan === "object" ? Object.keys(plan as object) : "N/A");
      if (!hadActivePlayback) {
        state.status = "failed";
        state.message = reason;
        state.finishedAt = new Date().toISOString();
      }
      return { status: "rejected", reason: "parameter_plan_v3_invalid" };
    }
    const playbackPlan = parsed;
    const manualPreviewStartedAtMs = performance.now();
    const playbackClockReader = options.playbackClockReader ?? (
      options.requiresPlaybackClock
        ? null
        : { getElapsedMs: () => performance.now() - manualPreviewStartedAtMs }
    );
    if (!playbackClockReader) {
      const reason = "动作计划无法执行：会话 Timeline 时钟缺失。";
      if (!hadActivePlayback) {
        state.status = "failed";
        state.message = reason;
        state.finishedAt = new Date().toISOString();
      }
      console.error("[MotionPlayer]", reason);
      return { status: "rejected", reason: "parameter_plan_clock_missing" };
    }
    console.info(
      "[MotionPlayer] parse OK. mode=",
      playbackPlan.plan.mode,
      "emotion=",
      playbackPlan.plan.emotion_label,
      "parameters=",
      playbackPlan.plan.parameters.length,
      "resolvedDurationMs=",
      playbackPlan.totalDurationMs,
    );

    const adapter = window.getLAppAdapter?.();
    if (!adapter || typeof adapter.startDirectParameterPlan !== "function") {
      const reason = "动作计划无法执行：Live2D 运行时未提供 Direct Parameter 接口。";
      console.warn("[MotionPlayer]", reason);
      if (!hadActivePlayback) {
        state.status = "failed";
        state.message = reason;
        state.finishedAt = new Date().toISOString();
      }
      return { status: "rejected", reason: "direct_parameter_plan_api_unavailable" };
    }

    if (hadActivePlayback) {
      try {
        stopPlan("direct_parameter_plan_replaced");
      } catch (error) {
        console.error("[MotionPlayer] direct parameter plan replacement failed.", error);
        return { status: "rejected", reason: "motion_replacement_stop_failed" };
      }
    }

    console.info("[MotionPlayer] calling startDirectParameterPlan...");
    const playbackRunId = `motion-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeDirectPlanRunId = playbackRunId;
    const started = adapter.startDirectParameterPlan(playbackPlan.plan, {
      runId: playbackRunId,
      playbackClockReader,
      onTerminal: (event: DirectParameterPlanTerminalEvent) => {
        if (event.runId !== playbackRunId) {
          return;
        }
        const isActiveRun = activeDirectPlanRunId === playbackRunId;
        if (isActiveRun) {
          activeDirectPlanRunId = "";
          if (event.status === "stopped") {
            state.status = "idle";
            state.message = "参数计划已停止。";
          } else {
            state.status = event.status === "completed" ? "finished" : "failed";
            state.message = event.reason
              || (event.status === "completed"
                ? "参数计划执行完成。"
                : `参数计划执行失败：${event.status}`);
          }
          state.finishedAt = new Date().toISOString();
        }
        options.onFinished?.(event);
      },
    });
    console.info("[MotionPlayer] startDirectParameterPlan returned:", started);
    if (!started) {
      if (activeDirectPlanRunId === playbackRunId) {
        activeDirectPlanRunId = "";
      }
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
      return {
        status: "rejected",
        reason: runtimeReason || "direct_parameter_plan_rejected",
      };
    }

    console.info("[MotionPlayer] plan started successfully. totalDurationMs=", playbackPlan.totalDurationMs);
    state.status = "playing";
    state.message = `正在执行参数计划（mode=${playbackPlan.plan.mode}, emotion=${playbackPlan.plan.emotion_label}）...`;
    state.keyAxesCount = playbackPlan.plan.summary?.axis_count ?? playbackPlan.plan.parameters.length;
    state.parameterCount = playbackPlan.plan.parameters.length;
    state.startedAt = new Date().toISOString();
    state.finishedAt = "";
    options.onStarted?.(playbackPlan.plan, playbackRunId);
    return { status: "started", runId: playbackRunId };
  }

  function playCatalogMotion(
    motion: CatalogMotionPayload,
    _model: ModelSummary | null = null,
    options: PlayCatalogMotionOptions = {},
  ): MotionPlaybackStartResult {
    const hadActivePlayback = Boolean(activeDirectPlanRunId || activeCatalogMotionRunId);
    const manualPreviewStartedAtMs = performance.now();
    const playbackClockReader = options.playbackClockReader ?? (
      options.requiresPlaybackClock
        ? null
        : { getElapsedMs: () => performance.now() - manualPreviewStartedAtMs }
    );
    if (!playbackClockReader) {
      const reason = "现成 motion 无法执行：会话 Timeline 时钟缺失。";
      if (!hadActivePlayback) {
        state.status = "failed";
        state.message = reason;
        state.finishedAt = new Date().toISOString();
      }
      console.error("[MotionPlayer]", reason);
      return { status: "rejected", reason };
    }
    const catalogDurationMs = motion.duration_ms;
    if (
      typeof catalogDurationMs !== "number"
      || !Number.isFinite(catalogDurationMs)
      || catalogDurationMs <= 0
    ) {
      const reason = `现成 motion 缺少有效 duration_ms：${motion.motion_id}。`;
      if (!hadActivePlayback) {
        state.status = "failed";
        state.message = reason;
        state.finishedAt = new Date().toISOString();
      }
      return { status: "rejected", reason };
    }
    const adapter = window.getLAppAdapter?.();
    if (
      !adapter
      || typeof adapter.startMotion !== "function"
      || typeof adapter.stopMotion !== "function"
    ) {
      const reason = "现成 motion 无法执行：Live2D 运行时缺少 startMotion 或 stopMotion 接口。";
      console.warn("[MotionPlayer]", reason);
      if (!hadActivePlayback) {
        state.status = "failed";
        state.message = reason;
        state.finishedAt = new Date().toISOString();
      }
      return { status: "rejected", reason };
    }

    if (hadActivePlayback) {
      try {
        stopPlan("catalog_motion_replaced");
      } catch (error) {
        console.error("[MotionPlayer] catalog motion replacement failed.", error);
        return { status: "rejected", reason: "motion_replacement_stop_failed" };
      }
    }

    const playbackRunId = `catalog-motion-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const getMotionStartError = (): string => (
      typeof adapter.getMotionStartError === "function"
        ? adapter.getMotionStartError().trim()
        : ""
    );

    const failCatalogMotion = (reason: string) => {
      if (activeCatalogMotionRunId !== playbackRunId) {
        return;
      }
      activeMotionStop = null;
      state.status = "failed";
      state.message = `现成 motion 执行失败：${motion.motion_id}（${reason}）。`;
      state.finishedAt = new Date().toISOString();
      activeCatalogMotionRunId = "";
      options.onFinished?.({ runId: playbackRunId, status: "failed", reason });
    };
    const completeCatalogMotion = () => {
      if (activeCatalogMotionRunId !== playbackRunId) {
        return;
      }
      activeMotionStop = null;
      state.status = "finished";
      state.message = "现成 motion 执行完成。";
      state.finishedAt = new Date().toISOString();
      activeCatalogMotionRunId = "";
      options.onFinished?.({ runId: playbackRunId, status: "completed" });
    };

    let lifecycleStarted = false;

    const handle = adapter.startMotion(
      motion.group,
      motion.index,
      motion.priority || 3,
      {
        playbackClockReader,
        onStarted: () => {
          lifecycleStarted = true;
          activeCatalogMotionRunId = playbackRunId;
          state.status = "playing";
          state.message = `正在执行现成 motion（${motion.label || motion.motion_id}）...`;
          state.startedAt = new Date().toISOString();
          activeMotionStop = (reason) => adapter.stopMotion?.(reason);
          options.onStarted?.(motion, playbackRunId);
        },
        onFinished: completeCatalogMotion,
        onFailed: failCatalogMotion,
        onInterrupted: (reason) => {
          if (activeCatalogMotionRunId !== playbackRunId) {
            return;
          }
          activeMotionStop = null;
          state.status = "idle";
          state.message = `现成 motion 已停止（${reason}）。`;
          state.finishedAt = new Date().toISOString();
          activeCatalogMotionRunId = "";
          options.onFinished?.({ runId: playbackRunId, status: "stopped", reason });
        },
      },
    );
    if (handle === -1) {
      const motionStartError = getMotionStartError();
      const failureReason = motionStartError || "catalog_motion_start_rejected";
      const reason = motionStartError
        ? `现成 motion 执行失败：${motion.motion_id}（${motionStartError}）。`
        : `现成 motion 执行失败：${motion.motion_id}。`;
      console.warn("[MotionPlayer]", reason);
      state.status = "failed";
      state.message = reason;
      state.finishedAt = new Date().toISOString();
      return { status: "rejected", reason: failureReason };
    }
    if (!lifecycleStarted || activeCatalogMotionRunId !== playbackRunId) {
      const reason = "catalog_motion_started_without_lifecycle_callback";
      adapter.stopMotion(reason);
      state.status = "failed";
      state.message = `现成 motion 执行失败：${motion.motion_id}（${reason}）。`;
      state.finishedAt = new Date().toISOString();
      activeCatalogMotionRunId = "";
      return { status: "rejected", reason };
    }
    return { status: "started", runId: playbackRunId };
  }

  return {
    state: readonly(state),
    playPlan,
    playCatalogMotion,
    stopPlan,
  };
}
