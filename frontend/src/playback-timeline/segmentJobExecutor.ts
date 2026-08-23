import type {
  PlaybackTimelineSegmentExecutionPorts,
  PlaybackTimelineSegmentJob,
} from "./segmentJob.js";

type PlaybackTimelineSinkStartCallback = () => boolean | void;

function describeMotionStartFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return `motion_sink_start_failed:${error.message.trim()}`;
  }
  return "motion_sink_start_failed";
}

export interface PlaybackTimelineDeferredTextRelease {
  release: () => boolean;
  fail: (reason: string) => boolean;
}

export interface PlaybackTimelineSegmentExecutorTimelinePort {
  startAudioSink(
    turnId: string | null,
    messageId: string,
    start: PlaybackTimelineSinkStartCallback,
    deferredText?: PlaybackTimelineDeferredTextRelease,
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
  rejectMotionBeforeStart(
    turnId: string | null,
    messageId: string,
    reason: string,
  ): void;
  rejectAudioBeforeStart(
    turnId: string | null,
    messageId: string,
    reason: string,
  ): void;
}

export function executePlaybackTimelineSegmentJob<TMotionPayload>(
  options: {
    job: PlaybackTimelineSegmentJob<TMotionPayload>;
    ports: PlaybackTimelineSegmentExecutionPorts<TMotionPayload>;
    timeline: PlaybackTimelineSegmentExecutorTimelinePort;
  },
): void {
  const { job, ports, timeline } = options;

  const deferTextUntilAudioStarted = job.text.release && job.audio.release;
  let releasedText = false;
  if (job.text.release && job.audio.noAudioConfirmed) {
    releasedText = ports.textSink.releaseAssistantTextForPlayback(
      job.text.content ?? "",
      job.messageId,
      job.turnId,
    );
    if (!releasedText) {
      ports.session.markSessionFailed(
        job.turnId,
        `text_sink_release_failed:${job.messageId}`,
      );
      return;
    }
  }
  if (releasedText) {
    ports.session.markPhase(job.turnId, "playing");
  }

  if (
    job.text.release
    && !job.audio.release
    && !job.audio.noAudioConfirmed
  ) {
    const failed = ports.textSink.failAssistantTextForPlayback(
      job.messageId,
      job.turnId,
      "subtitle_audio_unavailable_before_start",
    );
    if (!failed) {
      ports.session.markSessionFailed(
        job.turnId,
        `text_sink_failure_projection_failed:${job.messageId}`,
      );
      return;
    }
  }

  let releasedAudio = false;
  if (job.audio.release) {
    releasedAudio = timeline.startAudioSink(
      job.turnId,
      job.messageId,
      () => ports.audioSink.releaseAudioForPlayback(
        job.audio.url ?? "",
        job.messageId,
        job.turnId,
      ),
      deferTextUntilAudioStarted
        ? {
            release: () => {
              const released = ports.textSink.releaseAssistantTextForPlayback(
                job.text.content ?? "",
                job.messageId,
                job.turnId,
              );
              return released;
            },
            fail: (reason) => ports.textSink.failAssistantTextForPlayback(
              job.messageId,
              job.turnId,
              reason,
            ),
          }
        : undefined,
    ) === true;
    if (!releasedAudio) {
      timeline.clearAudioSinkIfIdle(job.turnId, job.messageId);
      timeline.rejectAudioBeforeStart(
        job.turnId,
        job.messageId,
        `audio_sink_release_failed:${job.messageId}`,
      );
      ports.session.markSessionFailed(
        job.turnId,
        `audio_sink_release_failed:${job.messageId}`,
      );
      return;
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
    return;
  }

  if (job.motion.payload !== null) {
    const motionPayload = job.motion.payload;
    const receivedAtMs = job.motion.receivedAtMs;
    const timelineMode = job.audio.noAudioConfirmed && !job.audio.release
      ? "motion_only"
      : "audio";
    const interruptMotion = (reason: string) => ports.motionSink.interrupt(
      job.turnId,
      job.messageId,
      reason,
    );
    let motionStarted = false;
    try {
      if (
        receivedAtMs === null
        || !Number.isFinite(receivedAtMs)
        || receivedAtMs < 0
      ) {
        throw new Error("Motion segment release requires a valid receivedAtMs.");
      }
      const startMotion = () => ports.motionSink.start(
        motionPayload,
        {
          turnId: job.turnId,
          messageId: job.messageId,
          assistantText: job.text.content ?? "",
          speechCues: job.speech.cues,
          receivedAtMs,
          timelineMode,
        },
      );

      if (!releasedAudio && timelineMode === "motion_only") {
        const prepared = timeline.ensureMotionOnlyTimeline(
          job.turnId,
          job.messageId,
          startMotion,
          interruptMotion,
        );
        if (!prepared) {
          timeline.rejectMotionBeforeStart(
            job.turnId,
            job.messageId,
            "motion_only_timeline_unavailable",
          );
          return;
        }
      } else {
        const prepared = timeline.ensureMotionTimelineSink(
          job.turnId,
          job.messageId,
          startMotion,
          interruptMotion,
        );
        if (!prepared) {
          timeline.rejectMotionBeforeStart(
            job.turnId,
            job.messageId,
            "motion_timeline_unavailable",
          );
          return;
        }
      }

      motionStarted = timeline.startMotionSink(
        job.turnId,
        job.messageId,
      ) === true;
    } catch (error) {
      timeline.rejectMotionBeforeStart(
        job.turnId,
        job.messageId,
        describeMotionStartFailure(error),
      );
      return;
    }

    if (!motionStarted) {
      timeline.rejectMotionBeforeStart(
        job.turnId,
        job.messageId,
        "motion_sink_start_rejected",
      );
      return;
    }

    ports.session.markMotionReleased(job.turnId, job.messageId);
    ports.session.markPhase(job.turnId, "playing");
  }
}
