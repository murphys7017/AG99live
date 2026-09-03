import { reactive, readonly } from "vue";
import {
  createMotionRuntimeScheduler,
  type StartPayloadContext,
} from "./runtime/motionRuntimeScheduler.js";
import {
  buildSpeechOnlyMotionRequest,
  type SpeechOnlyMotionRequest,
} from "./runtime/speechOnlyMotion.js";
import type {
  InboundPayloadContext,
  MotionPlaybackClockReader,
} from "./contracts.js";
import type { NormalizedMotionPayload } from "../types/motion.js";
import type {
  MotionPlanPayload,
  OutputSegmentSpeechCue,
} from "../types/protocol.js";
import type {
  CompileDiagnostics,
  CompiledSemanticMotion,
} from "../types/compiledSemanticMotion.js";
import { compileModelParameterPlan } from "./compiler/compileModelParameterPlan.js";
import type {
  ModelEngineDependencies,
  ModelEngineActivePlaybackRun,
  ModelEngineHistoryRole,
  ModelEnginePlaybackTerminalEvent,
  ModelEngineStatus,
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

function buildSpeechCueKey(cues: readonly OutputSegmentSpeechCue[]): string {
  return cues
    .map((cue) => `${cue.kind}:${cue.phrase_index}:${cue.position}`)
    .join("|");
}

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
  let activePlaybackRun: ModelEngineActivePlaybackRun | null = null;
  const preparedSemanticMotions = new Map<string, {
    durationMs: number;
    assistantText: string;
    speechCueKey: string;
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
    // An active run owns the public execution state. Preparation or start
    // failures from a replacement candidate remain diagnostics until that
    // candidate actually becomes the active run.
    if (activePlaybackRun && status !== "playing") {
      return;
    }
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

  const motionStartDependencies: MotionStartDependencies = {
    getSelectedModel: dependencies.getSelectedModel,
    getSettings: dependencies.getSettings,
    playPlan: dependencies.playPlan,
    playMotionResource: dependencies.playMotionResource,
    getPlayerMessage: dependencies.getPlayerMessage,
    onPlanStarted: (event) => {
      activePlaybackRun = {
        runId: event.runId,
        origin: event.playbackOrigin,
        turnId: normalizeTurnId(event.turnId),
        messageId: event.messageId.trim(),
        payloadKind: event.payloadKind,
      };
      dependencies.onPlanStarted(event);
    },
    onMotionRejected: (event) => {
      dependencies.onMotionRejected(event);
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

  const runtimeScheduler = createMotionRuntimeScheduler({
    onPendingStateChanged: (pendingCount, pendingMessageId) => {
      state.pendingCount = pendingCount;
      state.pendingMessageId = pendingMessageId;
    },
    onPendingStatus: (message) => {
      setState("pending", message, null);
    },
    onStartPayload: (payload: NormalizedMotionPayload, context: StartPayloadContext) => {
      const key = buildSegmentKey(context.turnId, context.messageId);
      const cached = preparedSemanticMotions.get(key);
      const prepared = payload.kind === "semantic_intent"
        && cached?.assistantText === context.assistantText
        && cached.speechCueKey === buildSpeechCueKey(context.speechCues)
        ? cached.prepared
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
        reason: state.lastCompileReason || context.startReason,
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
    playbackClockReader: MotionPlaybackClockReader,
    assistantText: string,
    speechCues: readonly OutputSegmentSpeechCue[],
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
      || playbackClock.phase === "terminal"
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
    const cached = preparedSemanticMotions.get(key);
    const prepared = cached?.assistantText === assistantText
      && cached.speechCueKey === buildSpeechCueKey(speechCues)
      ? cached.prepared
      : null;
    preparedSemanticMotions.delete(key);
    const started = startSpeechOnlyMotionRequest(
      speechOnlyRequest,
      {
        messageId: normalizedMessageId,
        turnId: playbackClock.turnId,
        assistantText,
        speechCues,
        playbackTurnId: playbackClock.turnId,
        playbackOrigin: "conversation",
        startReason: "speech_only",
        queuedDelayMs: 0,
        playbackClock,
        playbackClockReader,
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
    assistantText: string,
    speechCues: readonly OutputSegmentSpeechCue[],
  ): MotionTimelinePreparationResult {
    const audioDurationMs = typeof playbackClock.durationMs === "number"
      && Number.isFinite(playbackClock.durationMs)
      && playbackClock.durationMs > 0
      ? playbackClock.durationMs
      : null;
    if (
      playbackClock.source !== "audio_pending"
      && playbackClock.source !== "audio"
      || playbackClock.phase === "terminal"
      || audioDurationMs === null
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
      context = {
        ...preparation.context,
        assistantText,
        speechCues,
      };
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
        assistantText,
        speechCues,
        playbackTurnId: playbackClock.turnId,
        playbackOrigin: "conversation",
        startReason: "speech_only_preparing",
        queuedDelayMs: 0,
        playbackClock,
      };
    }

    const durationMs = Math.round(audioDurationMs);
    const selectedModel = dependencies.getSelectedModel();
    const selectedModelPath = selectedModel?.model_path.trim() ?? "";
    const selectedProfile = selectedModel?.semantic_axis_profile ?? null;
    const cached = preparedSemanticMotions.get(key);
    const speechCueKey = buildSpeechCueKey(speechCues);
    if (
      cached
      && cached.durationMs === durationMs
      && cached.assistantText === assistantText
      && cached.speechCueKey === speechCueKey
      && cached.prepared.modelPath === selectedModelPath
      && selectedProfile !== null
      && cached.prepared.profileId === selectedProfile.profile_id
      && cached.prepared.profileRevision === selectedProfile.revision
      && cached.prepared.profileSourceHash === selectedProfile.source_hash
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
      const reason = state.lastCompileReason || "motion_preparation_failed";
      if (source === "queued_motion") {
        runtimeScheduler.failPendingPayloadForSegment(
          playbackClock.turnId,
          normalizedMessageId,
          reason,
        );
      } else {
        const turnId = normalizeTurnId(playbackClock.turnId);
        if (!turnId) {
          throw new Error("Speech-only motion preparation failure requires a turnId.");
        }
        dependencies.onMotionRejected({
          turnId,
          messageId: normalizedMessageId,
          reason,
        });
      }
      return {
        status: "failed",
        reason,
        source,
      };
    }
    preparedSemanticMotions.set(key, {
      durationMs,
      assistantText,
      speechCueKey,
      prepared,
    });
    return { status: "prepared", source };
  }

  function startCompiledPreviewPlan(
    plan: MotionPlanPayload,
    semanticMotion: CompiledSemanticMotion,
    requestId: string,
  ): boolean {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      state.lastCompileReason = "manual_preview_request_id_missing";
      return false;
    }
    if (activePlaybackRun?.origin === "conversation") {
      state.lastCompileReason = "manual_preview_rejected_conversation_motion_active";
      pushHistory("error", "动作预览被拒绝：当前会话动作仍在播放。");
      return false;
    }

    const selectedModel = dependencies.getSelectedModel();
    if (!selectedModel) {
      state.lastCompileReason = "missing_selected_model";
      return false;
    }
    let notifiedStarted = false;
    const notifyStarted = (runId: string, startedPlan: MotionPlanPayload): void => {
      const normalizedRunId = runId.trim();
      if (!normalizedRunId) {
        return;
      }
      notifiedStarted = true;
      motionStartDependencies.onPlanStarted({
        model: selectedModel,
        messageId: normalizedRequestId,
        turnId: null,
        playbackTurnId: null,
        playbackOrigin: "manual_preview",
        startReason: "compiled_semantic_motion_preview",
        queuedDelayMs: 0,
        payloadKind: "compiled_semantic_motion",
        executionKind: "parameter_plan",
        diagnostics: semanticMotion.diagnostics,
        semanticMotion,
        plan: startedPlan,
        playerMessage: dependencies.getPlayerMessage?.() || "动作预览播放中。",
        runId: normalizedRunId,
      });
    };
    const startResult = dependencies.playPlan(plan, selectedModel, {
      requiresPlaybackClock: false,
      onStarted: (startedPlan, runId) => notifyStarted(runId, startedPlan),
    });
    if (startResult.status === "rejected") {
      state.lastCompileReason = startResult.reason.trim()
        || "compiled_semantic_motion_preview_start_failed";
      setState("failed", state.lastCompileReason, semanticMotion.diagnostics);
      return false;
    }
    if (!notifiedStarted) {
      state.lastCompileReason = "motion_player_started_without_run_id";
      setState("failed", state.lastCompileReason, semanticMotion.diagnostics);
      return false;
    }
    setState("playing", "动作预览播放中。", semanticMotion.diagnostics);
    return true;
  }

  function previewCompiledSemanticMotion(
    semanticMotion: CompiledSemanticMotion,
    requestId: string,
  ): boolean {
    const selectedModel = dependencies.getSelectedModel();
    if (!selectedModel) {
      state.lastCompileReason = "missing_selected_model";
      return false;
    }
    const result = compileModelParameterPlan(
      semanticMotion,
      {
        model: selectedModel,
        source: "manual_preview",
        settings: dependencies.getSettings(),
        samplingIdentity: { turnId: "", messageId: requestId.trim() },
      },
      stageRegistry,
    );
    state.lastCompileReason = result.reason;
    state.lastCompileDiagnostics = result.diagnostics;
    if (!result.ok || !result.plan) {
      return false;
    }
    return startCompiledPreviewPlan(result.plan, semanticMotion, requestId);
  }

  function handlePlaybackTerminal(
    event: ModelEnginePlaybackTerminalEvent,
  ): ModelEngineActivePlaybackRun | null {
    const completedRun = activePlaybackRun?.runId === event.runId
      ? activePlaybackRun
      : null;
    if (!completedRun) {
      return null;
    }
    if (activePlaybackRun?.runId === event.runId) {
      activePlaybackRun = null;
    }
    if (event.status === "failed" || event.status === "rejected") {
      setState(
        "failed",
        event.reason || "动作执行失败。",
        state.lastCompileDiagnostics,
      );
    } else {
      setState(
        "idle",
        event.reason ? `动作已停止（${event.reason}）。` : "动作执行完成。",
        null,
      );
    }
    return completedRun;
  }

  function stopActivePlayback(reason: string, idleMessage: string): void {
    let stopFailed = false;
    let stopError: unknown = null;
    try {
      dependencies.stopPlan(reason);
    } catch (error) {
      stopFailed = true;
      stopError = error;
      console.error("[ModelEngine] active playback stop failed.", { reason, error });
    } finally {
      activePlaybackRun = null;
      state.lastCompileReason = "";
      if (stopFailed) {
        setState("failed", `动作引擎停止失败（${reason}）。`, null);
      } else {
        setState("idle", idleMessage, null);
      }
    }
    if (stopFailed) {
      throw stopError;
    }
  }

  function stop(reason = "stopped"): void {
    runtimeScheduler.clearAllPendingPayloads();
    preparedSemanticMotions.clear();
    stopActivePlayback(
      reason,
      reason === "stopped"
        ? "动作引擎已停止。"
        : `动作引擎已停止（${reason}）。`,
    );
  }

  function interruptPlaybackSegment(
    turnId: string | null,
    messageId: string,
    reason: string,
  ): void {
    runtimeScheduler.cancelPendingPayloadForSegment(turnId, messageId);
    preparedSemanticMotions.delete(buildSegmentKey(turnId, messageId));
    const normalizedTurnId = normalizeTurnId(turnId);
    const normalizedMessageId = messageId.trim();
    const activeRunMatches = activePlaybackRun?.turnId === normalizedTurnId
      && activePlaybackRun.messageId === normalizedMessageId;
    if (!activeRunMatches) {
      return;
    }
    stopActivePlayback(reason, `动作引擎已停止（${reason}）。`);
  }

  return {
    state: readonly(state),
    ingestInboundPayload,
    ingestNormalizedPayload,
    preparePlaybackTimeline,
    handlePlaybackTimelineStarted,
    previewCompiledSemanticMotion,
    handlePlaybackTerminal,
    interruptPlaybackSegment,
    stop,
    stageRegistry,
  };
}
