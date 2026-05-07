import { shallowReadonly, ref, watch, type Ref } from "vue";
import type { ModelEnginePlanStartedEvent } from "../model-engine/contracts";
import type { DesktopMotionPlaybackRecord } from "../types/desktop";
import type { ModelSummary } from "../types/protocol";
import type { useAdapterConnection } from "./useAdapterConnection";
import type { usePreviewMotionPlayer } from "./usePreviewMotionPlayer";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import { isReadyToAckPlaybackFinished } from "../turn-playback/selectors.js";
import { orchestrationIdFromSessionId } from "../turn-playback/session.js";
import { cloneJson } from "../utils/cloneJson.js";

type AdapterConnection = ReturnType<typeof useAdapterConnection>;
type PreviewMotionPlayer = ReturnType<typeof usePreviewMotionPlayer>;
type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

const DEFAULT_MAX_MOTION_PLAYBACK_RECORDS = 5;
const PLAYBACK_SETTLEMENT_WINDOW_MS = 900;

interface PlaybackCompletionCoordinatorOptions {
  sessionStore: SessionStore;
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

  // Lightweight internal state — session is the single source of truth
  let completionSent = false;
  let settlementTimer = 0;

  // ── helpers ─────────────────────────────────────────────────────

  function getActiveSession() {
    return options.sessionStore.getActiveSession();
  }

  function clearSettlementTimer(): void {
    if (settlementTimer) {
      window.clearTimeout(settlementTimer);
      settlementTimer = 0;
    }
  }

  function resetPlaybackCoordination(): void {
    clearSettlementTimer();
    completionSent = false;
  }

  function isPlaybackAckRequired(): boolean {
    const s = getActiveSession();
    if (!s) return false;
    return s.audio.terminal !== "idle";
  }

  function finalizeCompletion(): void {
    const s = getActiveSession();
    if (!s) return;
    const orchId = orchestrationIdFromSessionId(s.id);
    options.adapter.clearPlaybackGroupContext(s.turnId, orchId);
    options.sessionStore.markPhase(orchId, s.turnId, "completed");
    resetPlaybackCoordination();
  }

  function maybeFlushPlaybackCompletion(reason?: string): void {
    if (completionSent) {
      const s = getActiveSession();
      if (s?.backend.turnFinished) {
        finalizeCompletion();
      }
      return;
    }

    const s = getActiveSession();
    if (!s) return;

    // Never re-ack a session that already reached a terminal phase
    if (s.phase === "completed" || s.phase === "failed") {
      return;
    }

    if (!isReadyToAckPlaybackFinished(s)) {
      return;
    }

    if (!isPlaybackAckRequired()) {
      if (s.backend.turnFinished) {
        finalizeCompletion();
      }
      return;
    }

    const orchId = orchestrationIdFromSessionId(s.id);
    const success = s.audio.terminal !== "failed";
    completionSent = true;
    options.sessionStore.markPhase(orchId, s.turnId, "settling");
    void options.adapter.sendPlaybackFinishedForCurrentGroup(
      s.turnId,
      orchId,
      success,
      reason,
    );
    // If turn_finished was already observed before the ack was sent,
    // finalize immediately — no further watcher will fire.
    if (s.backend.turnFinished) {
      finalizeCompletion();
    }
  }

  function schedulePlaybackSettlementWindow(): void {
    clearSettlementTimer();
    settlementTimer = window.setTimeout(() => {
      // If motion payload exists but never started (orchestrator chose not to
      // wait for it), mark it as completed so the ack can proceed.
      const s = getActiveSession();
      if (s && s.motion.payload && !s.motion.started) {
        options.sessionStore.markMotionCompleted(
          orchestrationIdFromSessionId(s.id),
          s.turnId,
        );
      }
      maybeFlushPlaybackCompletion("audio_and_motion_settled");
    }, PLAYBACK_SETTLEMENT_WINDOW_MS);
  }

  function recordMotionPlayback(event: ModelEnginePlanStartedEvent): void {
    clearSettlementTimer();

    // Write to session
    options.sessionStore.markMotionStarted(event.orchestrationId, event.turnId);

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

  // ── watchers: observe session, write back on completion ─────────

  // Reset when active session changes
  watch(
    () => options.sessionStore.state.activeSessionId,
    () => {
      resetPlaybackCoordination();
    },
  );

  // Audio started → notify model engine
  watch(
    () => {
      const s = getActiveSession();
      return s?.audio.started ? `${s.id}|audio_started` : null;
    },
    (key) => {
      if (!key) return;
      const s = getActiveSession();
      if (!s) return;
      options.onAudioPlaybackStarted(s.turnId);
    },
  );

  // Text delivered → try flush
  watch(
    () => {
      const s = getActiveSession();
      return s?.text.delivered ? `${s.id}|text_delivered` : null;
    },
    (key) => {
      if (!key) return;
      maybeFlushPlaybackCompletion("text_delivered");
    },
  );

  // Audio terminal → schedule settlement or flush
  watch(
    () => {
      const s = getActiveSession();
      if (!s || s.audio.terminal === "idle") return null;
      return `${s.id}|${s.audio.terminal}`;
    },
    (key) => {
      if (!key) return;
      const s = getActiveSession();
      if (!s) return;

      if (!s.motion.started || s.motion.completed) {
        // Motion already done or never started — wait for late motion via settlement window
        schedulePlaybackSettlementWindow();
        return;
      }

      // Motion is still playing — wait for it
      maybeFlushPlaybackCompletion(
        s.audio.reason || "audio_terminal",
      );
    },
  );

  // Motion completed (from motion player) → write to session, try flush
  watch(
    () => options.motionPlayer.state.status,
    (status, previousStatus) => {
      if (status !== "finished" || previousStatus !== "playing") {
        return;
      }
      const s = getActiveSession();
      if (!s) return;

      options.sessionStore.markMotionCompleted(
        orchestrationIdFromSessionId(s.id),
        s.turnId,
      );

      if (s.audio.terminal !== "idle") {
        maybeFlushPlaybackCompletion("motion_completed_after_audio");
      }
    },
  );

  // Backend turn_finished → try flush
  watch(
    () => {
      const s = getActiveSession();
      return s?.backend.turnFinished ? `${s.id}|turn_finished` : null;
    },
    (key) => {
      if (!key) return;
      maybeFlushPlaybackCompletion("turn_finished");
    },
  );

  return {
    motionPlaybackRecords: shallowReadonly(motionPlaybackRecords),
    recordMotionPlayback,
    resetPlaybackCoordination,
  };
}
