import { shallowReadonly, ref, watch, type Ref } from "vue";
import type { ModelEnginePlanStartedEvent } from "../model-engine/contracts";
import type { DesktopMotionPlaybackRecord } from "../types/desktop";
import type { ModelSummary } from "../types/protocol";
import type { useAdapterConnection } from "./useAdapterConnection";
import type { usePreviewMotionPlayer } from "./usePreviewMotionPlayer";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import { isPlaybackLocallySettled } from "../turn-playback/selectors.js";
import type { TurnPlaybackSegment, TurnPlaybackSession } from "../turn-playback/session.js";
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
  onAudioPlaybackStarted: (turnId: string | null, messageId: string) => void;
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
  const notifiedAudioStartedSegments = new Set<string>();
  const ackedSessions = new Set<string>();
  const activeMotionSegments = new Set<string>();

  // ── helpers ─────────────────────────────────────────────────────

  function getSession(sessionId: string | null) {
    return sessionId ? options.sessionStore.getSessionById(sessionId) : undefined;
  }

  function segmentKey(sessionId: string, messageId: string): string {
    return `${sessionId}::${messageId}`;
  }

  function findSegmentByKey(key: string | null): {
    session: TurnPlaybackSession;
    segment: TurnPlaybackSegment;
  } | null {
    if (!key) {
      return null;
    }
    const delimiterIndex = key.indexOf("::");
    if (delimiterIndex < 0) {
      return null;
    }
    const sessionId = key.slice(0, delimiterIndex);
    const messageId = key.slice(delimiterIndex + 2);
    const session = getSession(sessionId);
    const segment = session?.segments.get(messageId);
    return session && segment ? { session, segment } : null;
  }

  function clearSettlementTimer(key: string): void {
    const timer = settlementTimers.get(key);
    if (timer) {
      window.clearTimeout(timer);
      settlementTimers.delete(key);
    }
  }

  function resetPlaybackCoordination(): void {
    for (const key of settlementTimers.keys()) {
      clearSettlementTimer(key);
    }
    notifiedAudioStartedSegments.clear();
    ackedSessions.clear();
    activeMotionSegments.clear();
  }

  function finalizeCompletion(sessionId: string): void {
    const s = getSession(sessionId);
    if (!s) return;
    for (const segmentId of s.segmentOrder) {
      clearSettlementTimer(segmentKey(sessionId, segmentId));
    }
    const firstSegment = s.segmentOrder
      .map((id) => s.segments.get(id))
      .find(Boolean);
    const orchId = firstSegment?.orchestrationId ?? null;
    options.adapter.clearPlaybackGroupContext(s.turnId, orchId);
    options.sessionStore.markPhase(orchId, s.turnId, "completed");
  }

  function maybeFlushPlaybackCompletion(
    sessionId: string,
    messageId: string | null = null,
    reason?: string,
  ): void {
    const s = getSession(sessionId);
    if (!s) return;

    // Never re-ack a session that already reached a terminal phase
    if (s.phase === "completed" || s.phase === "failed") {
      if (messageId) {
        clearSettlementTimer(segmentKey(sessionId, messageId));
      }
      return;
    }

    if (messageId) {
      const segment = s.segments.get(messageId);
      if (
        segment
        && segment.audio.terminal !== "idle"
        && segment.text.delivered
        && !segment.motion.absent
        && !segment.motion.started
        && !segment.motion.completed
      ) {
        schedulePlaybackSettlementWindow(sessionId, messageId);
        return;
      }
    }

    if (!isPlaybackLocallySettled(s)) {
      return;
    }

    if (!s.backend.synthFinished) {
      return;
    }

    if (ackedSessions.has(sessionId)) {
      if (s.backend.turnFinished) {
        finalizeCompletion(sessionId);
      }
      return;
    }

    const firstSegment = s.segmentOrder
      .map((id) => s.segments.get(id))
      .find(Boolean);
    const orchId = firstSegment?.orchestrationId ?? null;
    const success = s.segmentOrder.every((segmentId) => {
      const segment = s.segments.get(segmentId);
      return segment ? segment.audio.terminal !== "failed" : true;
    });
    for (const segmentId of s.segmentOrder) {
      clearSettlementTimer(segmentKey(sessionId, segmentId));
    }
    options.sessionStore.markPhase(orchId, s.turnId, "settling");
    ackedSessions.add(sessionId);
    void options.adapter.sendPlaybackFinishedForCurrentGroup(
      s.turnId,
      orchId,
      success,
      reason,
    );
    if (s.backend.turnFinished) {
      finalizeCompletion(sessionId);
    }
  }

  function schedulePlaybackSettlementWindow(sessionId: string, messageId: string): void {
    const key = segmentKey(sessionId, messageId);
    if (settlementTimers.has(key)) {
      return;
    }
    const timer = window.setTimeout(() => {
      settlementTimers.delete(key);
      const session = getSession(sessionId);
      const segment = session?.segments.get(messageId);
      if (
        session
        && segment
        && segment.audio.terminal !== "idle"
        && !segment.motion.started
        && !segment.motion.completed
        && segment.motion.payload === null
      ) {
        options.sessionStore.markMotionAbsent(
          segment.orchestrationId,
          segment.turnId,
          segment.messageId,
        );
      }
      maybeFlushPlaybackCompletion(sessionId, messageId, "audio_and_motion_settled");
    }, PLAYBACK_SETTLEMENT_WINDOW_MS);
    settlementTimers.set(key, timer);
  }

  function recordMotionPlayback(event: ModelEnginePlanStartedEvent): void {
    const session =
      options.sessionStore.getSessions().find((candidate) =>
        candidate.segmentOrder.some((segmentId) => segmentId === event.messageId),
      );
    if (session) {
      activeMotionSegments.add(segmentKey(session.id, event.messageId));
      options.sessionStore.markMotionStarted(
        event.orchestrationId,
        event.turnId,
        event.messageId,
      );
    }

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
      segments: session.segmentOrder.map((segmentId) => {
        const segment = session.segments.get(segmentId);
        return {
          messageId: segmentId,
          turnId: segment?.turnId ?? null,
          audioStarted: segment?.audio.started ?? false,
          audioStartedAtMs: segment?.audio.startedAtMs ?? null,
        };
      }),
    })),
    () => {
      for (const session of options.sessionStore.getSessions()) {
        for (const segmentId of session.segmentOrder) {
          const segment = session.segments.get(segmentId);
          const key = segmentKey(session.id, segmentId);
          if (!segment?.audio.started || notifiedAudioStartedSegments.has(key)) {
            continue;
          }
          notifiedAudioStartedSegments.add(key);
          options.onAudioPlaybackStarted(segment.turnId, segment.messageId);
        }
      }
    },
    { deep: true },
  );

  // Text delivered → try flush
  watch(
    () => options.sessionStore.getSessions().map((session) => ({
      id: session.id,
      segments: session.segmentOrder.map((segmentId) => {
        const segment = session.segments.get(segmentId);
        return {
          messageId: segmentId,
          textDelivered: segment?.text.delivered ?? false,
          audioTerminal: segment?.audio.terminal ?? "idle",
          motionAbsent: segment?.motion.absent ?? false,
          motionStarted: segment?.motion.started ?? false,
          motionCompleted: segment?.motion.completed ?? false,
        };
      }),
      backendSynthFinished: session.backend.synthFinished,
      backendTurnFinished: session.backend.turnFinished,
      phase: session.phase,
    })),
    () => {
      for (const session of options.sessionStore.getSessions()) {
        if (session.phase === "completed" || session.phase === "failed") {
          continue;
        }
        for (const segmentId of session.segmentOrder) {
          const segment = session.segments.get(segmentId);
          if (segment?.text.delivered) {
            maybeFlushPlaybackCompletion(session.id, segment.messageId, "text_delivered");
          }
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
      const nextKey = activeMotionSegments.values().next().value as string | undefined;
      const found = findSegmentByKey(nextKey ?? null);
      if (!found) return;

      options.sessionStore.markMotionCompleted(
        found.segment.orchestrationId,
        found.segment.turnId,
        found.segment.messageId,
      );
      if (nextKey) {
        activeMotionSegments.delete(nextKey);
      }

      if (found.segment.audio.terminal !== "idle") {
        maybeFlushPlaybackCompletion(
          found.session.id,
          found.segment.messageId,
          "motion_completed_after_audio",
        );
      }
    },
  );

  return {
    motionPlaybackRecords: shallowReadonly(motionPlaybackRecords),
    recordMotionPlayback,
    resetPlaybackCoordination,
  };
}
