import type {
  InboundPayloadContext,
  NormalizedMotionPayload,
} from "../model-engine/contracts.js";

export interface PlaybackTimelineSegmentJob<TMotionPayload = NormalizedMotionPayload> {
  messageId: string;
  turnId: string | null;
  reason: string;
  text: {
    release: boolean;
  };
  audio: {
    release: boolean;
    noAudioConfirmed: boolean;
  };
  motion: {
    payload: TMotionPayload | null;
    receivedAtMs: number | null;
  };
}

export interface PlaybackTimelineSegmentExecutionResult {
  releasedText: boolean;
  releasedAudio: boolean;
  releasedMotion: boolean;
}

export interface PlaybackTimelineSegmentSessionPort {
  markTextReleased(turnId: string | null, messageId: string): void;
  markAudioReleased(turnId: string | null, messageId: string): void;
  markMotionReleased(turnId: string | null, messageId: string): void;
  markMotionFailed(
    turnId: string | null,
    messageId: string,
    reason?: string,
  ): void;
  markPhase(turnId: string | null, phase: "playing"): boolean;
}

export interface PlaybackTimelineSegmentTextSink {
  releaseAssistantTextForPlayback(
    messageId: string,
    turnId: string | null,
  ): boolean;
}

export interface PlaybackTimelineSegmentAudioSink {
  releaseAudioForPlayback(
    messageId: string,
    turnId: string | null,
  ): boolean;
}

export interface PlaybackTimelineSegmentMotionSink<TMotionPayload = NormalizedMotionPayload> {
  start(
    payload: TMotionPayload,
    context: InboundPayloadContext,
  ): boolean | void;
}

export interface PlaybackTimelineSegmentExecutionPorts<
  TMotionPayload = NormalizedMotionPayload,
> {
  session: PlaybackTimelineSegmentSessionPort;
  textSink: PlaybackTimelineSegmentTextSink;
  audioSink: PlaybackTimelineSegmentAudioSink;
  motionSink: PlaybackTimelineSegmentMotionSink<TMotionPayload>;
}
export interface PlaybackTimelineSegmentStartPort<
  TMotionPayload = NormalizedMotionPayload,
> {
  startSegmentJob(
    job: PlaybackTimelineSegmentJob<TMotionPayload>,
  ): PlaybackTimelineSegmentExecutionResult;
}

export interface PlaybackTimelineSegmentRunnerPort<
  TMotionPayload = NormalizedMotionPayload,
> extends PlaybackTimelineSegmentStartPort<TMotionPayload> {}

export interface PlaybackTimelineSegmentPreparationPort {
  prepareSegmentJob(
    turnId: string | null,
    messageId: string,
    options: {
      hasAudio: boolean;
      hasMotion: boolean;
      noAudioConfirmed: boolean;
    },
  ): boolean;
}

export function startPlaybackTimelineSegmentJob<
  TMotionPayload = NormalizedMotionPayload,
>(
  job: PlaybackTimelineSegmentJob<TMotionPayload>,
  ports: PlaybackTimelineSegmentExecutionPorts<TMotionPayload>,
  timelinePreparation: PlaybackTimelineSegmentPreparationPort,
): PlaybackTimelineSegmentExecutionResult {
  let releasedText = false;
  if (job.text.release) {
    releasedText = ports.textSink.releaseAssistantTextForPlayback(
      job.messageId,
      job.turnId,
    );
  }
  if (releasedText) {
    ports.session.markTextReleased(job.turnId, job.messageId);
    ports.session.markPhase(job.turnId, "playing");
  }

  let releasedAudio = false;
  if (job.audio.release) {
    releasedAudio = ports.audioSink.releaseAudioForPlayback(
      job.messageId,
      job.turnId,
    );
  }
  if (releasedAudio) {
    ports.session.markAudioReleased(job.turnId, job.messageId);
    const prepared = timelinePreparation.prepareSegmentJob(
      job.turnId,
      job.messageId,
      {
        hasAudio: true,
        hasMotion: job.motion.payload !== null,
        noAudioConfirmed: false,
      },
    );
    if (!prepared) {
      throw new Error("Playback timeline segment preparation failed.");
    }
  }
  if (
    job.audio.release
    && !releasedAudio
    && job.motion.payload !== null
    && !job.audio.noAudioConfirmed
  ) {
    return {
      releasedText,
      releasedAudio,
      releasedMotion: false,
    };
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
    const timelineMode = job.audio.noAudioConfirmed && !job.audio.release
      ? "motion_only"
      : "audio";
    if (!releasedAudio && timelineMode === "motion_only") {
      const prepared = timelinePreparation.prepareSegmentJob(
        job.turnId,
        job.messageId,
        {
          hasAudio: false,
          hasMotion: true,
          noAudioConfirmed: true,
        },
      );
      if (!prepared) {
        ports.session.markMotionFailed(
          job.turnId,
          job.messageId,
          "motion_only_timeline_unavailable",
        );
        return {
          releasedText,
          releasedAudio,
          releasedMotion: false,
        };
      }
    }
    ports.session.markMotionReleased(job.turnId, job.messageId);
    const accepted = ports.motionSink.start(
      job.motion.payload,
      {
        turnId: job.turnId,
        messageId: job.messageId,
        receivedAtMs,
        timelineMode,
      },
    );
    releasedMotion = true;
    if (accepted === false) {
      ports.session.markMotionFailed(
        job.turnId,
        job.messageId,
        "motion_payload_rejected",
      );
    }
    ports.session.markPhase(job.turnId, "playing");
  }

  return {
    releasedText,
    releasedAudio,
    releasedMotion,
  };
}
