(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { mapInboundEnvelopeToEvent } from "../src/adapter-connection/inboundEvents.js";
import type { ProtocolEnvelope } from "../src/types/protocol.js";

function makeEnvelope<TPayload>(
  type: string,
  payload: TPayload,
  options: {
    turnId?: string | null;
    orchestrationId?: string | null;
  } = {},
): ProtocolEnvelope<TPayload> {
  return {
    type,
    version: "v2",
    message_id: "m-1",
    timestamp: "2026-05-08T00:00:00.000Z",
    session_id: "session-1",
    turn_id: options.turnId ?? null,
    orchestration_id: options.orchestrationId ?? null,
    source: "backend",
    payload,
  };
}

function defaultContext() {
  return {
    currentTurnId: "current-turn",
    currentOrchestrationId: "current-orch",
    audioPlaybackStartedTurnId: "audio-turn",
    audioPlaybackStartedOrchestrationId: "audio-orch",
  };
}

function testOutputTextUsesEnvelopeIdentity(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.text", {
      text: " hello ",
      speaker_name: "assistant",
      avatar: "",
    }, {
      turnId: "turn-1",
      orchestrationId: "orch-1",
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "output_text");
  if (event.kind !== "output_text") {
    throw new Error("expected output_text event");
  }
  assert.equal(event.turnId, "turn-1");
  assert.equal(event.orchestrationId, "orch-1");
  assert.equal(event.messageId, "m-1");
  assert.equal(event.text, "hello");
}

function testOutputAudioFallsBackToCurrentOrchestration(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.audio", {
      text: " hi ",
      audio_url: " https://example.com/a.wav ",
      speaker_name: "assistant",
      avatar: "",
    }, {
      turnId: "turn-2",
      orchestrationId: null,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "output_audio");
  if (event.kind !== "output_audio") {
    throw new Error("expected output_audio event");
  }
  assert.equal(event.turnId, "turn-2");
  assert.equal(event.orchestrationId, "current-orch");
  assert.equal(event.messageId, "m-1");
  assert.equal(event.text, "hi");
  assert.equal(event.audioUrl, "https://example.com/a.wav");
}

function testTurnFinishedFallsBackToActiveIdentity(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("control.turn_finished", {
      success: true,
      reason: " done ",
    }, {
      turnId: null,
      orchestrationId: null,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "turn_finished");
  if (event.kind !== "turn_finished") {
    throw new Error("expected turn_finished event");
  }
  assert.equal(event.turnId, "current-turn");
  assert.equal(event.orchestrationId, "current-orch");
  assert.equal(event.reason, "done");
}

function testTurnStartedDoesNotInheritCurrentIdentity(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("control.turn_started", {}, {
      turnId: null,
      orchestrationId: null,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "turn_started");
  if (event.kind !== "turn_started") {
    throw new Error("expected turn_started event");
  }
  assert.equal(event.turnId, null);
  assert.equal(event.orchestrationId, null);
}

function testInterruptUsesCurrentIdentity(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("control.interrupt", {}, {
      turnId: "stale-turn",
      orchestrationId: "stale-orch",
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "interrupt");
  if (event.kind !== "interrupt") {
    throw new Error("expected interrupt event");
  }
  assert.equal(event.turnId, "current-turn");
  assert.equal(event.orchestrationId, "current-orch");
}

function testEngineMotionFallsBackCurrentThenAudio(): void {
  const currentContext = {
    currentTurnId: "current-turn",
    currentOrchestrationId: null,
    audioPlaybackStartedTurnId: "audio-turn",
    audioPlaybackStartedOrchestrationId: "audio-orch",
  };
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("engine.motion_intent", {
      mode: "preview",
      intent: {
        schema_version: "engine.motion_intent.v2",
      },
    }, {
      turnId: null,
      orchestrationId: null,
    }),
    currentContext,
  );

  assert.equal(event.kind, "engine_motion_payload");
  if (event.kind !== "engine_motion_payload") {
    throw new Error("expected engine_motion_payload event");
  }
  assert.equal(event.turnId, "current-turn");
  assert.equal(event.orchestrationId, "audio-orch");
  assert.equal(event.messageId, "m-1");
}

function testMissingSegmentMessageIdReturnsProtocolError(): void {
  const envelopeA = makeEnvelope("output.text", {
    text: " first ",
    speaker_name: "assistant",
    avatar: "",
  }, {
    turnId: "turn-legacy",
    orchestrationId: "orch-legacy",
  });
  const envelopeB = makeEnvelope("engine.motion_intent", {
    mode: "preview",
    intent: {
      schema_version: "engine.motion_intent.v2",
    },
  }, {
    turnId: "turn-legacy",
    orchestrationId: "orch-legacy",
  });
  envelopeA.message_id = "";
  envelopeB.message_id = "";

  const eventA = mapInboundEnvelopeToEvent(envelopeA, defaultContext());
  const eventB = mapInboundEnvelopeToEvent(envelopeB, defaultContext());

  assert.equal(eventA.kind, "protocol_error");
  assert.equal(eventB.kind, "protocol_error");
  if (eventA.kind !== "protocol_error" || eventB.kind !== "protocol_error") {
    throw new Error("expected protocol_error events");
  }
  assert.equal(eventA.error.path, "message_id");
  assert.equal(eventB.error.path, "message_id");
}

function testUnhandledTypeReturnsUnhandled(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("mystery.event", {}),
    defaultContext(),
  );

  assert.equal(event.kind, "unhandled");
}

function testInvalidOutputTextPayloadReturnsProtocolError(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.text", {
      text: 123,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.code, "invalid_payload");
  assert.equal(event.error.path, "payload.text");
  assert.equal(event.warningKey, "payload:output.text:payload.text");
}

function testInvalidTurnFinishedReasonReturnsProtocolError(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("control.turn_finished", {
      success: true,
      reason: 123,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "payload.reason");
}

function testInvalidHistoryCreatedPayloadReturnsProtocolError(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.history_created", {
      history_uid: null,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "payload.history_uid");
}

function run(): void {
  testOutputTextUsesEnvelopeIdentity();
  testOutputAudioFallsBackToCurrentOrchestration();
  testTurnFinishedFallsBackToActiveIdentity();
  testTurnStartedDoesNotInheritCurrentIdentity();
  testInterruptUsesCurrentIdentity();
  testEngineMotionFallsBackCurrentThenAudio();
  testMissingSegmentMessageIdReturnsProtocolError();
  testUnhandledTypeReturnsUnhandled();
  testInvalidOutputTextPayloadReturnsProtocolError();
  testInvalidTurnFinishedReasonReturnsProtocolError();
  testInvalidHistoryCreatedPayloadReturnsProtocolError();

  console.log("inboundEvents tests passed");
}

run();
