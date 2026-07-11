import { watch } from "vue";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore.js";
import { isPlaybackLocallySettled } from "./selectors.js";
import type { TurnPlaybackSegment, TurnPlaybackSession } from "./session.js";
import type { PlaybackAckPort } from "./ports.js";

type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

export interface PlaybackCompletionCoordinatorOptions {
  sessionStore: SessionStore;
  playbackAck: PlaybackAckPort;
}

/**
 * Coordinates only the turn-level playback acknowledgement loop.
 * Audio, motion, and lip-sync execution/terminal state belong to the timeline.
 * Motion history belongs to useMotionPlaybackRecorder.
 */
export function usePlaybackCompletionCoordinator(
  options: PlaybackCompletionCoordinatorOptions,
) {
  const ackedSessions = new Set<string>();
  const pendingAckSessions = new Set<string>();

  function getSession(sessionId: string | null): TurnPlaybackSession | undefined {
    return sessionId ? options.sessionStore.getSessionById(sessionId) : undefined;
  }

  function resetPlaybackCoordination(): void {
    ackedSessions.clear();
    pendingAckSessions.clear();
  }

  function finalizeCompletion(sessionId: string): void {
    const session = getSession(sessionId);
    if (!session) {
      return;
    }
    ackedSessions.delete(sessionId);
    options.sessionStore.markPhase(session.turnId, "completed");
    options.playbackAck.clearPlaybackGroupContext(session.turnId);
  }

  function maybeFlushPlaybackCompletion(
    sessionId: string,
    reason?: string,
  ): void {
    const session = getSession(sessionId);
    if (!session) {
      return;
    }
    if (session.phase === "completed" || session.phase === "failed") {
      return;
    }
    if (!isPlaybackLocallySettled(session) || !session.backend.synthFinished) {
      return;
    }
    if (pendingAckSessions.has(sessionId)) {
      return;
    }
    if (ackedSessions.has(sessionId)) {
      if (session.backend.turnFinished) {
        finalizeCompletion(sessionId);
      }
      return;
    }

    const success = session.segmentOrder.every((segmentId) => {
      const segment = session.segments.get(segmentId);
      return segment
        ? segment.audio.terminal !== "failed" && !segment.motion.failed
        : true;
    });
    options.sessionStore.markPhase(session.turnId, "settling");
    pendingAckSessions.add(sessionId);
    void sendPlaybackFinished(sessionId, success, reason);
  }

  async function sendPlaybackFinished(
    sessionId: string,
    success: boolean,
    reason?: string,
  ): Promise<void> {
    const session = getSession(sessionId);
    if (!session) {
      pendingAckSessions.delete(sessionId);
      return;
    }
    let sent = false;
    try {
      sent = await options.playbackAck.sendPlaybackFinishedForCurrentGroup(
        session.turnId,
        success,
        reason,
      );
    } catch (error) {
      console.error("[PlaybackCompletionCoordinator] playback acknowledgement failed.", error);
    }
    if (!pendingAckSessions.delete(sessionId)) {
      return;
    }
    const currentSession = getSession(sessionId);
    if (
      !currentSession
      || currentSession.phase === "completed"
      || currentSession.phase === "failed"
    ) {
      return;
    }
    if (!sent) {
      options.sessionStore.markSessionFailed(
        currentSession.turnId,
        "playback_finished_send_failed",
      );
      return;
    }
    ackedSessions.add(sessionId);
    if (currentSession.backend.turnFinished) {
      finalizeCompletion(sessionId);
    }
  }

  function reopenAckedSessionForLateAudio(
    session: TurnPlaybackSession,
    segment: TurnPlaybackSegment,
  ): void {
    if (!ackedSessions.has(session.id)) {
      return;
    }
    if (
      session.phase !== "playing"
      || !segment.audio.url
      || segment.audio.terminal !== "idle"
      || segment.audio.released
    ) {
      return;
    }
    ackedSessions.delete(session.id);
  }

  watch(
    () => options.sessionStore.getSessions().map((session) => ({
      id: session.id,
      segments: session.segmentOrder.map((messageId) => {
        const segment = session.segments.get(messageId);
        return {
          messageId,
          audioUrl: segment?.audio.url ?? null,
          audioReleased: segment?.audio.released ?? false,
          textDelivered: segment?.text.delivered ?? false,
          audioTerminal: segment?.audio.terminal ?? "idle",
          motionAbsent: segment?.motion.absent ?? false,
          motionStarted: segment?.motion.started ?? false,
          motionCompleted: segment?.motion.completed ?? false,
          motionFailed: segment?.motion.failed ?? false,
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
        for (const messageId of session.segmentOrder) {
          const segment = session.segments.get(messageId);
          if (segment) {
            reopenAckedSessionForLateAudio(session, segment);
          }
          if (segment?.text.delivered) {
            maybeFlushPlaybackCompletion(session.id, "text_delivered");
          }
        }
      }
    },
    { deep: true },
  );

  return { resetPlaybackCoordination };
}
