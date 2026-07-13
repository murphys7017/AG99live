import { watch } from "vue";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import type { NormalizedMotionPayload } from "../model-engine/contracts";
import { canReleaseAudio, canReleaseMotion, getActivePlaybackSegment } from "./selectors.js";
import type { MotionPayloadPort } from "./ports.js";
import type { PlaybackTimelineSegmentStartPort } from "../playback-timeline/segmentJob.js";

type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

interface TurnPlaybackOrchestratorOptions {
  sessionStore: SessionStore;
  motionPayload: Pick<MotionPayloadPort, "notifyCurrentTurnChanged">;
  timelineRuntime: PlaybackTimelineSegmentStartPort<NormalizedMotionPayload>;
}

export function useTurnPlaybackOrchestrator(
  options: TurnPlaybackOrchestratorOptions,
) {
  function scheduleReadySegments(): void {
    for (const session of options.sessionStore.getSessions()) {
      if (session.phase === "completed" || session.phase === "failed") {
        continue;
      }
      const segment = getActivePlaybackSegment(session);
      if (!segment || !isAtomicSegmentResolved(segment)) {
        continue;
      }
      if (session.phase === "collecting") {
        options.sessionStore.markPhase(segment.turnId, "ready");
      }

      if (
        segment.audio.terminal === "failed"
        && segment.motion.payload
        && !segment.motion.failed
        && !segment.motion.released
      ) {
        options.sessionStore.markMotionFailed(
          segment.turnId,
          segment.messageId,
          `audio_failed_before_motion_release:${segment.audio.reason || "audio_failed"}`,
        );
      }

      const releaseText = Boolean(segment.text.content) && !segment.text.released;
      const releaseAudio = canReleaseAudio(segment);
      const releaseMotion = canReleaseMotion(segment)
        && segment.motion.payload !== null
        && segment.audio.terminal !== "failed";
      if (!releaseText && !releaseAudio && !releaseMotion) {
        continue;
      }
      const receivedAtMs = releaseMotion ? segment.motion.receivedAtMs : null;
      if (
        releaseMotion
        && (
          receivedAtMs === null
          || !Number.isFinite(receivedAtMs)
          || receivedAtMs < 0
        )
      ) {
        options.sessionStore.markMotionFailed(
          segment.turnId,
          segment.messageId,
          "motion_received_at_missing",
        );
        continue;
      }

      options.timelineRuntime.startSegmentJob({
        turnId: segment.turnId,
        messageId: segment.messageId,
        reason: "atomic_output_segment_ready",
        text: { release: releaseText },
        audio: {
          release: releaseAudio,
          noAudioConfirmed: segment.audio.terminal === "absent",
        },
        motion: {
          payload: releaseMotion ? segment.motion.payload : null,
          receivedAtMs,
        },
      });
    }
  }

  watch(
    () => options.sessionStore.getSessions().map((session) => ({
      id: session.id,
      phase: session.phase,
      segments: session.segmentOrder.map((messageId) => {
        const segment = session.segments.get(messageId);
        return segment ? {
          messageId,
          textContent: segment.text.content,
          textReleased: segment.text.released,
          textDelivered: segment.text.delivered,
          audioUrl: segment.audio.url,
          audioReleased: segment.audio.released,
          audioTerminal: segment.audio.terminal,
          motionPayload: segment.motion.payload,
          motionReleased: segment.motion.released,
          motionAbsent: segment.motion.absent,
          motionFailed: segment.motion.failed,
          motionCompleted: segment.motion.completed,
        } : null;
      }),
    })),
    scheduleReadySegments,
    { deep: true },
  );

  watch(
    () => options.sessionStore.state.activeSessionId,
    (sessionId) => {
      const session = sessionId
        ? options.sessionStore.state.sessions.get(sessionId)
        : undefined;
      options.motionPayload.notifyCurrentTurnChanged(session?.turnId ?? null);
      scheduleReadySegments();
    },
  );

  return { flush: scheduleReadySegments };
}

function isAtomicSegmentResolved(
  segment: ReturnType<SessionStore["ensureSegment"]>,
): boolean {
  const textResolved = Boolean(segment.text.content) || segment.text.delivered;
  const audioResolved = Boolean(segment.audio.url) || segment.audio.terminal !== "idle";
  const motionResolved = Boolean(segment.motion.payload)
    || segment.motion.absent
    || segment.motion.failed;
  return textResolved && audioResolved && motionResolved;
}
