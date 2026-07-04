import type { NormalizedMotionPayload } from "../model-engine/contracts.js";
import type {
  MotionPayloadPort,
  PlaybackReleasePort,
} from "./ports.js";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import {
  executePlaybackTimelineSegmentJob,
} from "../playback-timeline/segmentJobExecutor.js";
import type {
  PlaybackTimelineSegmentRuntimePort,
} from "../playback-timeline/segmentJobExecutor.js";
import type {
  TurnPlaybackSegmentReleaseJob,
  TurnPlaybackSegmentReleaseResult,
} from "./turnPlaybackOrchestratorCore.js";

type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

export interface TurnPlaybackSegmentReleaserOptions {
  sessionStore: SessionStore;
  playbackRelease: PlaybackReleasePort;
  motionPayload: MotionPayloadPort;
  timelineRuntime: PlaybackTimelineSegmentRuntimePort;
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
    return executePlaybackTimelineSegmentJob(job, {
      session: {
        markTextReleased: options.sessionStore.markTextReleased,
        markAudioReleased: options.sessionStore.markAudioReleased,
        markMotionReleased: options.sessionStore.markMotionReleased,
        markMotionFailed: options.sessionStore.markMotionFailed,
        markPhase: options.sessionStore.markPhase,
      },
      textSink: {
        releaseAssistantTextForPlayback:
          options.playbackRelease.releaseAssistantTextForPlayback,
      },
      audioSink: {
        releaseAudioForPlayback: options.playbackRelease.releaseAudioForPlayback,
      },
      motionSink: options.motionPayload,
      timelineRuntime: options.timelineRuntime,
    });
  }

  return {
    release,
  };
}
