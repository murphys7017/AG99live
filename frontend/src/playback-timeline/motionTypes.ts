import type { PlaybackTimelineSnapshot } from "./contracts.js";

export interface PlaybackTimelineMotionContext {
  messageId: string;
  turnId: string | null;
  assistantText: string;
  receivedAtMs: number;
  playbackTimeline?: PlaybackTimelineSnapshot | null;
  timelineMode?: "audio" | "motion_only";
}

export interface PlaybackTimelineMotionSink<TMotionPayload = unknown> {
  start(
    payload: TMotionPayload,
    context: PlaybackTimelineMotionContext,
  ): boolean | void;
  interrupt(turnId: string | null, messageId: string, reason: string): void;
}

export type MotionTimelineTerminal = "completed" | "failed" | "interrupted";
