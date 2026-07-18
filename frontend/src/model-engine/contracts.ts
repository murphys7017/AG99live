import type { MotionPlaybackClockContext } from "./runtime/playbackClock.js";

export type { NormalizedMotionPayload } from "../playback-integrations/motionPayload.js";

export interface MotionPlaybackClockReader {
  getElapsedMs(): number | null;
}

export interface InboundPayloadContext {
  messageId: string;
  turnId: string | null;
  playbackTurnId?: string | null;
  receivedAtMs: number;
  playbackClock?: MotionPlaybackClockContext | null;
  playbackClockReader?: MotionPlaybackClockReader | null;
  timelineMode?: "audio" | "motion_only";
}
