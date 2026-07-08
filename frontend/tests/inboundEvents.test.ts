(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { mapInboundEnvelopeToEvent } from "../src/adapter-connection/inbound/inboundEvents.js";
import type { ProtocolEnvelope } from "../src/types/protocol.js";

function makeEnvelope<TPayload>(
  type: string,
  payload: TPayload,
  options: {
    turnId?: string | null;
  } = {},
): ProtocolEnvelope<TPayload> {
  return {
    type,
    version: "v2",
    message_id: "m-1",
    timestamp: "2026-05-08T00:00:00.000Z",
    turn_id: options.turnId ?? null,
    source: "backend",
    payload,
  };
}

function defaultContext() {
  return {
    currentTurnId: "current-turn",
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
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "output_text");
  if (event.kind !== "output_text") {
    throw new Error("expected output_text event");
  }
  assert.equal(event.turnId, "turn-1");
  assert.equal(event.messageId, "m-1");
  assert.equal(event.text, "hello");
  assert.equal(event.audioExpected, false);
}

function testOutputTextMapsAudioExpected(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.text", {
      text: " hello ",
      speaker_name: "assistant",
      avatar: "",
      audio_expected: true,
    }, {
      turnId: "turn-1",
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "output_text");
  if (event.kind !== "output_text") {
    throw new Error("expected output_text event");
  }
  assert.equal(event.audioExpected, true);
}

function testOutputAudioUsesEnvelopeIdentity(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.audio", {
      caption_text: " hi ",
      audio_url: " https://example.com/a.wav ",
      speaker_name: "assistant",
      avatar: "",
    }, {
      turnId: "turn-2",
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "output_audio");
  if (event.kind !== "output_audio") {
    throw new Error("expected output_audio event");
  }
  assert.equal(event.turnId, "turn-2");
  assert.equal(event.messageId, "m-1");
  assert.equal(event.captionText, "hi");
  assert.equal(event.audioUrl, "https://example.com/a.wav");
}

function testOutputTextRequiresTurnId(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.text", {
      text: " hello ",
      speaker_name: "assistant",
      avatar: "",
    }, {
      turnId: null,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "turn_id");
}

function testOutputAudioRequiresTurnId(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.audio", {
      caption_text: " hi ",
      audio_url: "https://example.com/a.wav",
      speaker_name: "assistant",
      avatar: "",
    }, {
      turnId: null,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "turn_id");
}

function testTurnFinishedWithoutTurnIdIsRejected(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("control.turn_finished", {
      success: true,
      reason: " done ",
    }, {
      turnId: null,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "turn_id");
}

function testTurnStartedDoesNotInheritCurrentIdentity(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("control.turn_started", {}, {
      turnId: null,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "turn_started");
  if (event.kind !== "turn_started") {
    throw new Error("expected turn_started event");
  }
  assert.equal(event.turnId, null);
}

function testInterruptUsesEnvelopeIdentity(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("control.interrupt", {}, {
      turnId: "target-turn",
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "interrupt");
  if (event.kind !== "interrupt") {
    throw new Error("expected interrupt event");
  }
  assert.equal(event.turnId, "target-turn");
}

function testInterruptWithoutTurnIdIsRejected(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("control.interrupt", {}, {
      turnId: null,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "turn_id");
}

function testSynthFinishedWithoutTurnIdIsRejected(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("control.synth_finished", {}, {
      turnId: null,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "turn_id");
}

function testEngineMotionRequiresTurnId(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("engine.motion_intent", {
      mode: "preview",
      intent: {
        schema_version: "engine.motion_intent.v3",
      },
    }, {
      turnId: null,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "turn_id");
}

function testEngineCatalogMotionMapsAsMotionPayload(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("engine.catalog_motion", {
      mode: "preview",
      motion: {
        schema_version: "engine.catalog_motion.v1",
      },
    }, {
      turnId: "turn-1",
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "engine_motion_payload");
  if (event.kind !== "engine_motion_payload") {
    throw new Error("expected engine_motion_payload event");
  }
  assert.equal(event.turnId, "turn-1");
  assert.equal(event.messageId, "m-1");
}

function testEngineMotionPreviewDoesNotRequireSegmentMessageId(): void {
  const envelope = makeEnvelope("engine.motion_preview", {
    mode: "preview",
    motion_type: "engine.motion_intent",
    intent: {
      schema_version: "engine.motion_intent.v3",
    },
  }, {
    turnId: null,
  });
  envelope.message_id = "";

  const event = mapInboundEnvelopeToEvent(envelope, defaultContext());

  assert.equal(event.kind, "engine_motion_preview");
}

function testPerformanceCurveHintMapsAsSegmentPatch(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("engine.performance_curve_hint", {
      schema_version: "ag99.performance_curve_hint.v1",
      curve_family: "quick_in_hold_soft_out",
      entry: "quick",
      hold: "steady",
      exit: "soft",
      emphasis: "early",
      energy: "medium",
    }, {
      turnId: "turn-curve",
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "engine_performance_curve_hint");
  if (event.kind !== "engine_performance_curve_hint") {
    throw new Error("expected engine_performance_curve_hint event");
  }
  assert.equal(event.turnId, "turn-curve");
  assert.equal(event.messageId, "m-1");
}

function testPerformanceCurveHintRequiresTurnId(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("engine.performance_curve_hint", {
      schema_version: "ag99.performance_curve_hint.v1",
      curve_family: "quick_in_hold_soft_out",
      entry: "quick",
      hold: "steady",
      exit: "soft",
      emphasis: "early",
      energy: "medium",
    }, {
      turnId: null,
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "turn_id");
}

function testMissingSegmentMessageIdReturnsProtocolError(): void {
  const envelopeA = makeEnvelope("output.text", {
    text: " first ",
    speaker_name: "assistant",
    avatar: "",
  }, {
    turnId: "turn-legacy",
  });
  const envelopeB = makeEnvelope("engine.motion_intent", {
    mode: "preview",
    intent: {
      schema_version: "engine.motion_intent.v3",
    },
  }, {
    turnId: "turn-legacy",
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

function testInvalidOutputTextAudioExpectedReturnsProtocolError(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.text", {
      text: "hello",
      audio_expected: "true",
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.code, "invalid_payload");
  assert.equal(event.error.path, "payload.audio_expected");
}

function testOutputAudioRejectsVisibleTextPayloadField(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.audio", {
      text: "legacy visible text field",
      audio_url: "https://example.com/a.wav",
      speaker_name: "assistant",
      avatar: "",
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.code, "invalid_payload");
  assert.equal(event.error.path, "payload.caption_text");
  assert.equal(event.warningKey, "payload:output.audio:payload.caption_text");
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

function testInvalidModelSyncPayloadReturnsProtocolError(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", {
      model_info: null,
      conf_name: "default",
      conf_uid: "conf-1",
      client_uid: "client-1",
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "payload.model_info");
}



function testModelSyncPayloadMissingSelectedModelRejected(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", {
      model_info: { models: [{ name: "model-a" }] },
      conf_name: "default",
      conf_uid: "conf-1",
      client_uid: "client-1",
    }),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
}

function testModelSyncPayloadEmptyModelsRejected(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", {
      model_info: { selected_model: "model-a", models: [] },
      conf_name: "default",
      conf_uid: "conf-1",
      client_uid: "client-1",
    }),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
}

function testModelSyncPayloadModelMissingNameRejected(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", {
      model_info: {
        selected_model: "model-a",
        models: [{ icon_url: "https://example.com/icon.png" }],
      },
      conf_name: "default",
      conf_uid: "conf-1",
      client_uid: "client-1",
    }),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
}

function testValidModelSyncPayloadPasses(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", {
      model_info: { selected_model: "model-a", models: [{ name: "model-a" }] },
      conf_name: "default",
      conf_uid: "conf-1",
      client_uid: "client-1",
    }),
    defaultContext(),
  );
  assert.equal(event.kind, "model_sync");
}



function testModelSyncPayloadVoiceFollowingProfileBadTypeRejected(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", {
      model_info: {
        selected_model: "model-a",
        models: [{ name: "model-a", voice_following_profile: "bad-string" }],
      },
      conf_name: "default",
      conf_uid: "conf-1",
      client_uid: "client-1",
    }),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
}

