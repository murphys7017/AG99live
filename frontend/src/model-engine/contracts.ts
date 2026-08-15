import type { MotionPlaybackClockContext } from "./runtime/playbackClock.js";

export interface MotionPlaybackClockReader {
  getElapsedMs(): number | null;
}

export interface InboundPayloadContext {
  messageId: string;
  turnId: string | null;
  assistantText: string;
  playbackTurnId?: string | null;
  receivedAtMs: number;
  playbackClock?: MotionPlaybackClockContext | null;
  playbackClockReader?: MotionPlaybackClockReader | null;
  timelineMode?: "audio" | "motion_only";
}
