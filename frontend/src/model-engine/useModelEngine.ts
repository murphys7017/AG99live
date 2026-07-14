import { reactive, readonly } from "vue";
import {
  createMotionRuntimeScheduler,
  type StartPayloadContext,
} from "./runtime/motionRuntimeScheduler.js";
import {
  buildSpeechOnlyMotionRequest,
  type SpeechOnlyMotionRequest,
} from "./runtime/speechOnlyMotion.js";
import type { InboundPayloadContext, NormalizedMotionPayload } from "./contracts.js";
import type { CompileDiagnostics } from "./compiler/contracts.js";
import type {
  ModelEngineDependencies,
  ModelEngineHistoryRole,
  ModelEngineStatus,
  MotionRuntimeSchedulerDependencies,
  MotionStartDependencies,
} from "./runtime/contracts.js";
import type {
  MotionPlaybackClockContext,
  MotionTimelinePreparationResult,
} from "./runtime/playbackClock.js";
import { normalizeMotionPayload, normalizeTurnId } from "./normalize.js";
import {
  prepareSemanticMotionPayload,
  prepareSpeechOnlyMotionRequest,
  reportInvalidMotionPayload,
  startNormalizedMotionPayload,
  startSpeechOnlyMotionRequest,
  type PreparedSemanticMotionPayload,
} from "./runtime/motionStart.js";
import { createModelEngineStageRegistry } from "./compiler/registry.js";

