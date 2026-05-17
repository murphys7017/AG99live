import { reactive, readonly } from "vue";
import {
  MOTION_MIN_REMAINING_AUDIO_MS,
  MOTION_SYNC_WAIT_FOR_AUDIO_MS,
} from "./constants";
import type { SemanticParameterPlan } from "../types/protocol";
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
  messageId: string;
  turnId: string;
  playbackTurnId: string | null;
  receivedAtMs: number;
  audioWaitTimer: number;
}

interface StartPayloadContext {
  messageId: string;
  turnId: string | null;
  playbackTurnId: string | null;
  startReason: string;
  queuedDelayMs: number;
}

function resolveSessionKey(turnId: string | null): string | null {
  if (typeof turnId === "string" && turnId.trim()) {
    return `turn:${turnId.trim()}`;
  }
  return null;
}

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
  const pendingInboundMotionPayloads = new Map<string, PendingInboundMotionPayload>();

  function pushHistory(
    role: "system" | "error",
    text: string,
  ): void {
    dependencies.pushHistory?.(role, text);
  }

  function syncPendingState(): void {
    state.pendingCount = pendingInboundMotionPayloads.size;
    state.pendingMessageId = pendingInboundMotionPayloads.keys().next().value ?? "";
  }

  function clearPendingPayload(entry: PendingInboundMotionPayload): void {
    window.clearTimeout(entry.audioWaitTimer);
  }

  function clearAllPendingPayloads(): void {
    for (const entry of pendingInboundMotionPayloads.values()) {
      clearPendingPayload(entry);
    }
    pendingInboundMotionPayloads.clear();
    syncPendingState();
  }

  function findStartedSegment(
    messageId: string | null,
    turnId: string | null,
    playbackTurnId: string | null = null,
  ) {
    const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
    const normalizedTurnId = normalizeTurnId(turnId);
    const normalizedPlaybackTurnId = normalizeTurnId(playbackTurnId);

    for (const session of [
      dependencies.sessionStore?.getActiveSession(),
      resolveSessionKey(turnId)
        ? dependencies.sessionStore?.getSessionById?.(resolveSessionKey(turnId))
        : undefined,
    ]) {
      if (!session) {
        continue;
      }
      for (const segmentId of session.segmentOrder) {
        const segment = session.segments.get(segmentId);
        if (!segment || !segment.audio.started) {
          continue;
        }
        if (normalizedMessageId) {
          if (segment.messageId === normalizedMessageId) {
            return segment;
          }
          continue;
        }
        const segmentTurnId = normalizeTurnId(segment.turnId);
        if (normalizedTurnId && segmentTurnId === normalizedTurnId) {
          return segment;
        }
        if (normalizedPlaybackTurnId && segmentTurnId === normalizedPlaybackTurnId) {
          return segment;
        }
      }
    }
    return null;
  }

  function resolveMotionTargetDurationMs(
    messageId: string | null,
    turnId: string | null,
    playbackTurnId: string | null = null,
  ): number | null {
    const startedSegment = findStartedSegment(messageId, turnId, playbackTurnId);
    const audioStartedAtMs = startedSegment?.audio.startedAtMs;
    const audioDurationMs = startedSegment?.audio.durationMs;
    const sessionTurnId = startedSegment?.turnId;

    const normalizedTurnId = normalizeTurnId(turnId);
    const normalizedSessionTurnId = normalizeTurnId(sessionTurnId ?? null);

    // If session has valid audio timing data, use it
    if (
      (!normalizedTurnId || !normalizedSessionTurnId || normalizedTurnId === normalizedSessionTurnId)
      && audioStartedAtMs
      && audioDurationMs
      && Number.isFinite(audioStartedAtMs)
      && audioStartedAtMs > 0
      && Number.isFinite(audioDurationMs)
      && audioDurationMs > 0
    ) {
      const elapsedMs = Math.max(0, performance.now() - audioStartedAtMs);
      return Math.max(MOTION_MIN_REMAINING_AUDIO_MS, Math.round(audioDurationMs - elapsedMs));
    }

    return null;
  }

  function resolveMotionTargetDurationMsForContext(
    messageId: string,
    turnId: string | null,
    playbackTurnId: string | null,
  ): number | null {
    return resolveMotionTargetDurationMs(messageId, turnId, playbackTurnId);
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
        targetDurationMs: resolveMotionTargetDurationMsForContext(
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
          orchestrationId: context.playbackTurnId,
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
        targetDurationMs: resolveMotionTargetDurationMsForContext(
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
          orchestrationId: context.playbackTurnId,
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

  function tryStartPendingPayload(messageId: string, startReason: string): boolean {
    const entry = pendingInboundMotionPayloads.get(messageId);
    if (!entry) {
      return false;
    }

    pendingInboundMotionPayloads.delete(messageId);
    clearPendingPayload(entry);
    syncPendingState();
    return startPayload(entry.payload, {
      turnId: entry.turnId,
      playbackTurnId: entry.playbackTurnId,
      messageId: entry.messageId,
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
        messageId: context.messageId,
        turnId: null,
        playbackTurnId: context.orchestrationId ?? context.turnId ?? null,
        startReason: "missing_turn_id",
        queuedDelayMs: 0,
      });
      return;
    }

    const existing = pendingInboundMotionPayloads.get(context.messageId);
    if (existing) {
      console.info("[ModelEngine] replacing pending motion payload for turn.", {
        turnId: normalizedTurnId,
        messageId: context.messageId,
      });
      clearPendingPayload(existing);
      pendingInboundMotionPayloads.delete(context.messageId);
    }

    const entry: PendingInboundMotionPayload = {
      payload,
      messageId: context.messageId,
      turnId: normalizedTurnId,
      playbackTurnId: context.orchestrationId ?? context.turnId ?? null,
      receivedAtMs: context.receivedAtMs,
      audioWaitTimer: 0,
    };

    entry.audioWaitTimer = window.setTimeout(() => {
      const latest = pendingInboundMotionPayloads.get(context.messageId);
      if (!latest || latest !== entry) {
        return;
      }

      const activeSession = dependencies.sessionStore?.getActiveSession();
      const currentTurnId = normalizeTurnId(
        activeSession?.turnId ?? dependencies.getCurrentTurnId(),
      );
      const currentPlaybackTurnId =
        normalizeTurnId(dependencies.getCurrentOrchestrationId?.() ?? currentTurnId);
      const audioPlaybackTurnId =
        normalizeTurnId(
          findStartedSegment(entry.messageId, entry.turnId, entry.playbackTurnId)?.turnId ?? null,
        );

      if (currentTurnId && currentTurnId !== normalizedTurnId) {
        if (
          entry.playbackTurnId
          && (normalizeTurnId(entry.playbackTurnId) === currentPlaybackTurnId
            || normalizeTurnId(entry.playbackTurnId) === audioPlaybackTurnId)
        ) {
          tryStartPendingPayload(context.messageId, "wait_audio_timeout_playback_turn_match");
          return;
        }
        clearPendingPayload(entry);
        pendingInboundMotionPayloads.delete(context.messageId);
        syncPendingState();
        return;
      }

      tryStartPendingPayload(context.messageId, "wait_audio_timeout");
    }, MOTION_SYNC_WAIT_FOR_AUDIO_MS);

    pendingInboundMotionPayloads.set(context.messageId, entry);
    syncPendingState();
    setState("pending", "动作已排队，等待音频起播。", null);
    console.info("[ModelEngine] queued motion payload.", {
      kind: payload.kind,
      turnId: normalizedTurnId,
      messageId: context.messageId,
      pendingCount: pendingInboundMotionPayloads.size,
    });

    const startedSegment = findStartedSegment(
      context.messageId,
      normalizedTurnId,
      entry.playbackTurnId,
    );
    const activeAudioMessageId =
      startedSegment?.messageId
      ?? null;

    if (activeAudioMessageId === context.messageId) {
      tryStartPendingPayload(context.messageId, "audio_already_playing");
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

  function ingestNormalizedPayload(
    payload: NormalizedMotionPayload,
    context: InboundPayloadContext,
  ): void {
    queueInboundPayload(payload, context);
  }

  function notifyAudioPlaybackStarted(
    turnId: string | null,
    messageId: string | null = null,
  ): void {
    const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
    if (normalizedMessageId) {
      const started = tryStartPendingPayload(normalizedMessageId, "audio_playing_event");
      console.info("[ModelEngine] audio playback start notification handled.", {
        turnId,
        messageId: normalizedMessageId,
        started,
        pendingCount: pendingInboundMotionPayloads.size,
      });
      return;
    }
    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedTurnId) {
      return;
    }
    let started = false;
    for (const entry of Array.from(pendingInboundMotionPayloads.values())) {
      if (entry.turnId === normalizedTurnId) {
        started = tryStartPendingPayload(entry.messageId, "audio_playing_event") || started;
      }
    }
    console.info("[ModelEngine] audio playback start notification handled.", {
      turnId: normalizedTurnId,
      started,
      pendingCount: pendingInboundMotionPayloads.size,
    });
  }

  function notifyCurrentTurnChanged(turnId: string | null): void {
    const currentTurnId = normalizeTurnId(turnId);
    if (!currentTurnId) {
      return;
    }

    for (const [messageId, entry] of pendingInboundMotionPayloads.entries()) {
      if (entry.turnId === currentTurnId) {
        continue;
      }
      clearPendingPayload(entry);
      pendingInboundMotionPayloads.delete(messageId);
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
      messageId: "preview",
      turnId: null,
      playbackTurnId: null,
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
    ingestNormalizedPayload,
    notifyAudioPlaybackStarted,
    notifyCurrentTurnChanged,
    playPreviewPayload,
    stop,
  };
}
