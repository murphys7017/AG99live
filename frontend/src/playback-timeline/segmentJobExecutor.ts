import type {
  PlaybackTimelineSegmentExecutionPorts,
  PlaybackTimelineSegmentExecutionResult,
  PlaybackTimelineSegmentJob,
} from "./segmentJob.js";

type PlaybackTimelineSinkStartCallback = () => boolean | void;

export interface PlaybackTimelineSegmentExecutorTimelinePort {
  startAudioSink(
    turnId: string | null,
    messageId: string,
    start: PlaybackTimelineSinkStartCallback,
  ): boolean | void;
  ensureAudioSegmentTimeline(
    turnId: string | null,
    messageId: string,
    options: {
      hasMotion: boolean;
    },
  ): boolean;
  clearAudioSinkIfIdle(
    turnId: string | null,
    messageId: string,
  ): void;
  ensureMotionOnlyTimeline(
    turnId: string | null,
    messageId: string,
    start: PlaybackTimelineSinkStartCallback,
    interrupt: (reason: string) => void,
  ): boolean;
  ensureMotionTimelineSink(
    turnId: string | null,
    messageId: string,
    start: PlaybackTimelineSinkStartCallback,
    interrupt: (reason: string) => void,
  ): boolean;
  startMotionSink(
    turnId: string | null,
    messageId: string,
  ): boolean | void;
}

export function executePlaybackTimelineSegmentJob<TMotionPayload>(
  options: {
    job: PlaybackTimelineSegmentJob<TMotionPayload>;
    ports: PlaybackTimelineSegmentExecutionPorts<TMotionPayload>;
    timeline: PlaybackTimelineSegmentExecutorTimelinePort;
  },
): PlaybackTimelineSegmentExecutionResult {
  const { job, ports, timeline } = options;

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
    releasedAudio = timeline.startAudioSink(
      job.turnId,
      job.messageId,
      () => ports.audioSink.releaseAudioForPlayback(
        job.messageId,
        job.turnId,
      ),
    ) === true;
    if (!releasedAudio) {
      timeline.clearAudioSinkIfIdle(job.turnId, job.messageId);
    }
  }
  if (releasedAudio) {
    ports.session.markAudioReleased(job.turnId, job.messageId);
    const prepared = timeline.ensureAudioSegmentTimeline(
      job.turnId,
      job.messageId,
      {
        hasMotion: job.motion.payload !== null,
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
    const motionPayload = job.motion.payload;
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
    const startMotion = () => ports.motionSink.start(
      motionPayload,
      {
        turnId: job.turnId,
        messageId: job.messageId,
        receivedAtMs,
        timelineMode,
      },
    );
    const interruptMotion = (reason: string) => ports.motionSink.interrupt(
      job.turnId,
      job.messageId,
      reason,
    );
    if (!releasedAudio && timelineMode === "motion_only") {
      const prepared = timeline.ensureMotionOnlyTimeline(
        job.turnId,
        job.messageId,
        startMotion,
        interruptMotion,
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
    } else {
      const prepared = timeline.ensureMotionTimelineSink(
        job.turnId,
        job.messageId,
        startMotion,
        interruptMotion,
      );
      if (!prepared) {
        ports.session.markMotionFailed(
          job.turnId,
          job.messageId,
          "motion_timeline_unavailable",
        );
        return {
          releasedText,
          releasedAudio,
          releasedMotion: false,
        };
      }
    }
    ports.session.markMotionReleased(job.turnId, job.messageId);
    timeline.startMotionSink(
      job.turnId,
      job.messageId,
    );
    releasedMotion = true;
    ports.session.markPhase(job.turnId, "playing");
  }

  return {
    releasedText,
    releasedAudio,
    releasedMotion,
  };
}
