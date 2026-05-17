import { reactive, readonly } from "vue";
import {
  createMotionRuntimeScheduler,
  type StartPayloadContext,
} from "./runtime/motionRuntimeScheduler";
import type {
  CompileDiagnostics,
  InboundPayloadContext,
  ModelEngineDependencies,
  ModelEngineStatus,
  NormalizedMotionPayload,
} from "./contracts";
import { normalizeMotionPayload } from "./normalize";
import {
  reportInvalidMotionPayload,
  startNormalizedMotionPayload,
} from "./runtime/motionStart";

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

  const runtimeStateController = {
    setState,
    setLastCompileReason: (reason: string) => {
      state.lastCompileReason = reason;
    },
    setLastCompileDiagnostics: (diagnostics: CompileDiagnostics | null) => {
      state.lastCompileDiagnostics = diagnostics;
    },
    setLastStartReason: (reason: string) => {
      state.lastStartReason = reason;
    },
    pushHistory,
  };

  const runtimeScheduler = createMotionRuntimeScheduler(dependencies, {
    onPendingStateChanged: (pendingCount, pendingMessageId) => {
      state.pendingCount = pendingCount;
      state.pendingMessageId = pendingMessageId;
    },
    onPendingStatus: (message) => {
      setState("pending", message, null);
    },
    onStartPayload: (payload: NormalizedMotionPayload, context: StartPayloadContext) =>
      startNormalizedMotionPayload(
        payload,
        context,
        dependencies,
        {
          resolveMotionTargetDurationMs: runtimeScheduler.resolveMotionTargetDurationMs,
        },
        runtimeStateController,
      ),
  });

  function ingestInboundPayload(
    payload: unknown,
    context: InboundPayloadContext,
  ): void {
    const normalized = normalizeMotionPayload(payload);
    if (!normalized.ok) {
      reportInvalidMotionPayload(normalized.reason, runtimeStateController);
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
      reportInvalidMotionPayload(normalized.reason, runtimeStateController);
      return false;
    }

    return startNormalizedMotionPayload(
      normalized.payload,
      {
        messageId: "preview",
        turnId: null,
        playbackTurnId: null,
        startReason: "preview",
        queuedDelayMs: 0,
      },
      dependencies,
      {
        resolveMotionTargetDurationMs: runtimeScheduler.resolveMotionTargetDurationMs,
      },
      runtimeStateController,
    );
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
