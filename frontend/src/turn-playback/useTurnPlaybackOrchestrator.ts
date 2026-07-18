import { watch } from "vue";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import type { NormalizedMotionPayload } from "../playback-integrations/motionPayload";
import { canReleaseAudio, canReleaseMotion, getActivePlaybackSegment } from "./selectors.js";
import type { MotionPayloadPort } from "./ports.js";
import type { PlaybackTimelineSegmentStartPort } from "../playback-timeline/segmentJob.js";
import type { TurnPlaybackSegment } from "./session.js";

type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

interface TurnPlaybackOrchestratorOptions {
  sessionStore: SessionStore;
  timelineRuntime: PlaybackTimelineSegmentStartPort<NormalizedMotionPayload>;
}

export function useTurnPlaybackOrchestrator(
  options: TurnPlaybackOrchestratorOptions,
) {
  function scheduleReadySegments(): void {
    let segment: TurnPlaybackSegment | null = null;
    for (const session of options.sessionStore.getSessions()) {
      if (session.phase === "completed" || session.phase === "failed") {
        continue;
      }
      segment = getActivePlaybackSegment(session);
      if (segment) {
        break;
      }
      if (!session.backend.synthFinished) {
        return;
      }
    }
    if (!segment || !isAtomicSegmentResolved(segment)) {
      return;
    }
    const session = options.sessionStore.getSession(segment.turnId);
    if (session?.phase === "collecting") {
      options.sessionStore.markPhase(segment.turnId, "ready");
    }

    if (
      segment.audio.terminal === "failed"
      && segment.motion.payload
      && !segment.motion.failed
      && !segment.motion.released
    ) {
      options.timelineRuntime.rejectMotionBeforeStart(
        segment.turnId,
        segment.messageId,
        `audio_failed_before_motion_release:${segment.audio.reason || "audio_failed"}`,
      );
    }

    const textOwnedByReleasedAudioTimeline = Boolean(segment.audio.url)
      && segment.audio.released
      && segment.audio.terminal === "idle";
    const releaseText = Boolean(segment.text.content)
      && !segment.text.released
      && !textOwnedByReleasedAudioTimeline;
    const releaseAudio = canReleaseAudio(segment);
    const releaseMotion = canReleaseMotion(segment)
      && segment.motion.payload !== null
      && segment.audio.terminal !== "failed";
    if (!releaseText && !releaseAudio && !releaseMotion) {
      return;
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
      options.timelineRuntime.rejectMotionBeforeStart(
        segment.turnId,
        segment.messageId,
        "motion_received_at_missing",
      );
      return;
    }

    options.timelineRuntime.startSegmentJob({
      turnId: segment.turnId,
      messageId: segment.messageId,
      reason: "atomic_output_segment_ready",
      text: {
        release: releaseText,
        content: segment.text.content,
      },
      audio: {
        release: releaseAudio,
        url: segment.audio.url,
        noAudioConfirmed: segment.audio.terminal === "absent",
      },
      motion: {
        payload: releaseMotion ? segment.motion.payload : null,
        receivedAtMs,
      },
    });
  }

  watch(
    () => options.sessionStore.getSessions().map((session) => ({
      id: session.id,
      phase: session.phase,
      backendSynthFinished: session.backend.synthFinished,
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

  return { flush: scheduleReadySegments };
}

function isAtomicSegmentResolved(
  segment: TurnPlaybackSegment,
): boolean {
  const textResolved = Boolean(segment.text.content) || segment.text.delivered;
  const audioResolved = Boolean(segment.audio.url) || segment.audio.terminal !== "idle";
  const motionResolved = Boolean(segment.motion.payload)
    || segment.motion.absent
    || segment.motion.failed;
  return textResolved && audioResolved && motionResolved;
}
