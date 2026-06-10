import type { ProtocolEnvelope } from "../../types/protocol.js";
import { PROTOCOL_VERSION } from "../core/envelope.js";

export type ParsedInboundEnvelope =
  | { ok: true; envelope: ProtocolEnvelope<unknown> }
  | {
    ok: false;
    code: "invalid_json" | "invalid_envelope" | "version_mismatch";
    message: string;
    warningKey?: string;
    envelope?: ProtocolEnvelope<unknown>;
  };

/**
 * 从 string（WebSocket 文本帧）解析入站信封。
 */
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

  return parseEnvelopeRecord(envelope as unknown as Record<string, unknown>);
}

/**
 * 从已反序列化的 unknown 对象（window.postMessage / devtools 注入）解析入站信封。
 * 与 parseInboundEnvelope 共享核心校验逻辑，但不走 JSON.parse。
 */
export function parseInboundEnvelopeObject(raw: unknown): ParsedInboundEnvelope {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      code: "invalid_envelope",
      message: "收到非法协议消息（非对象）。",
    };
  }
  return parseEnvelopeRecord(raw as Record<string, unknown>);

}

/**
 * 核心信封校验逻辑：要求 envelope.type/version/message_id 合法。
 * WebSocket 和 window/devtools 共用同一套校验规则。
 */
function parseEnvelopeRecord(
  record: Record<string, unknown>,
): ParsedInboundEnvelope {
  const envelope = record as unknown as ProtocolEnvelope<unknown>;

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
