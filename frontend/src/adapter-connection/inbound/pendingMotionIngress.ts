import type { NormalizedMotionPayload } from "../../model-engine/contracts.js";

export interface PendingMotionItem {
  turnId: string | null;
  messageId: string;
  payload: NormalizedMotionPayload;
  receivedAtMs: number;
}
