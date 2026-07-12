import type {
  CatalogMotionPayload,
  SemanticMotionIntent,
  SemanticParameterPlan,
} from "../types/protocol";
import type { MotionPlaybackClockContext } from "./runtime/playbackClock.js";

export type NormalizedMotionPayload =
  | { kind: "catalog_motion"; motion: CatalogMotionPayload }
  | { kind: "semantic_intent"; intent: SemanticMotionIntent }
  | { kind: "semantic_plan"; plan: SemanticParameterPlan };

export interface InboundPayloadContext {
  messageId: string;
  turnId: string | null;
  playbackTurnId?: string | null;
  receivedAtMs: number;
  playbackClock?: MotionPlaybackClockContext | null;
  timelineMode?: "audio" | "motion_only";
}
