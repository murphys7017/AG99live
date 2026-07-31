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

  let activeRunId = 0;
  let activeDirectPlanRunId = "";
  let activeCatalogMotionRunId = "";
  let activeMotionStop: ((reason: string) => void) | null = null;

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

  function stopActiveCatalogMotion(reason: string): void {
    const stop = activeMotionStop;
    activeMotionStop = null;
    stop?.(reason);
  }

  function stopPlan(reason = "stopped"): void {
    const adapter = window.getLAppAdapter?.();
    if (adapter && typeof adapter.stopDirectParameterPlan === "function") {
      adapter.stopDirectParameterPlan(reason, "stopped");
    }
    stopActiveCatalogMotion(reason);
    activeRunId += 1;

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
    const manualPreviewStartedAtMs = performance.now();
    const playbackClockReader = options.playbackClockReader ?? (
      options.requiresPlaybackClock
        ? null
        : { getElapsedMs: () => performance.now() - manualPreviewStartedAtMs }
    );
    if (!playbackClockReader) {
      const reason = "动作计划无法执行：会话 Timeline 时钟缺失。";
      state.status = "failed";
      state.message = reason;
      state.finishedAt = new Date().toISOString();
      console.error("[MotionPlayer]", reason);
      return false;
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
      state.status = "failed";
      state.message = reason;
      state.finishedAt = new Date().toISOString();
      return false;
    }

    console.info("[MotionPlayer] calling startDirectParameterPlan...");
    const playbackRunId = `motion-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const previousDirectPlanRunId = activeDirectPlanRunId;
    const hadActiveDirectPlan = Boolean(previousDirectPlanRunId);
    // WebSDK can synchronously terminal the replaced run. Reserve the new id
    // first so that old terminal events remain Timeline facts without rewriting
    // this player back to the old run's state.
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
      activeDirectPlanRunId = previousDirectPlanRunId;
      const runtimeReason = typeof adapter.getDirectParameterPlanError === "function"
        ? normalizeText(adapter.getDirectParameterPlanError())
        : "";
      const reason = runtimeReason
        ? `动作计划执行失败：${runtimeReason}`
        : "动作计划执行失败：Direct Parameter 计划被运行时拒绝。";
      console.warn("[MotionPlayer]", reason);
      if (!hadActiveDirectPlan) {
        state.status = "failed";
        state.message = reason;
        state.finishedAt = new Date().toISOString();
      }
      return false;
    }

    // Catalog motion has a separate SDK lifecycle. Stop it only after the
    // replacement plan is accepted, while its own run is still current.
    stopActiveCatalogMotion("direct_parameter_plan_replaced");
    activeRunId += 1;

    console.info("[MotionPlayer] plan started successfully. totalDurationMs=", playbackPlan.totalDurationMs);
    state.status = "playing";
    state.message = `正在执行参数计划（mode=${playbackPlan.plan.mode}, emotion=${playbackPlan.plan.emotion_label}）...`;
    state.keyAxesCount = playbackPlan.plan.summary?.axis_count ?? playbackPlan.plan.parameters.length;
    state.parameterCount = playbackPlan.plan.parameters.length;
    state.startedAt = new Date().toISOString();
    state.finishedAt = "";
    options.onStarted?.(playbackPlan.plan, playbackRunId);
    return true;
  }

  function playCatalogMotion(
    motion: CatalogMotionPayload,
    _model: ModelSummary | null = null,
    options: PlayCatalogMotionOptions = {},
  ): boolean {
    const manualPreviewStartedAtMs = performance.now();
    const playbackClockReader = options.playbackClockReader ?? (
      options.requiresPlaybackClock
        ? null
        : { getElapsedMs: () => performance.now() - manualPreviewStartedAtMs }
    );
    if (!playbackClockReader) {
      const reason = "现成 motion 无法执行：会话 Timeline 时钟缺失。";
      state.status = "failed";
      state.message = reason;
      state.finishedAt = new Date().toISOString();
      console.error("[MotionPlayer]", reason);
      return false;
    }
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

    stopActiveCatalogMotion("catalog_motion_replaced");
    if (typeof adapter.stopDirectParameterPlan === "function") {
      activeDirectPlanRunId = "";
      adapter.stopDirectParameterPlan("catalog_motion_replaced", "stopped");
    }
    activeRunId += 1;
    const runId = activeRunId;
    const playbackRunId = `catalog-motion-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const getMotionStartError = (): string => (
      typeof adapter.getMotionStartError === "function"
        ? adapter.getMotionStartError().trim()
        : ""
    );

    const failCatalogMotion = (reason: string) => {
      if (activeRunId !== runId || activeCatalogMotionRunId !== playbackRunId) {
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
      if (activeRunId !== runId || activeCatalogMotionRunId !== playbackRunId) {
        return;
      }
      activeMotionStop = null;
      state.status = "finished";
      state.message = "现成 motion 执行完成。";
      state.finishedAt = new Date().toISOString();
      activeCatalogMotionRunId = "";
      options.onFinished?.({ runId: playbackRunId, status: "completed" });
    };

    state.status = "preparing";
    state.message = `正在准备现成 motion（${motion.label || motion.motion_id}）...`;
    state.keyAxesCount = 0;
    state.parameterCount = 0;
    state.startedAt = "";
    state.finishedAt = "";
    activeCatalogMotionRunId = playbackRunId;

    const handle = adapter.startMotion(
      motion.group,
      motion.index,
      motion.priority || 3,
      {
        playbackClockReader,
        onStarted: () => {
          if (activeRunId !== runId) {
            return;
          }
          state.status = "playing";
          state.message = `正在执行现成 motion（${motion.label || motion.motion_id}）...`;
          state.startedAt = new Date().toISOString();
          activeMotionStop = (reason) => adapter.stopMotion?.(reason);
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
          if (activeRunId !== runId || activeCatalogMotionRunId !== playbackRunId) {
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
      const reason = motionStartError
        ? `现成 motion 执行失败：${motion.motion_id}（${motionStartError}）。`
        : `现成 motion 执行失败：${motion.motion_id}。`;
      console.warn("[MotionPlayer]", reason);
      state.status = "failed";
      state.message = reason;
      state.finishedAt = new Date().toISOString();
      activeCatalogMotionRunId = "";
      return false;
    }
    if (state.status === "preparing") {
      activeMotionStop = (reason) => adapter.stopMotion?.(reason);
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
