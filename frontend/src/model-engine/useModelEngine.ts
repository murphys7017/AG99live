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
import { normalizeMotionPayload } from "./normalize.js";
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

function normalizePlaybackTurnId(turnId: string | null): string | null {
  const normalized = typeof turnId === "string" ? turnId.trim() : "";
  return normalized || null;
}

function matchesPlaybackTimeline(
  timeline: PlaybackTimelineSnapshot | null,
  turnId: string | null,
  messageId: string,
): boolean {
  return Boolean(
    timeline
    && timeline.messageId === messageId
    && normalizePlaybackTurnId(timeline.turnId) === normalizePlaybackTurnId(turnId),
  );
}

export function useModelEngine(dependencies: ModelEngineDependencies) {
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
    onPlanStarted: dependencies.onPlanStarted,
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
        {
          resolveMotionTargetDurationMs: runtimeScheduler.resolveMotionTargetDurationMs,
          isSpeechActiveForPayload: runtimeScheduler.isSpeechActiveForPayload,
        },
        runtimeStateController,
      ),
    onStartFailed: (context: StartPayloadContext) => {
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

  function notifyAudioPlaybackStarted(
    turnId: string | null,
    messageId: string | null = null,
    playbackTimeline: PlaybackTimelineSnapshot | null = null,
  ): boolean {
    const queuedMotionStarted =
      runtimeScheduler.notifyAudioPlaybackStarted(
        turnId,
        messageId,
        playbackTimeline,
      );
    if (queuedMotionStarted) {
      return true;
    }

    const normalizedMessageId =
      typeof messageId === "string" ? messageId.trim() : "";
    if (!normalizedMessageId) {
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
        turnId,
        playbackTurnId: turnId,
        startReason: "speech_only",
        queuedDelayMs: 0,
        playbackTimeline: matchesPlaybackTimeline(
          playbackTimeline,
          turnId,
          normalizedMessageId,
        )
          ? playbackTimeline
          : null,
      },
      motionStartDependencies,
      {
        resolveMotionTargetDurationMs: runtimeScheduler.resolveMotionTargetDurationMs,
        isSpeechActiveForPayload: runtimeScheduler.isSpeechActiveForPayload,
      },
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
      {
        resolveMotionTargetDurationMs: runtimeScheduler.resolveMotionTargetDurationMs,
        isSpeechActiveForPayload: runtimeScheduler.isSpeechActiveForPayload,
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
