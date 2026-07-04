import type { NormalizedMotionPayload } from "../model-engine/contracts.js";
import type {
  MotionPayloadPort,
  PlaybackReleasePort,
} from "./ports.js";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import type {
  TurnPlaybackSegmentReleaseJob,
  TurnPlaybackSegmentReleaseResult,
} from "./turnPlaybackOrchestratorCore.js";

type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

export interface TurnPlaybackSegmentReleaseExecutorPorts {
  sessionStore: SessionStore;
  playbackRelease: PlaybackReleasePort;
  motionPayload: MotionPayloadPort;
}

export function executeTurnPlaybackSegmentReleaseJob(
  job: TurnPlaybackSegmentReleaseJob<NormalizedMotionPayload>,
  ports: TurnPlaybackSegmentReleaseExecutorPorts,
): TurnPlaybackSegmentReleaseResult {
  let releasedText = false;
  if (job.text.release) {
    releasedText = ports.playbackRelease.releaseAssistantTextForPlayback(
      job.messageId,
      job.turnId,
    );
  }
  if (releasedText) {
    ports.sessionStore.markTextReleased(job.turnId, job.messageId);
    ports.sessionStore.markPhase(job.turnId, "playing");
  }

  let releasedAudio = false;
  if (job.audio.release) {
    releasedAudio = ports.playbackRelease.releaseAudioForPlayback(
      job.messageId,
      job.turnId,
    );
  }
  if (releasedAudio) {
    ports.sessionStore.markAudioReleased(job.turnId, job.messageId);
  }

  let releasedMotion = false;
  if (job.motion.payload !== null) {
    const receivedAtMs = job.motion.receivedAtMs;
    if (
      receivedAtMs === null
      || !Number.isFinite(receivedAtMs)
      || receivedAtMs < 0
    ) {
      throw new Error("Motion segment release requires a valid receivedAtMs.");
    }
    ports.sessionStore.markMotionReleased(
      job.turnId,
      job.messageId,
    );
    const accepted = ports.motionPayload.start(
      job.motion.payload,
      {
        turnId: job.turnId,
        messageId: job.messageId,
        receivedAtMs,
        timelineMode: job.audio.noAudioConfirmed && !job.audio.release
          ? "motion_only"
          : "audio",
      },
    );
    releasedMotion = accepted !== false;
    if (accepted === false) {
      ports.sessionStore.markMotionFailed(
        job.turnId,
        job.messageId,
        "motion_payload_rejected",
      );
    }
    ports.sessionStore.markPhase(
      job.turnId,
      "playing",
    );
  }

  return {
    releasedText,
    releasedAudio,
    releasedMotion,
  };
}