export function useModelEngine(dependencies: ModelEngineDependencies) {
  const stageRegistry = createModelEngineStageRegistry();
  const state = reactive({
    status: "idle" as ModelEngineStatus,
    message: "等待动作输入。",
    pendingMessageId: "",
    pendingCount: 0,
    lastCompileReason: "",
    lastCompileDiagnostics: null as CompileDiagnostics | null,
    lastStartReason: "",
  });
  let activePlaybackOwner: { turnId: string | null; messageId: string } | null = null;
  const preparedSemanticMotions = new Map<string, {
    durationMs: number;
    prepared: PreparedSemanticMotionPayload;
  }>();

  function buildSegmentKey(turnId: string | null, messageId: string): string {
    const normalizedTurnId = normalizeTurnId(turnId);
    const normalizedMessageId = messageId.trim();
    if (!normalizedTurnId || !normalizedMessageId) {
      throw new Error("Prepared motion requires turnId and messageId.");
    }
    return `${normalizedTurnId.length}:${normalizedTurnId}:${normalizedMessageId}`;
  }

  function setState(
    status: ModelEngineStatus,
    message: string,
    diagnostics: CompileDiagnostics | null = state.lastCompileDiagnostics,
  ): void {
    state.status = status;
    state.message = message;
    state.lastCompileDiagnostics = diagnostics;
  }

  function pushHistory(
    role: ModelEngineHistoryRole,
    text: string,
  ): void {
    dependencies.pushHistory?.(role, text);
  }

  const runtimeSchedulerDependencies: MotionRuntimeSchedulerDependencies = {
    getCurrentTurnId: dependencies.getCurrentTurnId,
  };

  const motionStartDependencies: MotionStartDependencies = {
    getSelectedModel: dependencies.getSelectedModel,
    getSettings: dependencies.getSettings,
    playPlan: dependencies.playPlan,
    playCatalogMotion: dependencies.playCatalogMotion,
    getPlayerMessage: dependencies.getPlayerMessage,
    onPlanStarted: (event) => {
      activePlaybackOwner = {
        turnId: normalizeTurnId(event.turnId),
        messageId: event.messageId.trim(),
      };
      dependencies.onPlanStarted(event);
    },
    onCompileFailed: dependencies.onCompileFailed,
    stageRegistry,
  };

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

  const runtimeScheduler = createMotionRuntimeScheduler(runtimeSchedulerDependencies, {
    onPendingStateChanged: (pendingCount, pendingMessageId) => {
      state.pendingCount = pendingCount;
      state.pendingMessageId = pendingMessageId;
    },
    onPendingStatus: (message) => {
      setState("pending", message, null);
    },
    onStartPayload: (payload: NormalizedMotionPayload, context: StartPayloadContext) => {
      const key = buildSegmentKey(context.turnId, context.messageId);
      const prepared = payload.kind === "semantic_intent"
        ? preparedSemanticMotions.get(key)?.prepared ?? null
        : null;
      preparedSemanticMotions.delete(key);
      return startNormalizedMotionPayload(
        payload,
        context,
        motionStartDependencies,
        runtimeStateController,
        prepared,
      );
    },
    onStartFailed: (context: StartPayloadContext) => {
      if (!normalizeTurnId(context.turnId)) {
        state.lastCompileReason = context.startReason;
        setState("failed", `动作启动失败：${context.startReason}`, null);
        pushHistory("error", `动作启动失败：${context.startReason}`);
        return;
      }
      dependencies.onMotionRejected({
        turnId: normalizeTurnId(context.turnId) as string,
        messageId: context.messageId,
        reason: context.startReason,
      });
    },
  });

  function ingestInboundPayload(
    payload: unknown,
    context: InboundPayloadContext,
  ): boolean {
    const normalized = normalizeMotionPayload(payload);
    if (!normalized.ok) {
      reportInvalidMotionPayload(normalized.reason, runtimeStateController);
      const turnId = normalizeTurnId(context.turnId);
      if (turnId) {
        dependencies.onMotionRejected({
          turnId,
          messageId: context.messageId,
          reason: normalized.reason,
        });
      }
      return false;
    }
    return runtimeScheduler.queueInboundPayload(normalized.payload, context);
  }

  function ingestNormalizedPayload(
    payload: NormalizedMotionPayload,
    context: InboundPayloadContext,
  ): boolean {
    return runtimeScheduler.queueInboundPayload(payload, context);
  }

  function handlePlaybackTimelineStarted(
    playbackClock: MotionPlaybackClockContext,
  ): boolean {
    const queuedMotionStarted =
      runtimeScheduler.handlePlaybackTimelineStarted(playbackClock);
    if (queuedMotionStarted) {
      return true;
    }

    const normalizedMessageId =
      typeof playbackClock.messageId === "string"
        ? playbackClock.messageId.trim()
        : "";
    if (!normalizedMessageId) {
      return false;
    }
    if (
      playbackClock.source !== "audio"
      || (playbackClock.phase !== "playing" && playbackClock.phase !== "paused")
    ) {
      return false;
    }
    if (!dependencies.canStartSpeechOnlyMotion(playbackClock.turnId, normalizedMessageId)) {
      return false;
    }
    const speechOnlyRequest = buildSpeechOnlyMotionRequest(
      dependencies.getSelectedModel(),
    );
    if (!speechOnlyRequest) {
      return false;
    }

    const key = buildSegmentKey(playbackClock.turnId, normalizedMessageId);
    const prepared = preparedSemanticMotions.get(key)?.prepared ?? null;
    preparedSemanticMotions.delete(key);
    const started = startSpeechOnlyMotionRequest(
      speechOnlyRequest,
      {
        messageId: normalizedMessageId,
        turnId: playbackClock.turnId,
        playbackTurnId: playbackClock.turnId,
        startReason: "speech_only",
        queuedDelayMs: 0,
        playbackClock,
      },
      motionStartDependencies,
      runtimeStateController,
      prepared,
    );
    if (!started) {
      const turnId = normalizeTurnId(playbackClock.turnId);
      if (!turnId) {
        throw new Error("Speech-only motion rejection requires a turnId.");
      }
      dependencies.onMotionRejected({
        turnId,
        messageId: normalizedMessageId,
        reason: state.lastCompileReason || "speech_only_motion_start_failed",
      });
    }
    return started;
  }

  function preparePlaybackTimeline(
    playbackClock: MotionPlaybackClockContext,
  ): MotionTimelinePreparationResult {
    if (
      playbackClock.source !== "audio"
      || playbackClock.phase === "terminal"
      || typeof playbackClock.durationMs !== "number"
      || !Number.isFinite(playbackClock.durationMs)
      || playbackClock.durationMs <= 0
    ) {
      return {
        status: "failed",
        reason: "motion_preparation_requires_active_audio_duration",
      };
    }

    const normalizedMessageId = playbackClock.messageId.trim();
    if (!normalizedMessageId) {
      return {
        status: "failed",
        reason: "motion_preparation_message_id_missing",
      };
    }
    const key = buildSegmentKey(playbackClock.turnId, normalizedMessageId);
    const preparation = runtimeScheduler.getPendingPayloadForTimeline(playbackClock);
    let payload: Extract<NormalizedMotionPayload, { kind: "semantic_intent" }> | null = null;
    let speechOnlyRequest: SpeechOnlyMotionRequest | null = null;
    let context: StartPayloadContext;
    let source: "queued_motion" | "speech_only";

    if (preparation) {
      if (preparation.payload.kind !== "semantic_intent") {
        return { status: "prepared", source: "queued_motion" };
      }
      payload = preparation.payload;
      context = preparation.context;
      source = "queued_motion";
    } else {
      if (!dependencies.canStartSpeechOnlyMotion(playbackClock.turnId, normalizedMessageId)) {
        return {
          status: "not_applicable",
          reason: "speech_only_motion_not_required",
        };
      }
      speechOnlyRequest = buildSpeechOnlyMotionRequest(dependencies.getSelectedModel());
      if (!speechOnlyRequest) {
        return {
          status: "not_applicable",
          reason: "speech_only_motion_profile_unavailable",
        };
      }
      source = "speech_only";
      context = {
        messageId: normalizedMessageId,
        turnId: playbackClock.turnId,
        playbackTurnId: playbackClock.turnId,
        startReason: "speech_only_preparing",
        queuedDelayMs: 0,
        playbackClock,
      };
    }

    const durationMs = Math.round(playbackClock.durationMs);
    const selectedModelPath = dependencies.getSelectedModel()?.model_path.trim() ?? "";
    const cached = preparedSemanticMotions.get(key);
    if (
      cached
      && cached.durationMs === durationMs
      && cached.prepared.modelPath === selectedModelPath
    ) {
      return { status: "prepared", source };
    }

    const prepared = source === "speech_only"
      ? prepareSpeechOnlyMotionRequest(
          speechOnlyRequest as SpeechOnlyMotionRequest,
          context,
          motionStartDependencies,
          runtimeStateController,
        )
      : prepareSemanticMotionPayload(
          payload as Extract<NormalizedMotionPayload, { kind: "semantic_intent" }>,
          context,
          motionStartDependencies,
          runtimeStateController,
        );
    if (!prepared) {
      preparedSemanticMotions.delete(key);
      return {
        status: "failed",
        reason: state.lastCompileReason || "motion_preparation_failed",
      };
    }
    preparedSemanticMotions.set(key, { durationMs, prepared });
    return { status: "prepared", source };
  }

  function notifyCurrentTurnChanged(turnId: string | null): void {
    runtimeScheduler.notifyCurrentTurnChanged(turnId);
    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedTurnId) {
      return;
    }
    for (const key of preparedSemanticMotions.keys()) {
      if (!key.startsWith(`${normalizedTurnId.length}:${normalizedTurnId}:`)) {
        preparedSemanticMotions.delete(key);
      }
    }
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
      motionStartDependencies,
      runtimeStateController,
    );
  }

  function stop(reason = "stopped"): void {
    runtimeScheduler.clearAllPendingPayloads();
    preparedSemanticMotions.clear();
    activePlaybackOwner = null;
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

  function interruptPlaybackSegment(
    turnId: string | null,
    messageId: string,
    reason: string,
  ): void {
    runtimeScheduler.cancelPendingPayloadForSegment(turnId, messageId);
    preparedSemanticMotions.delete(buildSegmentKey(turnId, messageId));
    if (
      activePlaybackOwner?.turnId !== normalizeTurnId(turnId)
      || activePlaybackOwner.messageId !== messageId.trim()
    ) {
      return;
    }
    activePlaybackOwner = null;
    dependencies.stopPlan(reason);
    state.lastCompileReason = "";
    setState("idle", `动作引擎已停止（${reason}）。`, null);
  }

  return {
    state: readonly(state),
    ingestInboundPayload,
    ingestNormalizedPayload,
    preparePlaybackTimeline,
    handlePlaybackTimelineStarted,
    notifyCurrentTurnChanged,
    playPreviewPayload,
    interruptPlaybackSegment,
    stop,
    stageRegistry,
  };
}
