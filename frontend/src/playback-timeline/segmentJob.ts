import type { PlaybackTimelineMotionContext } from "./motionTypes.js";

export interface PlaybackTimelineSegmentJob<TMotionPayload = unknown> {
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

export interface PlaybackTimelineSegmentMotionSink<TMotionPayload = unknown> {
  start(
    payload: TMotionPayload,
    context: PlaybackTimelineMotionContext,
  ): boolean | void;
}

export interface PlaybackTimelineSegmentExecutionPorts<
  TMotionPayload = unknown,
> {
  session: PlaybackTimelineSegmentSessionPort;
  textSink: PlaybackTimelineSegmentTextSink;
  audioSink: PlaybackTimelineSegmentAudioSink;
  motionSink: PlaybackTimelineSegmentMotionSink<TMotionPayload>;
}
export interface PlaybackTimelineSegmentStartPort<
  TMotionPayload = unknown,
> {
  startSegmentJob(
    job: PlaybackTimelineSegmentJob<TMotionPayload>,
  ): PlaybackTimelineSegmentExecutionResult;
}

export interface PlaybackTimelineSegmentRunnerPort<
  TMotionPayload = unknown,
> extends PlaybackTimelineSegmentStartPort<TMotionPayload> {}
