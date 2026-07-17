import type { NormalizedMotionPayload } from "../playback-integrations/motionPayload.js";
import type { MotionPlaybackClockContext } from "./runtime/playbackClock.js";

export type { NormalizedMotionPayload } from "../playback-integrations/motionPayload.js";

export interface InboundPayloadContext {
  messageId: string;
  turnId: string | null;
  playbackTurnId?: string | null;
  receivedAtMs: number;
  playbackClock?: MotionPlaybackClockContext | null;
  timelineMode?: "audio" | "motion_only";
}
