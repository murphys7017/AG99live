import { reactive, readonly } from "vue";
import {
  createMotionRuntimeScheduler,
  type StartPayloadContext,
} from "./runtime/motionRuntimeScheduler.js";
import { buildSpeechOnlyMotionPayload } from "./runtime/speechOnlyMotion.js";
import type { InboundPayloadContext, NormalizedMotionPayload } from "./contracts.js";
import type { CompileDiagnostics } from "./compiler/contracts.js";
import type {
  ModelEngineDependencies,
  ModelEngineHistoryRole,
  ModelEngineStatus,
  MotionRuntimeSchedulerDependencies,
  MotionStartDependencies,
} from "./runtime/contracts.js";
import type { PlaybackTimelineSnapshot } from "../playback-timeline/contracts.js";
import { normalizeMotionPayload, normalizeTurnId } from "./normalize.js";
import {
  reportInvalidMotionPayload,
  startNormalizedMotionPayload,
} from "./runtime/motionStart.js";

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
  let activePlaybackOwner: { turnId: string | null; messageId: string } | null = null;

  function pushHistory(
    role: ModelEngineHistoryRole,
    text: string,
  ): void {
    dependencies.pushHistory?.(role, text);
  }

  const runtimeSchedulerDependencies: MotionRuntimeSchedulerDependencies = {
    getCurrentTurnId: dependencies.getCurrentTurnId,
    sessionStore: dependencies.sessionStore,
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
    onStartPayload: (payload: NormalizedMotionPayload, context: StartPayloadContext) =>
      startNormalizedMotionPayload(
        payload,
        context,
        motionStartDependencies,
        runtimeStateController,
      ),
    onStartFailed: (context: StartPayloadContext) => {
      if (context.playbackTimeline) {
        dependencies.markMotionTimelineTerminal(
          context.turnId,
          context.messageId,
          "failed",
          context.startReason,
        );
        return;
      }
      runtimeSchedulerDependencies.sessionStore?.markMotionFailed?.(
        context.turnId,
        context.messageId,
        context.startReason,
      );
    },
  });

  function ingestInboundPayload(
    payload: unknown,
    context: InboundPayloadContext,
  ): boolean {
    const normalized = normalizeMotionPayload(payload);
    if (!normalized.ok) {
      reportInvalidMotionPayload(normalized.reason, runtimeStateController);
      runtimeSchedulerDependencies.sessionStore?.markMotionFailed?.(
        context.turnId,
        context.messageId,
        normalized.reason,
      );
      return false;
    }
    runtimeScheduler.queueInboundPayload(normalized.payload, context);
    return true;
  }

  function ingestNormalizedPayload(
    payload: NormalizedMotionPayload,
    context: InboundPayloadContext,
  ): boolean {
    runtimeScheduler.queueInboundPayload(payload, context);
    return true;
  }

  function handlePlaybackTimelineStarted(
    playbackTimeline: PlaybackTimelineSnapshot,
  ): boolean {
    const queuedMotionStarted =
      runtimeScheduler.handlePlaybackTimelineStarted(playbackTimeline);
    if (queuedMotionStarted) {
      return true;
    }

    const normalizedMessageId =
      typeof playbackTimeline.messageId === "string"
        ? playbackTimeline.messageId.trim()
        : "";
    if (!normalizedMessageId) {
      return false;
    }
    if (
      playbackTimeline.clockSource !== "audio"
      || (playbackTimeline.phase !== "playing" && playbackTimeline.phase !== "paused")
    ) {
      return false;
    }
    if (!dependencies.canStartSpeechOnlyMotion(playbackTimeline.turnId, normalizedMessageId)) {
      return false;
    }
    const speechOnlyPayload = buildSpeechOnlyMotionPayload(
      dependencies.getSelectedModel(),
    );
    if (!speechOnlyPayload) {
      return false;
    }

    return startNormalizedMotionPayload(
      speechOnlyPayload,
      {
        messageId: normalizedMessageId,
        turnId: playbackTimeline.turnId,
        playbackTurnId: playbackTimeline.turnId,
        startReason: "speech_only",
        queuedDelayMs: 0,
        playbackTimeline,
      },
      motionStartDependencies,
      runtimeStateController,
    );
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
      motionStartDependencies,
      runtimeStateController,
    );
  }

  function stop(reason = "stopped"): void {
    runtimeScheduler.clearAllPendingPayloads();
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
    handlePlaybackTimelineStarted,
    notifyCurrentTurnChanged,
    playPreviewPayload,
    interruptPlaybackSegment,
    stop,
  };
}
