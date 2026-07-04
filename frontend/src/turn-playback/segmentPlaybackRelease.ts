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

export interface TurnPlaybackSegmentReleaserOptions {
  sessionStore: SessionStore;
  playbackRelease: PlaybackReleasePort;
  motionPayload: MotionPayloadPort;
}

export interface TurnPlaybackSegmentReleaser {
  release(
    job: TurnPlaybackSegmentReleaseJob<NormalizedMotionPayload>,
  ): TurnPlaybackSegmentReleaseResult;
}

export function createTurnPlaybackSegmentReleaser(
  options: TurnPlaybackSegmentReleaserOptions,
): TurnPlaybackSegmentReleaser {
  function release(
    job: TurnPlaybackSegmentReleaseJob<NormalizedMotionPayload>,
  ): TurnPlaybackSegmentReleaseResult {
    let releasedText = false;
    if (job.text.release) {
      releasedText = options.playbackRelease.releaseAssistantTextForPlayback(
        job.messageId,
        job.turnId,
      );
    }
    if (releasedText) {
      options.sessionStore.markTextReleased(job.turnId, job.messageId);
      options.sessionStore.markPhase(job.turnId, "playing");
    }

    let releasedAudio = false;
    if (job.audio.release) {
      releasedAudio = options.playbackRelease.releaseAudioForPlayback(
        job.messageId,
        job.turnId,
      );
    }
    if (releasedAudio) {
      options.sessionStore.markAudioReleased(job.turnId, job.messageId);
    }

    let releasedMotion = false;
    if (job.motion.payload !== null) {
      const receivedAtMs = job.motion.receivedAtMs;
      if (receivedAtMs === null) {
        throw new Error("Motion segment release requires receivedAtMs.");
      }
      options.sessionStore.markMotionReleased(
        job.turnId,
        job.messageId,
      );
      const accepted = options.motionPayload.start(
        job.motion.payload,
        {
          turnId: job.turnId,
          messageId: job.messageId,
          receivedAtMs,
        },
      );
      releasedMotion = accepted !== false;
      if (accepted === false) {
        options.sessionStore.markMotionFailed(
          job.turnId,
          job.messageId,
          "motion_payload_rejected",
        );
      }
      options.sessionStore.markPhase(
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

  return {
    release,
  };
}
