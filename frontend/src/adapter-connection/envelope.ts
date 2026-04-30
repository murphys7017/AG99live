import type { ProtocolEnvelope } from "../types/protocol";

export const PROTOCOL_VERSION = "v2";
export const SOURCE_FRONTEND = "frontend";
export const DEFAULT_SESSION_ID = "desktop-client";

export function buildMessageEnvelope<TPayload>(
  type: string,
  payload: TPayload,
  sessionId: string,
  turnId: string | null = null,
): ProtocolEnvelope<TPayload> {
  return {
    type,
    version: PROTOCOL_VERSION,
    message_id: createMessageId(),
    timestamp: new Date().toISOString(),
    session_id: sessionId || DEFAULT_SESSION_ID,
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
