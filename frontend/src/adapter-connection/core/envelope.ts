import type { ProtocolEnvelope } from "../../types/protocol.js";
import { PROTOCOL_VERSION } from "../../types/protocolSchema.generated.js";

export { PROTOCOL_VERSION };
const SOURCE_FRONTEND = "frontend";

export function buildMessageEnvelope<TPayload>(
  type: string,
  payload: TPayload,
  turnId: string | null = null,
): ProtocolEnvelope<TPayload> {
  return {
    type,
    version: PROTOCOL_VERSION,
    message_id: createMessageId(),
    timestamp: new Date().toISOString(),
    turn_id: turnId,
    source: SOURCE_FRONTEND,
    payload,
  };
}

export function createMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}
