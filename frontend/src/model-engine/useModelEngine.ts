import { reactive, readonly } from "vue";
import {
  createMotionRuntimeScheduler,
  type StartPayloadContext,
} from "./runtime/motionRuntimeScheduler";
import type { SemanticParameterPlan } from "../types/protocol";
import { compileMotionIntent } from "./compiler";
import type {
  CompileDiagnostics,
  InboundPayloadContext,
  ModelEngineDependencies,
  ModelEngineStatus,
  NormalizedMotionPayload,
} from "./contracts";
import { normalizeMotionPayload } from "./normalize";

const state = reactive({
  status: "idle" as ModelEngineStatus,
  message: "等待动作输入。",
  pendingMessageId: "" as string,
  pendingCount: 0,
  lastCompileReason: "",
  lastCompileDiagnostics: null as CompileDiagnostics | null,
  lastStartReason: "",
});

function setState(
  status: ModelEngineStatus,
  message: string,
  diagnostics: CompileDiagnostics | null = state.lastCompileDiagnostics,
): void {
  state.status = status;
  state.message = message;
  state.lastCompileDiagnostics = diagnostics;
}

export function useModelEngine(dependencies: ModelEngineDependencies) {
  function pushHistory(
    role: "system" | "error",
    text: string,
  ): void {
    dependencies.pushHistory?.(role, text);
  }

  function reportInvalidPayload(reason: string): void {
    state.lastCompileReason = reason;
    setState("failed", `动作载荷无效：${reason}`, null);
    pushHistory("error", `动作载荷无效：${reason}`);
  }

  function startPayload(
    payload: NormalizedMotionPayload,
    context: StartPayloadContext,
  ): boolean {
    const selectedModel = dependencies.getSelectedModel();
    state.lastStartReason = context.startReason;
    console.info("[ModelEngine] starting motion payload.", {
      kind: payload.kind,
      messageId: context.messageId,
      turnId: context.turnId,
      playbackTurnId: context.playbackTurnId,
      startReason: context.startReason,
      queuedDelayMs: context.queuedDelayMs,
    });

    if (payload.kind === "semantic_intent") {
      if (!selectedModel) {
        state.lastCompileReason = "missing_selected_model";
        setState("failed", "动作意图无法编译：当前未选中模型。", null);
        pushHistory("error", state.message);
        return false;
      }

      setState("compiling", "正在编译动作意图...", null);
      const compileResult = compileMotionIntent(payload.intent, {
        model: selectedModel,
        targetDurationMs: runtimeScheduler.resolveMotionTargetDurationMs(
          context.messageId,
          context.turnId,
          context.playbackTurnId,
        ),
        source: context.startReason,
        settings: dependencies.getSettings(),
      });
      state.lastCompileReason = compileResult.reason;
      state.lastCompileDiagnostics = compileResult.diagnostics;
      if (!compileResult.ok || !compileResult.plan) {
        console.warn("[ModelEngine] semantic intent compile failed.", {
          reason: compileResult.reason,
          diagnostics: compileResult.diagnostics,
        });
        setState("failed", `动作意图编译失败：${compileResult.reason}`, compileResult.diagnostics);
        pushHistory("error", state.message);
        return false;
      }
      console.info("[ModelEngine] semantic intent compiled.", {
        parameterCount: compileResult.plan.parameters.length,
        diagnostics: compileResult.diagnostics,
      });

      let startedPlan: typeof compileResult.plan | null = null;
      const started = dependencies.playPlan(
        compileResult.plan,
        selectedModel,
        {
          softHandoff: true,
          onStarted: (plan) => {
            startedPlan = plan;
          },
        },
      );
      if (!started) {
        const failureReason = dependencies.getPlayerMessage?.()
          || "动作意图编译成功，但运行时拒绝执行。";
        setState("failed", failureReason, compileResult.diagnostics);
        pushHistory("error", `动作播放失败：${failureReason}`);
        return false;
      }

      const successMessage = dependencies.getPlayerMessage?.()
        || `动作计划执行中（启动延迟 ${context.queuedDelayMs}ms）。`;
      if (startedPlan) {
        dependencies.onPlanStarted?.({
          plan: startedPlan,
          model: selectedModel,
          messageId: context.messageId,
          turnId: context.turnId,
          playbackTurnId: context.playbackTurnId,
          startReason: context.startReason,
          queuedDelayMs: context.queuedDelayMs,
          payloadKind: payload.kind,
          diagnostics: compileResult.diagnostics,
          playerMessage: successMessage,
        });
      }
      setState("playing", successMessage, compileResult.diagnostics);
      pushHistory("system", `动作计划执行中（${successMessage}）。`);
      return true;
    }

    const directPlanPayload = payload;
    let startedPlan: SemanticParameterPlan | null = null;
    const started = dependencies.playPlan(
      directPlanPayload.plan,
      selectedModel,
      {
        softHandoff: true,
        targetDurationMs: runtimeScheduler.resolveMotionTargetDurationMs(
          context.messageId,
          context.turnId,
          context.playbackTurnId,
        ),
        onStarted: (plan) => {
          startedPlan = plan as SemanticParameterPlan;
        },
      },
    );
    if (!started) {
      const failureReason = dependencies.getPlayerMessage?.()
        || "动作计划被运行时拒绝执行。";
      state.lastCompileReason = failureReason;
      setState("failed", failureReason, null);
      pushHistory("error", `动作播放失败：${failureReason}`);
      return false;
    }

    const successMessage = dependencies.getPlayerMessage?.()
      || `动作计划执行中（启动延迟 ${context.queuedDelayMs}ms）。`;
    if (startedPlan) {
      dependencies.onPlanStarted?.({
        plan: startedPlan,
        model: selectedModel,
        messageId: context.messageId,
        turnId: context.turnId,
        playbackTurnId: context.playbackTurnId,
        startReason: context.startReason,
        queuedDelayMs: context.queuedDelayMs,
        payloadKind: directPlanPayload.kind,
        diagnostics: null,
        playerMessage: successMessage,
      });
    }
    setState("playing", successMessage, null);
    pushHistory("system", `动作计划执行中（${successMessage}）。`);
    return true;
  }

  const runtimeScheduler = createMotionRuntimeScheduler(dependencies, {
    onPendingStateChanged: (pendingCount, pendingMessageId) => {
      state.pendingCount = pendingCount;
      state.pendingMessageId = pendingMessageId;
    },
    onPendingStatus: (message) => {
      setState("pending", message, null);
    },
    onStartPayload: startPayload,
  });

  function ingestInboundPayload(
    payload: unknown,
    context: InboundPayloadContext,
  ): void {
    const normalized = normalizeMotionPayload(payload);
    if (!normalized.ok) {
      reportInvalidPayload(normalized.reason);
      return;
    }
    runtimeScheduler.queueInboundPayload(normalized.payload, context);
  }

  function ingestNormalizedPayload(
    payload: NormalizedMotionPayload,
    context: InboundPayloadContext,
  ): void {
    runtimeScheduler.queueInboundPayload(payload, context);
  }

  function notifyAudioPlaybackStarted(
    turnId: string | null,
    messageId: string | null = null,
  ): void {
    runtimeScheduler.notifyAudioPlaybackStarted(turnId, messageId);
  }

  function notifyCurrentTurnChanged(turnId: string | null): void {
    runtimeScheduler.notifyCurrentTurnChanged(turnId);
  }

  function playPreviewPayload(payload: unknown): boolean {
    const normalized = normalizeMotionPayload(payload);
    if (!normalized.ok) {
      reportInvalidPayload(normalized.reason);
      return false;
    }

    return startPayload(normalized.payload, {
      messageId: "preview",
      turnId: null,
      playbackTurnId: null,
      startReason: "preview",
      queuedDelayMs: 0,
    });
  }

  function stop(reason = "stopped"): void {
    runtimeScheduler.clearAllPendingPayloads();
    dependencies.stopPlan(reason);
    state.lastCompileReason = "";
    setState(
      "idle",
      reason === "stopped"
        ? "动作引擎已停止。"
        : `动作引擎已停止（${reason}）。`,
      null,
    );
  }

  return {
    state: readonly(state),
    ingestInboundPayload,
    ingestNormalizedPayload,
    notifyAudioPlaybackStarted,
    notifyCurrentTurnChanged,
    playPreviewPayload,
    stop,
  };
}
