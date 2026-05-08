import assert from "node:assert/strict";
import { parseInboundEnvelope } from "../src/adapter-connection/inboundProtocol.js";

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
    session_id: "session-1",
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
    session_id: "session-1",
    turn_id: "turn-1",
    orchestration_id: "orch-1",
    source: "backend",
    payload: { text: "hello" },
  }));
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected valid envelope");
  }
  assert.equal(result.envelope.type, "output.text");
}

function run(): void {
  testInvalidJson();
  testInvalidEnvelope();
  testVersionMismatch();
  testValidEnvelope();

  console.log("inboundProtocol tests passed");
}

run();