function testModelSyncPayloadRuntimeCacheErrorsBadTypeRejected(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", {
      model_info: {
        selected_model: "model-a",
        models: [{ name: "model-a" }],
      },
      runtime_cache_errors: "bad-string",
      conf_name: "default",
      conf_uid: "conf-1",
      client_uid: "client-1",
    }),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
}

function testInvalidMotionTuningSamplesStatePayloadReturnsProtocolError(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.motion_tuning_samples_state", {
      samples: {},
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "payload.samples");
}

function run(): void {
  testOutputTextUsesEnvelopeIdentity();
  testOutputTextMapsAudioExpected();
  testOutputAudioUsesEnvelopeIdentity();
  testOutputTextRequiresTurnId();
  testOutputAudioRequiresTurnId();
  testTurnFinishedWithoutTurnIdIsRejected();
  testTurnStartedDoesNotInheritCurrentIdentity();
  testInterruptUsesEnvelopeIdentity();
  testInterruptWithoutTurnIdIsRejected();
  testSynthFinishedWithoutTurnIdIsRejected();
  testEngineMotionRequiresTurnId();
  testEngineCatalogMotionMapsAsMotionPayload();
  testEngineMotionPreviewDoesNotRequireSegmentMessageId();
  testPerformanceCurveHintMapsAsSegmentPatch();
  testPerformanceCurveHintRequiresTurnId();
  testMissingSegmentMessageIdReturnsProtocolError();
  testUnhandledTypeReturnsUnhandled();
  testInvalidOutputTextPayloadReturnsProtocolError();
  testInvalidOutputTextAudioExpectedReturnsProtocolError();
  testOutputAudioRejectsVisibleTextPayloadField();
  testInvalidTurnFinishedReasonReturnsProtocolError();
  testInvalidHistoryCreatedPayloadReturnsProtocolError();
  testModelSyncPayloadMissingSelectedModelRejected();
  testModelSyncPayloadEmptyModelsRejected();
  testModelSyncPayloadModelMissingNameRejected();
  testValidModelSyncPayloadPasses();
  testInvalidModelSyncPayloadReturnsProtocolError();

  testModelSyncPayloadRuntimeCacheErrorsBadTypeRejected();
  testModelSyncPayloadVoiceFollowingProfileBadTypeRejected();
  testInvalidMotionTuningSamplesStatePayloadReturnsProtocolError();

  console.log("inboundEvents tests passed");
}

run();
