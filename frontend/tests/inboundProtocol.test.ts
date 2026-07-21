import assert from "node:assert/strict";
import { parseInboundEnvelope } from "../src/adapter-connection/inbound/inboundProtocol.js";

function testInvalidJson(): void {
  const result = parseInboundEnvelope("{");
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected invalid_json");
  }
  assert.equal(result.code, "invalid_json");
  assert.equal(result.message, "收到无法解析的后端消息。");
}

function testInvalidEnvelope(): void {
  const result = parseInboundEnvelope(JSON.stringify({ version: "2", payload: {} }));
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected invalid_envelope");
  }
  assert.equal(result.code, "invalid_envelope");
  assert.equal(result.message, "收到非法协议消息（type 必须是非空字符串）。");
}

function testInvalidEnvelopeTopLevelFields(): void {
  const base = {
    type: "output.segment",
    version: "v2",
    message_id: "m-1",
    timestamp: "2026-05-08T00:00:00.000Z",
    turn_id: "turn-1",
    source: "backend",
    payload: { text: "hello" },
  };

  for (const [field, value, expected] of [
    ["message_id", "", "message_id 必须是非空字符串"],
    ["timestamp", "", "timestamp 必须是非空字符串"],
    ["source", "", "source 必须是非空字符串"],
    ["turn_id", 123, "turn_id 必须是非空字符串或 null"],
    ["turn_id", "", "turn_id 必须是非空字符串或 null"],
    ["payload", [], "payload 必须是对象"],
    ["payload", null, "payload 必须是对象"],
  ] as const) {
    const result = parseInboundEnvelope(JSON.stringify({
      ...base,
      [field]: value,
    }));
    assert.equal(result.ok, false);
    if (result.ok) {
      throw new Error(`expected invalid_envelope for ${field}`);
    }
    assert.equal(result.code, "invalid_envelope");
    assert.equal(result.message, `收到非法协议消息（${expected}）。`);
  }
}

function testVersionMismatch(): void {
  const result = parseInboundEnvelope(JSON.stringify({
    type: "output.segment",
    version: "wrong",
    message_id: "m-1",
    timestamp: "2026-05-08T00:00:00.000Z",
    turn_id: "turn-1",
    source: "backend",
    payload: {},
  }));
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("expected version_mismatch");
  }
  assert.equal(result.code, "version_mismatch");
  assert.equal(
    result.message,
    "收到协议版本不匹配的消息（expected=v2, actual=wrong）。",
  );
  assert.equal(result.warningKey, "version:wrong");
}

function testValidEnvelope(): void {
  const result = parseInboundEnvelope(JSON.stringify({
    type: "output.segment",
    version: "v2",
    message_id: "m-1",
    timestamp: "2026-05-08T00:00:00.000Z",
    turn_id: "turn-1",
    source: "backend",
    payload: { text: "hello" },
  }));
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected valid envelope");
  }
  assert.equal(result.envelope.type, "output.segment");
}

function testValidEnvelopeNormalizesTurnId(): void {
  const result = parseInboundEnvelope(JSON.stringify({
    type: "output.segment",
    version: "v2",
    message_id: "m-1",
    timestamp: "2026-05-08T00:00:00.000Z",
    turn_id: " turn-1 ",
    source: "backend",
    payload: { text: "hello" },
  }));
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected valid envelope");
  }
  assert.equal(result.envelope.turn_id, "turn-1");
}

function testParseInboundEnvelopeRejectsJsonNull(): void {
  const result = parseInboundEnvelope("null");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid_envelope");
    assert.equal(result.message, "收到非法协议消息（非对象）。");
  }
}

function run(): void {
  testInvalidJson();
  testInvalidEnvelope();
  testInvalidEnvelopeTopLevelFields();
  testVersionMismatch();
  testValidEnvelope();
  testValidEnvelopeNormalizesTurnId();
  testParseInboundEnvelopeRejectsJsonNull();

  console.log("inboundProtocol tests passed");
}

run();
