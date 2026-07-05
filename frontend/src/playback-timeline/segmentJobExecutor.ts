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
