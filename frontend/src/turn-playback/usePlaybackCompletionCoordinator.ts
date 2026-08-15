import { watch } from "vue";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore.js";
import { isPlaybackLocallySettled } from "./selectors.js";
import type { TurnPlaybackSession } from "./session.js";
import type { PlaybackAckPort } from "./ports.js";
import type { PlaybackTimelineRuntime } from "../playback-timeline/playbackTimelineRuntime.js";

type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

export interface PlaybackCompletionCoordinatorOptions {
  sessionStore: SessionStore;
  playbackAck: PlaybackAckPort;
  timelineRuntime: Pick<
    PlaybackTimelineRuntime,
    "findOpenExecutionTimelineSegments" | "subscribeExecutionStateChanges"
  >;
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
    if (
      options.timelineRuntime.findOpenExecutionTimelineSegments().some(
        (segment) => segment.turnId === session.turnId,
      )
    ) {
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

    const failureReason = resolvePlaybackFailureReason(session);
    const success = failureReason === null;
    options.sessionStore.markPhase(session.turnId, "settling");
    pendingAckSessions.add(sessionId);
    void sendPlaybackFinished(
      sessionId,
      success,
      success ? reason : failureReason,
    );
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

  function flushPendingCompletions(reason?: string): void {
    for (const session of options.sessionStore.getSessions()) {
      if (session.phase === "completed" || session.phase === "failed") {
        continue;
      }
      maybeFlushPlaybackCompletion(session.id, reason);
    }
  }

  const stopSessionWatch = watch(
    () => options.sessionStore.getSessions().map((session) => ({
      id: session.id,
      segments: session.segmentOrder.map((messageId) => {
        const segment = session.segments.get(messageId);
        return {
          messageId,
          rejected: segment?.rejected ?? false,
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
    () => flushPendingCompletions("playback_state_changed"),
    { deep: true, immediate: true },
  );
  const unsubscribeExecutionStateChanges =
    options.timelineRuntime.subscribeExecutionStateChanges(() => {
      flushPendingCompletions("timeline_execution_settled");
    });

  return {
    resetPlaybackCoordination,
    dispose() {
      stopSessionWatch();
      unsubscribeExecutionStateChanges();
    },
  };
}

function resolvePlaybackFailureReason(session: TurnPlaybackSession): string | null {
  for (const segmentId of session.segmentOrder) {
    const segment = session.segments.get(segmentId);
    if (!segment) {
      return `playback_segment_missing:${segmentId}`;
    }
    if (segment.rejected) {
      return segment.rejectionReason || `output_segment_rejected:${segmentId}`;
    }
    if (segment.text.failed) {
      return segment.text.reason || `text_playback_failed:${segmentId}`;
    }
    if (segment.audio.terminal === "failed") {
      return segment.audio.reason || `audio_playback_failed:${segmentId}`;
    }
    if (segment.motion.failed) {
      return segment.motion.reason || `motion_playback_failed:${segmentId}`;
    }
  }
  return null;
}
