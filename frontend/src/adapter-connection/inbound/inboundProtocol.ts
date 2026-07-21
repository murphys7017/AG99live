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

  if (!isRecord(envelope)) {
    return {
      ok: false,
      code: "invalid_envelope",
      message: "收到非法协议消息（非对象）。",
    };
  }

  return parseEnvelopeRecord(envelope);
}

/**
 * 核心信封校验逻辑：要求 envelope 顶层字段合法。
 */
function parseEnvelopeRecord(
  record: Record<string, unknown>,
): ParsedInboundEnvelope {
  const type = readNonEmptyString(record.type);
  if (!type) {
    return {
      ok: false,
      code: "invalid_envelope",
      message: "收到非法协议消息（type 必须是非空字符串）。",
    };
  }

  const messageVersion =
    typeof record.version === "string"
      ? record.version.trim()
      : "";
  if (messageVersion !== PROTOCOL_VERSION) {
    const envelope = record as unknown as ProtocolEnvelope<unknown>;
    return {
      ok: false,
      code: "version_mismatch",
      warningKey: `version:${messageVersion || "empty"}`,
      message: `收到协议版本不匹配的消息（expected=${PROTOCOL_VERSION}, actual=${messageVersion || "empty"}）。`,
      envelope,
    };
  }

  const messageId = readNonEmptyString(record.message_id);
  if (!messageId) {
    return invalidEnvelope("message_id 必须是非空字符串");
  }

  const timestamp = readNonEmptyString(record.timestamp);
  if (!timestamp) {
    return invalidEnvelope("timestamp 必须是非空字符串");
  }

  const source = readNonEmptyString(record.source);
  if (!source) {
    return invalidEnvelope("source 必须是非空字符串");
  }

  const turnId = record.turn_id === null
    ? null
    : readNonEmptyString(record.turn_id);
  if (record.turn_id !== null && !turnId) {
    return invalidEnvelope("turn_id 必须是非空字符串或 null");
  }

  if (!isRecord(record.payload)) {
    return invalidEnvelope("payload 必须是对象");
  }

  const envelope = {
    ...record,
    type,
    version: messageVersion,
    message_id: messageId,
    timestamp,
    turn_id: turnId,
    source,
  } as ProtocolEnvelope<unknown>;
  return { ok: true, envelope };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function invalidEnvelope(message: string): ParsedInboundEnvelope {
  return {
    ok: false,
    code: "invalid_envelope",
    message: `收到非法协议消息（${message}）。`,
  };
}
