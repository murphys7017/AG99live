import type { NormalizedMotionPayload } from "../model-engine/contracts.js";
import type {
  MotionPayloadPort,
  PlaybackReleasePort,
} from "./ports.js";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import {
  executeTurnPlaybackSegmentReleaseJob,
} from "./segmentReleaseExecutor.js";
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
    return executeTurnPlaybackSegmentReleaseJob(job, options);
  }

  return {
    release,
  };
}
