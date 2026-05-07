import { shallowReadonly, ref, watch, type Ref } from "vue";
import type { ModelEnginePlanStartedEvent } from "../model-engine/contracts";
import type { DesktopMotionPlaybackRecord } from "../types/desktop";
import type { ModelSummary } from "../types/protocol";
import type { useAdapterConnection } from "./useAdapterConnection";
import type { usePreviewMotionPlayer } from "./usePreviewMotionPlayer";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import { isPlaybackLocallySettled } from "../turn-playback/selectors.js";
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
  const settlementTimers = new Map<string, number>();
  const notifiedAudioStartedSessions = new Set<string>();
  const ackedSessions = new Set<string>();
  let currentMotionSessionId: string | null = null;

  // ── helpers ─────────────────────────────────────────────────────

  function getActiveSession() {
    return options.sessionStore.getActiveSession();
  }

  function getSession(sessionId: string | null) {
    return sessionId ? options.sessionStore.getSessionById(sessionId) : undefined;
  }

  function clearSettlementTimer(sessionId: string): void {
    const timer = settlementTimers.get(sessionId);
    if (timer) {
      window.clearTimeout(timer);
      settlementTimers.delete(sessionId);
    }
  }

  function resetPlaybackCoordination(): void {
    for (const sessionId of settlementTimers.keys()) {
      clearSettlementTimer(sessionId);
    }
    notifiedAudioStartedSessions.clear();
    ackedSessions.clear();
    currentMotionSessionId = null;
  }

  function isPlaybackAckRequired(sessionId: string): boolean {
    const s = getSession(sessionId);
    if (!s) return false;
    return s.audio.terminal !== "idle";
  }

  function finalizeCompletion(sessionId: string): void {
    const s = getSession(sessionId);
    if (!s) return;
    clearSettlementTimer(sessionId);
    const orchId = orchestrationIdFromSessionId(s.id);
    options.adapter.clearPlaybackGroupContext(s.turnId, orchId);
    options.sessionStore.markPhase(orchId, s.turnId, "completed");
  }

  function maybeFlushPlaybackCompletion(
    sessionId: string,
    reason?: string,
  ): void {
    const s = getSession(sessionId);
    if (!s) return;

    // Never re-ack a session that already reached a terminal phase
    if (s.phase === "completed" || s.phase === "failed") {
      clearSettlementTimer(sessionId);
      return;
    }

    if (
      s.audio.terminal !== "idle"
      && s.text.delivered
      && !s.motion.absent
      && !s.motion.started
      && !s.motion.completed
    ) {
      schedulePlaybackSettlementWindow(sessionId);
      return;
    }

    if (!isPlaybackLocallySettled(s)) {
      return;
    }

    if (!isPlaybackAckRequired(sessionId)) {
      if (!s.backend.turnFinished) {
        return;
      }
      finalizeCompletion(sessionId);
      return;
    }

    if (ackedSessions.has(sessionId)) {
      if (!s.backend.turnFinished) {
        return;
      }
      finalizeCompletion(sessionId);
      return;
    }

    const orchId = orchestrationIdFromSessionId(s.id);
    const success = s.audio.terminal !== "failed";
    clearSettlementTimer(sessionId);
    options.sessionStore.markPhase(orchId, s.turnId, "settling");
    ackedSessions.add(sessionId);
    void options.adapter.sendPlaybackFinishedForCurrentGroup(
      s.turnId,
      orchId,
      success,
      reason,
    );
  }

  function schedulePlaybackSettlementWindow(sessionId: string): void {
    if (settlementTimers.has(sessionId)) {
      return;
    }
    const timer = window.setTimeout(() => {
      settlementTimers.delete(sessionId);
      const session = getSession(sessionId);
      if (
        session
        && session.audio.terminal !== "idle"
        && !session.motion.started
        && !session.motion.completed
        && session.motion.payload === null
      ) {
        options.sessionStore.markMotionAbsent(
          orchestrationIdFromSessionId(session.id),
          session.turnId,
        );
      }
      maybeFlushPlaybackCompletion(sessionId, "audio_and_motion_settled");
    }, PLAYBACK_SETTLEMENT_WINDOW_MS);
    settlementTimers.set(sessionId, timer);
  }

  function recordMotionPlayback(event: ModelEnginePlanStartedEvent): void {
    currentMotionSessionId =
      typeof event.orchestrationId === "string" && event.orchestrationId.trim()
        ? `orch:${event.orchestrationId.trim()}`
        : typeof event.turnId === "string" && event.turnId.trim()
          ? `turn:${event.turnId.trim()}`
          : null;

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

  watch(
    () => options.sessionStore.getSessions().map((session) => ({
      id: session.id,
      turnId: session.turnId,
      audioStarted: session.audio.started,
      audioStartedAtMs: session.audio.startedAtMs,
    })),
    () => {
      for (const session of options.sessionStore.getSessions()) {
        if (!session.audio.started || notifiedAudioStartedSessions.has(session.id)) {
          continue;
        }
        notifiedAudioStartedSessions.add(session.id);
        options.onAudioPlaybackStarted(session.turnId);
      }
    },
    { deep: true },
  );

  // Text delivered → try flush
  watch(
    () => options.sessionStore.getSessions().map((session) => ({
      id: session.id,
      textDelivered: session.text.delivered,
      audioTerminal: session.audio.terminal,
      motionAbsent: session.motion.absent,
      motionStarted: session.motion.started,
      motionCompleted: session.motion.completed,
      backendTurnFinished: session.backend.turnFinished,
      phase: session.phase,
    })),
    () => {
      for (const session of options.sessionStore.getSessions()) {
        if (session.phase === "completed" || session.phase === "failed") {
          continue;
        }
        if (session.text.delivered) {
          maybeFlushPlaybackCompletion(session.id, "text_delivered");
        }
      }
    },
    { deep: true },
  );

  // Motion completed (from motion player) → write to session, try flush
  watch(
    () => options.motionPlayer.state.status,
    (status, previousStatus) => {
      if (status !== "finished" || previousStatus !== "playing") {
        return;
      }
      const s = getSession(currentMotionSessionId);
      if (!s) return;

      options.sessionStore.markMotionCompleted(
        orchestrationIdFromSessionId(s.id),
        s.turnId,
      );
      currentMotionSessionId = null;

      if (s.audio.terminal !== "idle") {
        maybeFlushPlaybackCompletion(s.id, "motion_completed_after_audio");
      }
    },
  );

  return {
    motionPlaybackRecords: shallowReadonly(motionPlaybackRecords),
    recordMotionPlayback,
    resetPlaybackCoordination,
  };
}
