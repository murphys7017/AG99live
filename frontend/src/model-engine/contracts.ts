import type {
  CatalogMotionPayload,
  SemanticMotionIntent,
  SemanticParameterPlan,
} from "../types/protocol";

export type NormalizedMotionPayload =
  | { kind: "catalog_motion"; motion: CatalogMotionPayload }
  | { kind: "semantic_intent"; intent: SemanticMotionIntent }
  | { kind: "semantic_plan"; plan: SemanticParameterPlan };

export interface InboundPayloadContext {
  messageId: string;
  turnId: string | null;
  playbackTurnId?: string | null;
  receivedAtMs: number;
}
