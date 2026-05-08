import type { ProtocolEnvelope } from "../types/protocol.js";
import { PROTOCOL_VERSION } from "./envelope.js";

export type ParsedInboundEnvelope =
  | { ok: true; envelope: ProtocolEnvelope<unknown> }
  | {
    ok: false;
    code: "invalid_json" | "invalid_envelope" | "version_mismatch";
    message: string;
    warningKey?: string;
    envelope?: ProtocolEnvelope<unknown>;
  };

export function parseInboundEnvelope(rawData: string): ParsedInboundEnvelope {
  let envelope: ProtocolEnvelope<unknown>;
  try {
    envelope = JSON.parse(rawData) as ProtocolEnvelope<unknown>;
  } catch (_error) {
    return {
      ok: false,
      code: "invalid_json",
      message: "收到无法解析的后端消息。",
    };
  }

  if (!envelope || typeof envelope !== "object" || typeof envelope.type !== "string") {
    return {
      ok: false,
      code: "invalid_envelope",
      message: "收到非法协议消息。",
    };
  }

  const messageVersion =
    typeof envelope.version === "string"
      ? envelope.version.trim()
      : "";
  if (messageVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "version_mismatch",
      warningKey: `version:${messageVersion || "empty"}`,
      message: `收到协议版本不匹配的消息（expected=${PROTOCOL_VERSION}, actual=${messageVersion || "empty"}）。`,
      envelope,
    };
  }

  return { ok: true, envelope };
}
