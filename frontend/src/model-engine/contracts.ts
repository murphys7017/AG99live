import type {
  SemanticMotionIntent,
  SemanticParameterPlan,
} from "../types/protocol";

export type NormalizedMotionPayload =
  | { kind: "semantic_intent"; intent: SemanticMotionIntent }
  | { kind: "semantic_plan"; plan: SemanticParameterPlan };

export interface InboundPayloadContext {
  messageId: string;
  turnId: string | null;
  playbackTurnId?: string | null;
  receivedAtMs: number;
}
