import type { PlaybackTimelineMotionContext } from "./motionTypes.js";
import type { OutputSegmentSpeechCue } from "../types/protocol.js";

export interface PlaybackTimelineSegmentJob<TMotionPayload = unknown> {
  messageId: string;
  turnId: string | null;
  reason: string;
  text: {
    release: boolean;
    content: string | null;
  };
  audio: {
    release: boolean;
    url: string | null;
    noAudioConfirmed: boolean;
  };
  motion: {
    payload: TMotionPayload | null;
    receivedAtMs: number | null;
  };
  speech: {
    cues: readonly OutputSegmentSpeechCue[];
  };
}

export interface PlaybackTimelineSegmentSessionPort {
  markSessionFailed(turnId: string | null, reason: string): void;
  markAudioReleased(turnId: string | null, messageId: string): void;
  markMotionReleased(turnId: string | null, messageId: string): void;
  markPhase(turnId: string | null, phase: "playing"): boolean;
}

export interface PlaybackTimelineSegmentTextSink {
  releaseAssistantTextForPlayback(
    text: string,
    messageId: string,
    turnId: string | null,
  ): boolean;
  failAssistantTextForPlayback(
    messageId: string,
    turnId: string | null,
    reason: string,
  ): boolean;
}

export interface PlaybackTimelineSegmentAudioSink {
  releaseAudioForPlayback(
    audioUrl: string,
    messageId: string,
    turnId: string | null,
  ): boolean;
}

export interface PlaybackTimelineSegmentMotionSink<TMotionPayload = unknown> {
  start(
    payload: TMotionPayload,
    context: PlaybackTimelineMotionContext,
  ): boolean | void;
  interrupt(turnId: string | null, messageId: string, reason: string): void;
}

export interface PlaybackTimelineSegmentExecutionPorts<
  TMotionPayload = unknown,
> {
  session: PlaybackTimelineSegmentSessionPort;
  textSink: PlaybackTimelineSegmentTextSink;
  audioSink: PlaybackTimelineSegmentAudioSink;
  motionSink: PlaybackTimelineSegmentMotionSink<TMotionPayload>;
}
