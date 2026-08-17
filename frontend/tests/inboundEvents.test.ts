(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { mapInboundEnvelopeToEvent } from "../src/adapter-connection/inbound/inboundEvents.js";
import type { ProtocolEnvelope } from "../src/types/protocol.js";
import { makeValidModelSyncPayload } from "./fixtures/modelSyncFixture.js";

function makeEnvelope<TPayload>(
  type: string,
  payload: TPayload,
  turnId: string | null,
): ProtocolEnvelope<TPayload> {
  return {
    type,
    version: "v2",
    message_id: "message-1",
    timestamp: "2026-05-08T00:00:00.000Z",
    turn_id: turnId,
    source: "backend",
    payload,
  };
}

function buildOutputSegment() {
  return {
    schema_version: "output.segment.v4",
    text: { state: "present", content: "hello" },
    audio: { state: "present", url: "https://example.com/audio.wav" },
    motion: {
      state: "present",
      message_type: "engine.motion_intent",
      mode: "expressive",
      source: "persona_effect",
      payload: {
        schema_version: "engine.motion_intent.v4",
        profile_id: "profile-1",
        profile_revision: 1,
        model_id: "model-1",
        mode: "expressive",
        intent_tags: ["happy"],
        axis_levels: { head_yaw: 2 },
      },
    },
    speech: {
      state: "present",
      cues: [{ kind: "emphasis", phrase_index: 0, position: "before" }],
    },
    images: [],
    speaker_name: "assistant",
    avatar: "",
  };
}

function testMapsAtomicOutputSegment(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.segment", buildOutputSegment(), "turn-1"),
    { currentTurnId: null },
  );

  assert.equal(event.kind, "output_segment");
  if (event.kind !== "output_segment") {
    throw new Error("Expected output_segment event.");
  }
  assert.equal(event.turnId, "turn-1");
  assert.equal(event.messageId, "message-1");
  assert.equal(event.payload.audio.state, "present");
  assert.equal(event.payload.motion.state, "present");
  assert.equal(event.payload.speech.state, "present");
}

function testRejectsOutputSegmentWithoutTurnIdentity(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.segment", buildOutputSegment(), null),
    { currentTurnId: "must-not-be-inherited" },
  );

  assert.equal(event.kind, "protocol_error");
}

function testMapsModelSync(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", makeValidModelSyncPayload(), null),
    { currentTurnId: null },
  );

  assert.equal(event.kind, "model_sync");
}

testMapsAtomicOutputSegment();
testRejectsOutputSegmentWithoutTurnIdentity();
testMapsModelSync();
console.log("inboundEvents smoke tests passed");
