(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { mapInboundEnvelopeToEvent } from "../src/adapter-connection/inbound/inboundEvents.js";
import type { ProtocolEnvelope } from "../src/types/protocol.js";
import {
  makeValidModelSummary,
  makeValidModelSyncPayload,
  makeValidSemanticAxisProfile,
  makeValidVoiceFollowingProfile,
} from "./fixtures/modelSyncFixture.js";

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

function makeAtomicSegmentPayload() {
  return {
    schema_version: "output.segment.v3",
    text: { state: "present", content: "hello" },
    audio: {
      state: "present",
      url: "https://example.com/a.wav",
    },
    motion: {
      state: "present",
      message_type: "engine.motion_intent",
      mode: "expressive",
      source: "persona_effect",
      payload: {
        schema_version: "engine.motion_intent.v3",
      },
    },
    images: [],
    speaker_name: "assistant",
    avatar: "",
  };
}

function testOutputSegmentUsesEnvelopeIdentity(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.segment", makeAtomicSegmentPayload(), {
      turnId: "turn-1",
    }),
    defaultContext(),
  );

  assert.equal(event.kind, "output_segment");
  if (event.kind !== "output_segment") {
    throw new Error("expected output_segment event");
  }
  assert.equal(event.turnId, "turn-1");
  assert.equal(event.messageId, "m-1");
  assert.deepEqual(event.payload.text, { state: "present", content: "hello" });
  assert.equal(event.payload.audio.state, "present");
  assert.equal(event.payload.motion.state, "present");
}

function testOutputSegmentRequiresTurnId(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.segment", makeAtomicSegmentPayload(), {
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

function testOutputSegmentRejectsRemovedTopLevelPerformanceCurve(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.segment", {
      ...makeAtomicSegmentPayload(),
      performance_curve: { state: "disabled" },
    }, { turnId: "turn-1" }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "payload.performance_curve");
}

function testOutputSegmentRejectsRemovedAudioCaptionText(): void {
  const payload = makeAtomicSegmentPayload();
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.segment", {
      ...payload,
      audio: {
        ...payload.audio,
        caption_text: "legacy duplicate",
      },
    }, { turnId: "turn-1" }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "payload.audio.caption_text");
}

function testOutputSegmentRejectsUnknownSlotField(): void {
  const payload = makeAtomicSegmentPayload();
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.segment", {
      ...payload,
      text: {
        ...payload.text,
        legacy_text: "duplicate",
      },
    }, { turnId: "turn-1" }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "payload.text.legacy_text");
}

function testOutputSegmentRejectsV1Schema(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.segment", {
      ...makeAtomicSegmentPayload(),
      schema_version: "output.segment.v1",
    }, { turnId: "turn-1" }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "payload.schema_version");
}

function testOutputSegmentRejectsMotionMessageTypeMismatch(): void {
  const payload = makeAtomicSegmentPayload();
  payload.motion.message_type = "engine.catalog_motion";
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.segment", payload, { turnId: "turn-1" }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "payload.motion");
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

function testOldProductionMotionTypeIsUnhandled(): void {
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

  assert.equal(event.kind, "unhandled");
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

function testMissingSegmentMessageIdReturnsProtocolError(): void {
  const envelope = makeEnvelope("output.segment", makeAtomicSegmentPayload(), {
    turnId: "turn-legacy",
  });
  envelope.message_id = "";

  const event = mapInboundEnvelopeToEvent(envelope, defaultContext());

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.path, "message_id");
}

function testUnhandledTypeReturnsUnhandled(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("mystery.event", {}),
    defaultContext(),
  );

  assert.equal(event.kind, "unhandled");
}

function testInvalidOutputSegmentSlotReturnsProtocolError(): void {
  const payload = makeAtomicSegmentPayload();
  payload.audio = { state: "present", url: "" };
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("output.segment", payload, { turnId: "turn-1" }),
    defaultContext(),
  );

  assert.equal(event.kind, "protocol_error");
  if (event.kind !== "protocol_error") {
    throw new Error("expected protocol_error event");
  }
  assert.equal(event.error.code, "invalid_payload");
  assert.equal(event.error.path, "payload.audio");
  assert.equal(event.warningKey, "payload:output.segment:payload.audio");
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
    makeEnvelope("system.model_sync", makeValidModelSyncPayload()),
    defaultContext(),
  );
  assert.equal(event.kind, "model_sync");
}



