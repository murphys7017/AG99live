import { reactive, shallowReadonly, ref, watch, type Ref } from "vue";
import type { ModelEnginePlanStartedEvent } from "../model-engine/contracts";
import type { DesktopMotionPlaybackRecord } from "../types/desktop";
import type { ModelSummary } from "../types/protocol";
import type { useAdapterConnection } from "./useAdapterConnection";
import type { usePreviewMotionPlayer } from "./usePreviewMotionPlayer";
import { cloneJson } from "../utils/cloneJson";

type AdapterConnection = ReturnType<typeof useAdapterConnection>;
type PreviewMotionPlayer = ReturnType<typeof usePreviewMotionPlayer>;

const DEFAULT_MAX_MOTION_PLAYBACK_RECORDS = 5;
const PLAYBACK_SETTLEMENT_WINDOW_MS = 900;

interface PlaybackCompletionCoordinatorOptions {
  adapter: AdapterConnection;
  motionPlayer: PreviewMotionPlayer;
  selectedModel: Ref<ModelSummary | null>;
  onAudioPlaybackStarted: (turnId: string | null) => void;
  initialMotionPlaybackRecords?: readonly DesktopMotionPlaybackRecord[];
  maxMotionPlaybackRecords?: number;
}

export function usePlaybackCompletionCoordinator(
  options: PlaybackCompletionCoordinatorOptions,
) {
  const motionPlaybackRecords = ref<DesktopMotionPlaybackRecord[]>(
    (options.initialMotionPlaybackRecords ?? []).map((record) =>
      cloneJson(record) as DesktopMotionPlaybackRecord),
  );
  const maxMotionPlaybackRecords =
    options.maxMotionPlaybackRecords ?? DEFAULT_MAX_MOTION_PLAYBACK_RECORDS;
  const playbackCoordination = reactive({
    activeTurnId: null as string | null,
    activeOrchestrationId: null as string | null,
    textDelivered: false,
    audioObserved: false,
    audioCompleted: false,
    audioFailed: false,
    motionStarted: false,
    motionCompleted: false,
    motionExpected: false,
    awaitingLateMotion: false,
    turnFinishedObserved: false,
    turnFinishedSuccess: true,
    completionSent: false,
    settlementTimer: 0,
  });

  function clearPlaybackSettlementTimer(): void {
    if (playbackCoordination.settlementTimer) {
      window.clearTimeout(playbackCoordination.settlementTimer);
      playbackCoordination.settlementTimer = 0;
    }
  }

  function resetPlaybackCoordination(): void {
    clearPlaybackSettlementTimer();
    playbackCoordination.activeTurnId = null;
    playbackCoordination.activeOrchestrationId = null;
    playbackCoordination.textDelivered = false;
    playbackCoordination.audioObserved = false;
    playbackCoordination.audioCompleted = false;
    playbackCoordination.audioFailed = false;
    playbackCoordination.motionStarted = false;
    playbackCoordination.motionCompleted = false;
    playbackCoordination.motionExpected = false;
    playbackCoordination.awaitingLateMotion = false;
    playbackCoordination.turnFinishedObserved = false;
    playbackCoordination.turnFinishedSuccess = true;
    playbackCoordination.completionSent = false;
  }

  function ensurePlaybackCoordination(
    turnId: string | null,
    orchestrationId: string | null,
  ): void {
    const turnChanged = playbackCoordination.activeTurnId !== turnId;
    const orchestrationChanged =
      playbackCoordination.activeOrchestrationId !== orchestrationId;
    if (turnChanged || orchestrationChanged) {
      resetPlaybackCoordination();
      playbackCoordination.activeTurnId = turnId;
      playbackCoordination.activeOrchestrationId = orchestrationId;
    }
  }

  function shouldSendPlaybackFinished(): boolean {
    if (playbackCoordination.completionSent) {
      return false;
    }
    if (!playbackCoordination.textDelivered) {
      return false;
    }
    if (!playbackCoordination.audioObserved) {
      return false;
    }
    if (!playbackCoordination.audioCompleted && !playbackCoordination.audioFailed) {
      return false;
    }
    if (playbackCoordination.awaitingLateMotion) {
      return false;
    }
    if (!playbackCoordination.motionExpected) {
      return true;
    }
    if (!playbackCoordination.motionStarted) {
      return false;
    }
    return playbackCoordination.motionCompleted;
  }

  function isPlaybackAckRequired(): boolean {
    const terminalState = options.adapter.state.audioPlaybackTerminalState;
    return terminalState === "completed" || terminalState === "failed";
  }

  function finalizePlaybackCoordination(): void {
    const turnId = playbackCoordination.activeTurnId;
    const orchestrationId = playbackCoordination.activeOrchestrationId;
    options.adapter.clearPlaybackGroupContext(turnId, orchestrationId);
    resetPlaybackCoordination();
  }

  function maybeFlushPlaybackCompletion(reason?: string): void {
    if (playbackCoordination.completionSent) {
      if (playbackCoordination.turnFinishedObserved) {
        finalizePlaybackCoordination();
      }
      return;
    }
    if (!shouldSendPlaybackFinished()) {
      return;
    }
    if (!isPlaybackAckRequired()) {
      if (playbackCoordination.turnFinishedObserved) {
        finalizePlaybackCoordination();
      }
      return;
    }
    const turnId = playbackCoordination.activeTurnId;
    const orchestrationId = playbackCoordination.activeOrchestrationId;
    const success = !playbackCoordination.audioFailed;
    playbackCoordination.completionSent = true;
    void options.adapter.sendPlaybackFinishedForCurrentGroup(
      turnId,
      orchestrationId,
      success,
      reason,
    );
  }

  function schedulePlaybackSettlementWindow(): void {
    clearPlaybackSettlementTimer();
    playbackCoordination.awaitingLateMotion = true;
    playbackCoordination.settlementTimer = window.setTimeout(() => {
      playbackCoordination.awaitingLateMotion = false;
      if (!playbackCoordination.motionStarted) {
        playbackCoordination.motionExpected = false;
      }
      maybeFlushPlaybackCompletion("audio_and_motion_settled");
    }, PLAYBACK_SETTLEMENT_WINDOW_MS);
  }

  function recordMotionPlayback(event: ModelEnginePlanStartedEvent): void {
    ensurePlaybackCoordination(event.turnId, event.orchestrationId);
    playbackCoordination.motionExpected = true;
    playbackCoordination.motionStarted = true;
    playbackCoordination.motionCompleted = false;
    playbackCoordination.awaitingLateMotion = false;
    clearPlaybackSettlementTimer();
    const now = new Date();
    const record: DesktopMotionPlaybackRecord = {
      id: `motion-record-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now.toISOString(),
      source: event.diagnostics?.source || event.startReason,
      payloadKind: event.payloadKind,
      turnId: event.turnId,
      orchestrationId: event.orchestrationId,
      modelName: event.model?.name ?? options.selectedModel.value?.name ?? "",
      emotionLabel: event.plan.emotion_label,
      mode: event.plan.mode,
      startReason: event.startReason,
      queuedDelayMs: event.queuedDelayMs,
      assistantText: options.adapter.state.lastAssistantText,
      playerMessage: event.playerMessage,
      diagnostics: event.diagnostics
        ? {
          ...event.diagnostics,
          axisIntensityScale: { ...event.diagnostics.axisIntensityScale },
        }
        : null,
      plan: cloneJson(event.plan),
    };
    motionPlaybackRecords.value = [
      record,
      ...motionPlaybackRecords.value,
    ].slice(0, maxMotionPlaybackRecords);
  }

  watch(
    () => options.adapter.state.audioPlaybackStartedNonce,
    () => {
      ensurePlaybackCoordination(
        options.adapter.state.audioPlaybackStartedTurnId,
        options.adapter.state.audioPlaybackStartedOrchestrationId,
      );
      playbackCoordination.audioObserved = true;
      playbackCoordination.audioFailed = false;
      playbackCoordination.audioCompleted = false;
      options.onAudioPlaybackStarted(options.adapter.state.audioPlaybackStartedTurnId);
    },
  );

  watch(
    () => options.adapter.state.assistantTextDeliveryNonce,
    () => {
      ensurePlaybackCoordination(
        options.adapter.state.assistantTextDeliveryTurnId,
        options.adapter.state.assistantTextDeliveryOrchestrationId,
      );
      playbackCoordination.textDelivered = true;
      maybeFlushPlaybackCompletion("text_audio_motion_completed");
    },
  );

  watch(
    () => options.adapter.state.audioPlaybackTerminalNonce,
    () => {
      ensurePlaybackCoordination(
        options.adapter.state.audioPlaybackTerminalTurnId,
        options.adapter.state.audioPlaybackTerminalOrchestrationId,
      );
      const terminalState = options.adapter.state.audioPlaybackTerminalState;
      if (terminalState === "idle") {
        return;
      }
      playbackCoordination.audioObserved = true;
      playbackCoordination.audioCompleted =
        terminalState === "completed" || terminalState === "not_requested";
      playbackCoordination.audioFailed = terminalState === "failed";
      if (!playbackCoordination.motionStarted || playbackCoordination.motionCompleted) {
        schedulePlaybackSettlementWindow();
        return;
      }
      maybeFlushPlaybackCompletion(
        options.adapter.state.audioPlaybackTerminalReason || "audio_terminal",
      );
    },
  );

  watch(
    () => options.motionPlayer.state.status,
    (status, previousStatus) => {
      if (status !== "finished" || previousStatus !== "playing") {
        return;
      }
      playbackCoordination.motionCompleted = true;
      if (playbackCoordination.audioObserved) {
        maybeFlushPlaybackCompletion("motion_completed_after_audio");
      }
    },
  );

  watch(
    () => options.adapter.state.turnFinishedNonce,
    () => {
      ensurePlaybackCoordination(
        options.adapter.state.turnFinishedTurnId,
        options.adapter.state.turnFinishedOrchestrationId,
      );
      playbackCoordination.turnFinishedObserved = true;
      playbackCoordination.turnFinishedSuccess = options.adapter.state.turnFinishedSuccess;
      maybeFlushPlaybackCompletion(options.adapter.state.turnFinishedReason || "turn_finished");
    },
  );

  return {
    motionPlaybackRecords: shallowReadonly(motionPlaybackRecords),
    recordMotionPlayback,
    resetPlaybackCoordination,
  };
}
