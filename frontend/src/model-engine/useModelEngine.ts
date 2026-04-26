import { reactive, readonly } from "vue";
import {
  MOTION_MIN_REMAINING_AUDIO_MS,
  MOTION_SYNC_WAIT_FOR_AUDIO_MS,
} from "./constants";
import { compileMotionIntent } from "./compiler";
import type {
  CompileDiagnostics,
  InboundPayloadContext,
  ModelEngineDependencies,
  ModelEngineStatus,
  NormalizedMotionPayload,
} from "./contracts";
import { normalizeMotionPayload, normalizeTurnId } from "./normalize";

interface PendingInboundMotionPayload {
  payload: NormalizedMotionPayload;
  turnId: string;
  receivedAtMs: number;
  fallbackTimer: number;
}

interface StartPayloadContext {
  turnId: string | null;
  startReason: string;
  queuedDelayMs: number;
}

const state = reactive({
  status: "idle" as ModelEngineStatus,
  message: "等待动作输入。",
  pendingTurnId: "" as string,
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
  const pendingInboundMotionPayloads = new Map<string, PendingInboundMotionPayload>();

  function pushHistory(
    role: "system" | "error",
    text: string,
  ): void {
    dependencies.pushHistory?.(role, text);
  }

  function syncPendingState(): void {
    state.pendingCount = pendingInboundMotionPayloads.size;
    state.pendingTurnId = pendingInboundMotionPayloads.keys().next().value ?? "";
  }

  function clearPendingPayload(entry: PendingInboundMotionPayload): void {
    window.clearTimeout(entry.fallbackTimer);
  }

  function clearAllPendingPayloads(): void {
    for (const entry of pendingInboundMotionPayloads.values()) {
      clearPendingPayload(entry);
    }
    pendingInboundMotionPayloads.clear();
    syncPendingState();
  }

  function resolveMotionTargetDurationMs(turnId: string | null): number | null {
    const normalizedTurnId = normalizeTurnId(turnId);
    const audioPlayback = dependencies.getAudioPlaybackInfo();
    const audioTurnId = normalizeTurnId(audioPlayback.turnId);
    if (!normalizedTurnId || !audioTurnId || normalizedTurnId !== audioTurnId) {
      return null;
    }

    const rawDuration = Number(audioPlayback.durationMs ?? 0);
    const startedAtMs = Number(audioPlayback.startedAtMs ?? 0);
    if (
      !Number.isFinite(rawDuration)
      || rawDuration <= 0
      || !Number.isFinite(startedAtMs)
      || startedAtMs <= 0
    ) {
      return null;
    }

    const elapsedMs = Math.max(0, performance.now() - startedAtMs);
    return Math.max(MOTION_MIN_REMAINING_AUDIO_MS, Math.round(rawDuration - elapsedMs));
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

    if (payload.kind === "intent" || payload.kind === "semantic_intent") {
      if (!selectedModel) {
        state.lastCompileReason = "missing_selected_model";
        setState("failed", "动作意图无法编译：当前未选中模型。", null);
        pushHistory("error", state.message);
        return false;
      }

      setState("compiling", "正在编译动作意图...", null);
      const compileResult = compileMotionIntent(payload.intent, {
        model: selectedModel,
        targetDurationMs: resolveMotionTargetDurationMs(context.turnId),
        source: context.startReason,
        settings: dependencies.getSettings(),
      });
      state.lastCompileReason = compileResult.reason;
      state.lastCompileDiagnostics = compileResult.diagnostics;
      if (!compileResult.ok || !compileResult.plan) {
        setState("failed", `动作意图编译失败：${compileResult.reason}`, compileResult.diagnostics);
        pushHistory("error", state.message);
        return false;
      }

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
          turnId: context.turnId,
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
    let startedPlan: typeof directPlanPayload.plan | null = null;
    const started = dependencies.playPlan(
      directPlanPayload.plan,
      selectedModel,
      {
        softHandoff: true,
        targetDurationMs: resolveMotionTargetDurationMs(context.turnId),
        onStarted: (plan) => {
          startedPlan = plan;
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
        turnId: context.turnId,
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

  function tryStartPendingPayload(turnId: string, startReason: string): boolean {
    const entry = pendingInboundMotionPayloads.get(turnId);
    if (!entry) {
      return false;
    }

    pendingInboundMotionPayloads.delete(turnId);
    clearPendingPayload(entry);
    syncPendingState();
    return startPayload(entry.payload, {
      turnId: entry.turnId,
      startReason,
      queuedDelayMs: Math.max(0, Math.round(performance.now() - entry.receivedAtMs)),
    });
  }

  function queueInboundPayload(
    payload: NormalizedMotionPayload,
    context: InboundPayloadContext,
  ): void {
    const normalizedTurnId = normalizeTurnId(context.turnId);
    if (!normalizedTurnId) {
      startPayload(payload, {
        turnId: null,
        startReason: "missing_turn_id",
        queuedDelayMs: 0,
      });
      return;
    }

    const existing = pendingInboundMotionPayloads.get(normalizedTurnId);
    if (existing) {
      clearPendingPayload(existing);
      pendingInboundMotionPayloads.delete(normalizedTurnId);
    }

    const entry: PendingInboundMotionPayload = {
      payload,
      turnId: normalizedTurnId,
      receivedAtMs: context.receivedAtMs,
      fallbackTimer: 0,
    };

    entry.fallbackTimer = window.setTimeout(() => {
      const latest = pendingInboundMotionPayloads.get(normalizedTurnId);
      if (!latest || latest !== entry) {
        return;
      }

      const currentTurnId = normalizeTurnId(dependencies.getCurrentTurnId());
      if (currentTurnId && currentTurnId !== normalizedTurnId) {
        clearPendingPayload(entry);
        pendingInboundMotionPayloads.delete(normalizedTurnId);
        syncPendingState();
        return;
      }

      tryStartPendingPayload(normalizedTurnId, "wait_audio_timeout");
    }, MOTION_SYNC_WAIT_FOR_AUDIO_MS);

    pendingInboundMotionPayloads.set(normalizedTurnId, entry);
    syncPendingState();
    setState("pending", "动作已排队，等待音频起播。", null);

    const activeAudioTurnId = normalizeTurnId(dependencies.getAudioPlaybackInfo().turnId);
    if (activeAudioTurnId && activeAudioTurnId === normalizedTurnId) {
      tryStartPendingPayload(normalizedTurnId, "audio_already_playing");
    }
  }

  function ingestInboundPayload(
    payload: unknown,
    context: InboundPayloadContext,
  ): void {
    const normalized = normalizeMotionPayload(payload);
    if (!normalized.ok) {
      reportInvalidPayload(normalized.reason);
      return;
    }
    queueInboundPayload(normalized.payload, context);
  }

  function notifyAudioPlaybackStarted(turnId: string | null): void {
    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedTurnId) {
      return;
    }
    tryStartPendingPayload(normalizedTurnId, "audio_playing_event");
  }

  function notifyCurrentTurnChanged(turnId: string | null): void {
    const currentTurnId = normalizeTurnId(turnId);
    if (!currentTurnId) {
      return;
    }

    for (const [pendingTurnId, entry] of pendingInboundMotionPayloads.entries()) {
      if (pendingTurnId === currentTurnId) {
        continue;
      }
      clearPendingPayload(entry);
      pendingInboundMotionPayloads.delete(pendingTurnId);
    }
    syncPendingState();
  }

  function playPreviewPayload(payload: unknown): boolean {
    const normalized = normalizeMotionPayload(payload);
    if (!normalized.ok) {
      reportInvalidPayload(normalized.reason);
      return false;
    }

    return startPayload(normalized.payload, {
      turnId: null,
      startReason: "preview",
      queuedDelayMs: 0,
    });
  }

  function stop(reason = "stopped"): void {
    clearAllPendingPayloads();
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
    notifyAudioPlaybackStarted,
    notifyCurrentTurnChanged,
    playPreviewPayload,
    stop,
  };
}
