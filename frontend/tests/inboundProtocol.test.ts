import assert from "node:assert/strict";
import {
  parseInboundEnvelope,
  parseInboundEnvelopeObject,
} from "../src/adapter-connection/inbound/inboundProtocol.js";

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
  assert.equal(result.message, "收到非法协议消息。");
}

function testVersionMismatch(): void {
  const result = parseInboundEnvelope(JSON.stringify({
    type: "output.text",
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
    type: "output.text",
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
  assert.equal(result.envelope.type, "output.text");
}

function testParseInboundEnvelopeObjectNull(): void {
  const result = parseInboundEnvelopeObject(null);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid_envelope");
  }
}

function testParseInboundEnvelopeObjectNonObject(): void {
  const result = parseInboundEnvelopeObject("string");
  assert.equal(result.ok, false);
}

function testParseInboundEnvelopeObjectValid(): void {
  const result = parseInboundEnvelopeObject({
    type: "system.model_sync",
    version: "v2",
    message_id: "m-1",
    timestamp: "2026-05-08T00:00:00.000Z",
    turn_id: null,
    source: "backend",
    payload: {},
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.envelope.type, "system.model_sync");
  }
}

function testParseInboundEnvelopeObjectBadVersion(): void {
  const result = parseInboundEnvelopeObject({
    type: "system.model_sync",
    version: "wrong",
    message_id: "m-1",
    timestamp: "",
    turn_id: null,
    source: "backend",
    payload: {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "version_mismatch");
  }
}

function run(): void {
  testInvalidJson();
  testInvalidEnvelope();
  testVersionMismatch();
  testValidEnvelope();
  testParseInboundEnvelopeObjectNull();
  testParseInboundEnvelopeObjectNonObject();
  testParseInboundEnvelopeObjectValid();
  testParseInboundEnvelopeObjectBadVersion();

  console.log("inboundProtocol tests passed");
}

run();
