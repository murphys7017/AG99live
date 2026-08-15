import type {
  CatalogMotionPayload,
  SemanticMotionIntent,
} from "./protocol.js";

export type NormalizedMotionPayload =
  | { kind: "catalog_motion"; motion: CatalogMotionPayload }
  | { kind: "semantic_intent"; intent: SemanticMotionIntent };

export type MotionPayloadNormalizationResult =
  | { ok: true; payload: NormalizedMotionPayload }
  | { ok: false; reason: string };

export type MotionPayloadNormalizer = (
  payload: unknown,
) => MotionPayloadNormalizationResult;