function testModelSyncPayloadVoiceFollowingProfileBadTypeRejected(): void {
  const model = makeValidModelSummary({ voice_following_profile: "bad-string" });
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", makeValidModelSyncPayload({
      model_info: {
        schema_version: "live2d_scan.v1",
        driver_priority: ["parameters", "expression", "motion"],
        selected_model: model.name,
        available_models: [model.name],
        models: [model],
      },
    })),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
}

function testModelSyncPayloadRuntimeCacheErrorsBadTypeRejected(): void {
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", makeValidModelSyncPayload({
      runtime_cache_errors: "bad-string",
    })),
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

function testModelSyncPayloadOldVoiceFollowingProfileRejected(): void {
  const model = makeValidModelSummary({
    voice_following_profile: {
      schema_version: "ag99.voice_following_profile.v1",
      channels: {},
    },
  });
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", makeValidModelSyncPayload({
      model_info: {
        schema_version: "live2d_scan.v1",
        driver_priority: ["parameters", "expression", "motion"],
        selected_model: model.name,
        available_models: [model.name],
        models: [model],
      },
    })),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
  if (event.kind === "protocol_error") {
    assert.equal(
      event.error.path,
      "payload.model_info.models[0].voice_following_profile.schema_version",
    );
  }
}

function testModelSyncPayloadRejectsUnknownSelectedModel(): void {
  const payload = makeValidModelSyncPayload();
  const modelInfo = payload.model_info;
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", {
      ...payload,
      model_info: { ...modelInfo, selected_model: "missing-model" },
    }),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
  if (event.kind === "protocol_error") {
    assert.equal(event.error.path, "payload.model_info.selected_model");
  }
}

function testModelSyncPayloadRejectsMalformedSemanticAxisProfile(): void {
  const model = makeValidModelSummary({
    semantic_axis_profile: {
      ...makeValidSemanticAxisProfile(),
      revision: "1",
    },
  });
  const payload = makeValidModelSyncPayload({
    model_info: {
      schema_version: "live2d_scan.v1",
      driver_priority: ["parameters", "expression", "motion"],
      selected_model: model.name,
      available_models: [model.name],
      models: [model],
    },
  });
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", payload),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
  if (event.kind === "protocol_error") {
    assert.equal(event.error.path, "payload.model_info.models[0].semantic_axis_profile.revision");
  }
}

function testModelSyncPayloadRejectsMalformedVoiceFollowingChannel(): void {
  const profile = makeValidVoiceFollowingProfile();
  profile.channels.head_yaw.weight = 2;
  const model = makeValidModelSummary({ voice_following_profile: profile });
  const payload = makeValidModelSyncPayload({
    model_info: {
      schema_version: "live2d_scan.v1",
      driver_priority: ["parameters", "expression", "motion"],
      selected_model: model.name,
      available_models: [model.name],
      models: [model],
    },
  });
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", payload),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
  if (event.kind === "protocol_error") {
    assert.equal(
      event.error.path,
      "payload.model_info.models[0].voice_following_profile.channels.head_yaw.weight",
    );
  }
}

function testModelSyncPayloadRejectsNonStringRuntimeCacheError(): void {
  const payload = makeValidModelSyncPayload({
    runtime_cache_errors: { scan_cache: 42 },
  });
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", payload),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
  if (event.kind === "protocol_error") {
    assert.equal(event.error.path, "payload.runtime_cache_errors.scan_cache");
  }
}

function testModelSyncPayloadRejectsMissingModelUrl(): void {
  const model = makeValidModelSummary({ model_url: null });
  const payload = makeValidModelSyncPayload({
    model_info: {
      schema_version: "live2d_scan.v1",
      driver_priority: ["parameters", "expression", "motion"],
      selected_model: model.name,
      available_models: [model.name],
      models: [model],
    },
  });
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", payload),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
  if (event.kind === "protocol_error") {
    assert.equal(event.error.path, "payload.model_info.models[0].model_url");
  }
}

function testModelSyncPayloadRejectsMalformedModelUrl(): void {
  const model = makeValidModelSummary({ model_url: "not-a-url" });
  const payload = makeValidModelSyncPayload({
    model_info: {
      schema_version: "live2d_scan.v1",
      driver_priority: ["parameters", "expression", "motion"],
      selected_model: model.name,
      available_models: [model.name],
      models: [model],
    },
  });
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", payload),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
  if (event.kind === "protocol_error") {
    assert.equal(event.error.path, "payload.model_info.models[0].model_url");
  }
}

function testModelSyncPayloadRejectsInconsistentRuntimeCacheErrors(): void {
  const payload = makeValidModelSyncPayload({
    runtime_cache_errors: { scan_cache: "outer" },
  });
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", {
      ...payload,
      model_info: {
        ...payload.model_info,
        runtime_cache_errors: { scan_cache: "inner" },
      },
    }),
    defaultContext(),
  );
  assert.equal(event.kind, "protocol_error");
  if (event.kind === "protocol_error") {
    assert.equal(event.error.path, "payload.model_info.runtime_cache_errors");
  }
}

function testModelSyncPayloadAcceptsMatchingRuntimeCacheErrors(): void {
  const errors = { scan_cache: "scan failed" };
  const payload = makeValidModelSyncPayload({ runtime_cache_errors: errors });
  const event = mapInboundEnvelopeToEvent(
    makeEnvelope("system.model_sync", {
      ...payload,
      model_info: { ...payload.model_info, runtime_cache_errors: errors },
    }),
    defaultContext(),
  );
  assert.equal(event.kind, "model_sync");
}

function testMotionLabPersistedAckRequiresEventId(): void {
  const valid = mapInboundEnvelopeToEvent(
    makeEnvelope("system.motion_lab_raw_event_recorded", { event_id: " event-1 " }),
    defaultContext(),
  );
  assert.equal(valid.kind, "motion_lab_raw_event_recorded");
  if (valid.kind !== "motion_lab_raw_event_recorded") {
    throw new Error("expected motion_lab_raw_event_recorded event");
  }
  assert.equal(valid.envelope.payload.event_id, "event-1");

  const invalid = mapInboundEnvelopeToEvent(
    makeEnvelope("system.motion_lab_raw_event_recorded", { event_id: "" }),
    defaultContext(),
  );
  assert.equal(invalid.kind, "protocol_error");
}

function run(): void {
  testOutputSegmentUsesEnvelopeIdentity();
  testOutputSegmentRequiresTurnId();
  testOutputSegmentRejectsRemovedTopLevelPerformanceCurve();
  testOutputSegmentRejectsRemovedAudioCaptionText();
  testOutputSegmentRejectsUnknownSlotField();
  testOutputSegmentRejectsV1Schema();
  testOutputSegmentRejectsMotionMessageTypeMismatch();
  testTurnFinishedWithoutTurnIdIsRejected();
  testTurnStartedDoesNotInheritCurrentIdentity();
  testInterruptUsesEnvelopeIdentity();
  testInterruptWithoutTurnIdIsRejected();
  testSynthFinishedWithoutTurnIdIsRejected();
  testOldProductionMotionTypeIsUnhandled();
  testEngineMotionPreviewDoesNotRequireSegmentMessageId();
  testMissingSegmentMessageIdReturnsProtocolError();
  testUnhandledTypeReturnsUnhandled();
  testInvalidOutputSegmentSlotReturnsProtocolError();
  testInvalidTurnFinishedReasonReturnsProtocolError();
  testInvalidHistoryCreatedPayloadReturnsProtocolError();
  testModelSyncPayloadMissingSelectedModelRejected();
  testModelSyncPayloadEmptyModelsRejected();
  testModelSyncPayloadModelMissingNameRejected();
  testValidModelSyncPayloadPasses();
  testInvalidModelSyncPayloadReturnsProtocolError();

  testModelSyncPayloadRuntimeCacheErrorsBadTypeRejected();
  testModelSyncPayloadVoiceFollowingProfileBadTypeRejected();
  testModelSyncPayloadOldVoiceFollowingProfileRejected();
  testModelSyncPayloadRejectsUnknownSelectedModel();
  testModelSyncPayloadRejectsMalformedSemanticAxisProfile();
  testModelSyncPayloadRejectsMalformedVoiceFollowingChannel();
  testModelSyncPayloadRejectsNonStringRuntimeCacheError();
  testModelSyncPayloadRejectsMissingModelUrl();
  testModelSyncPayloadRejectsMalformedModelUrl();
  testModelSyncPayloadRejectsInconsistentRuntimeCacheErrors();
  testModelSyncPayloadAcceptsMatchingRuntimeCacheErrors();
  testInvalidMotionTuningSamplesStatePayloadReturnsProtocolError();
  testMotionLabPersistedAckRequiresEventId();

  console.log("inboundEvents tests passed");
}

run();
