import type {
  ControlErrorPayload,
  ControlTurnFinishedPayload,
  OutputSegmentPayload,
  OutputTranscriptionPayload,
  ProtocolEnvelope,
  SystemHistoryCreatedPayload,
  SystemHistoryDataPayload,
  SystemHistoryDeletedPayload,
  SystemHistoryListPayload,
  SystemSemanticAxisProfileSavedPayload,
  SystemSemanticAxisProfileSaveFailedPayload,
  SystemMotionTuningSamplesStatePayload,
  SystemMotionLabRawEventRecordedPayload,
  SystemServerInfoPayload,
} from "../../types/protocol.js";
import {
  PROTOCOL_VERSION,
  SCHEMA_CATALOG_MOTION_V1,
  SCHEMA_MODEL_INFO_V2,
  SCHEMA_MOTION_INTENT_V4,
  SCHEMA_MOTION_TUNING_SAMPLE_V2,
  SCHEMA_OUTPUT_SEGMENT_V3,
  SCHEMA_PARAMETER_PLAN_V2,
  SCHEMA_PERFORMANCE_CURVE_HINT_V1,
  SCHEMA_SEMANTIC_AXIS_PROFILE_V2,
  SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1,
  SCHEMA_VOICE_FOLLOWING_PROFILE_V3,
} from "../../types/protocolSchema.generated.js";
import {
  asRecord,
  invalidPayload,
  optionalString,
  requiredBoolean,
  requiredNumber,
  requiredString,
  validateExactKeys,
  type PayloadParseResult,
} from "./payloadValidation.js";

export type { PayloadParseError, PayloadParseResult } from "./payloadValidation.js";
export { parseSystemModelSyncPayload } from "./modelSyncPayload.js";

function parseObjectPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<Record<string, unknown>> {
  const record = asRecord(envelope.payload);
  if (!record) {
    return invalidPayload(envelope.type, "payload", "object");
  }
  return { ok: true, payload: record };
}

export function parseOutputSegmentPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<OutputSegmentPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  if (record.payload.schema_version !== "output.segment.v3") {
    return invalidPayload(envelope.type, "payload.schema_version", "output.segment.v3");
  }
  const rootKeys = validateExactKeys(
    envelope.type,
    "payload",
    record.payload,
    ["schema_version", "text", "audio", "motion", "images", "speaker_name", "avatar"],
  );
  if (!rootKeys.ok) return rootKeys;
  const text = parseSegmentTextSlot(envelope.type, record.payload.text);
  if (!text.ok) return text;
  const audio = parseSegmentAudioSlot(envelope.type, record.payload.audio);
  if (!audio.ok) return audio;
  if (audio.payload.state === "present" && text.payload.state !== "present") {
    return invalidPayload(
      envelope.type,
      "payload.text",
      "present canonical text when audio is present",
    );
  }
  const motion = parseSegmentMotionSlot(envelope.type, record.payload.motion);
  if (!motion.ok) return motion;
  const images = record.payload.images;
  if (!Array.isArray(images) || !images.every((item) => typeof item === "string")) {
    return invalidPayload(envelope.type, "payload.images", "string[]");
  }
  for (const key of ["speaker_name", "avatar"] as const) {
    if (key in record.payload && typeof record.payload[key] !== "string") {
      return invalidPayload(envelope.type, `payload.${key}`, "string");
    }
  }
  return {
    ok: true,
    payload: {
      schema_version: "output.segment.v3",
      text: text.payload,
      audio: audio.payload,
      motion: motion.payload,
      images,
      speaker_name: optionalString(record.payload.speaker_name) ?? "",
      avatar: optionalString(record.payload.avatar) ?? "",
    },
  }
}

function parseSegmentTextSlot(type: string, value: unknown): PayloadParseResult<OutputSegmentPayload["text"]> {
  const slot = asRecord(value);
  if (!slot) return invalidPayload(type, "payload.text", "segment text slot");
  if (slot.state === "absent") {
    const keys = validateExactKeys(type, "payload.text", slot, ["state"]);
    return keys.ok ? { ok: true, payload: { state: "absent" } } : keys;
  }
  if (slot.state === "present" && typeof slot.content === "string" && slot.content.trim()) {
    const keys = validateExactKeys(type, "payload.text", slot, ["state", "content"]);
    if (!keys.ok) return keys;
    return { ok: true, payload: { state: "present", content: slot.content.trim() } };
  }
  if (slot.state === "failed" && typeof slot.reason === "string" && slot.reason.trim()) {
    const keys = validateExactKeys(type, "payload.text", slot, ["state", "reason"]);
    if (!keys.ok) return keys;
    return { ok: true, payload: { state: "failed", reason: slot.reason.trim() } };
  }
  return invalidPayload(type, "payload.text", "valid tagged text slot");
}

function parseSegmentAudioSlot(type: string, value: unknown): PayloadParseResult<OutputSegmentPayload["audio"]> {
  const slot = asRecord(value);
  if (!slot) return invalidPayload(type, "payload.audio", "segment audio slot");
  if (slot.state === "absent") {
    const keys = validateExactKeys(type, "payload.audio", slot, ["state"]);
    return keys.ok ? { ok: true, payload: { state: "absent" } } : keys;
  }
  if (
    slot.state === "present"
    && typeof slot.url === "string"
    && slot.url.trim()
  ) {
    const keys = validateExactKeys(type, "payload.audio", slot, ["state", "url"]);
    if (!keys.ok) return keys;
    return {
      ok: true,
      payload: { state: "present", url: slot.url.trim() },
    };
  }
  if (slot.state === "failed" && typeof slot.reason === "string" && slot.reason.trim()) {
    const keys = validateExactKeys(type, "payload.audio", slot, ["state", "reason"]);
    if (!keys.ok) return keys;
    return { ok: true, payload: { state: "failed", reason: slot.reason.trim() } };
  }
  return invalidPayload(type, "payload.audio", "valid tagged audio slot");
}

function parseSegmentMotionSlot(type: string, value: unknown): PayloadParseResult<OutputSegmentPayload["motion"]> {
  const slot = asRecord(value);
  if (!slot) return invalidPayload(type, "payload.motion", "segment motion slot");
  if (slot.state === "absent") {
    const keys = validateExactKeys(type, "payload.motion", slot, ["state"]);
    return keys.ok ? { ok: true, payload: { state: "absent" } } : keys;
  }
  if (slot.state === "failed" && typeof slot.reason === "string" && slot.reason.trim()) {
    const keys = validateExactKeys(type, "payload.motion", slot, ["state", "reason"]);
    if (!keys.ok) return keys;
    return { ok: true, payload: { state: "failed", reason: slot.reason.trim() } };
  }
  const payload = asRecord(slot.payload);
  const schemaVersion = payload?.schema_version;
  const expectedMessageType = schemaVersion === "engine.catalog_motion.v1"
    ? "engine.catalog_motion"
    : schemaVersion === "engine.motion_intent.v4"
      ? "engine.motion_intent"
      : null;
  if (
    slot.state === "present"
    && (slot.message_type === "engine.motion_intent" || slot.message_type === "engine.catalog_motion")
    && slot.message_type === expectedMessageType
    && typeof slot.mode === "string"
    && typeof slot.source === "string"
    && payload
  ) {
    const keys = validateExactKeys(
      type,
      "payload.motion",
      slot,
      ["state", "message_type", "mode", "source", "payload"],
    );
    if (!keys.ok) return keys;
    return {
      ok: true,
      payload: {
        state: "present",
        message_type: slot.message_type,
        mode: slot.mode,
        source: slot.source,
        payload,
      },
    };
  }
  return invalidPayload(type, "payload.motion", "valid tagged motion slot");
}

export function parseOutputTranscriptionPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<OutputTranscriptionPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const text = requiredString(envelope.type, record.payload, "text");
  return text.ok ? { ok: true, payload: { text: text.payload } } : text;
}

export function parseControlTurnFinishedPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<ControlTurnFinishedPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const success = requiredBoolean(envelope.type, record.payload, "success");
  if (!success.ok) return success;
  const reason = record.payload.reason;
  if (reason !== undefined && typeof reason !== "string") {
    return invalidPayload(envelope.type, "payload.reason", "string | undefined");
  }
  return {
    ok: true,
    payload: {
      success: success.payload,
      reason,
    },
  };
}

export function parseControlErrorPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<ControlErrorPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const message = requiredString(envelope.type, record.payload, "message");
  return message.ok ? { ok: true, payload: { message: message.payload } } : message;
}

export function parseSystemMotionLabRawEventRecordedPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<SystemMotionLabRawEventRecordedPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const eventId = requiredString(envelope.type, record.payload, "event_id");
  if (!eventId.ok) return eventId;
  if (!eventId.payload.trim()) {
    return invalidPayload(envelope.type, "payload.event_id", "non-empty string");
  }
  return { ok: true, payload: { event_id: eventId.payload.trim() } };
}

export function parseSystemServerInfoPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<SystemServerInfoPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const wsUrl = requiredString(envelope.type, record.payload, "ws_url");
  if (!wsUrl.ok) return wsUrl;
  const httpBaseUrl = requiredString(envelope.type, record.payload, "http_base_url");
  if (!httpBaseUrl.ok) return httpBaseUrl;
  const autoStartMic = requiredBoolean(envelope.type, record.payload, "auto_start_mic");
  if (!autoStartMic.ok) return autoStartMic;
  const schemaManifest = parseSchemaManifest(envelope.type, record.payload.schema_manifest);
  if (!schemaManifest.ok) return schemaManifest;
  return {
    ok: true,
    payload: {
      ws_url: wsUrl.payload,
      http_base_url: httpBaseUrl.payload,
      auto_start_mic: autoStartMic.payload,
      schema_manifest: schemaManifest.payload,
    },
  };
}

function parseSchemaManifest(
  type: string,
  value: unknown,
): PayloadParseResult<SystemServerInfoPayload["schema_manifest"]> {
  const manifest = asRecord(value);
  if (!manifest) return invalidPayload(type, "payload.schema_manifest", "object");
  const manifestKeys = validateExactKeys(
    type,
    "payload.schema_manifest",
    manifest,
    ["protocol_version", "schemas"],
  );
  if (!manifestKeys.ok) return manifestKeys;
  if (manifest.protocol_version !== PROTOCOL_VERSION) {
    return invalidPayload(type, "payload.schema_manifest.protocol_version", PROTOCOL_VERSION);
  }
  const schemas = asRecord(manifest.schemas);
  if (!schemas) return invalidPayload(type, "payload.schema_manifest.schemas", "object");
  const expected = {
    catalog_motion: SCHEMA_CATALOG_MOTION_V1,
    model_info: SCHEMA_MODEL_INFO_V2,
    motion_intent: SCHEMA_MOTION_INTENT_V4,
    motion_tuning_sample: SCHEMA_MOTION_TUNING_SAMPLE_V2,
    output_segment: SCHEMA_OUTPUT_SEGMENT_V3,
    parameter_plan: SCHEMA_PARAMETER_PLAN_V2,
    performance_curve_hint: SCHEMA_PERFORMANCE_CURVE_HINT_V1,
    semantic_axis_profile: SCHEMA_SEMANTIC_AXIS_PROFILE_V2,
    semantic_axis_relation_graph: SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1,
    voice_following_profile: SCHEMA_VOICE_FOLLOWING_PROFILE_V3,
  } as const;
  const schemaKeys = validateExactKeys(
    type,
    "payload.schema_manifest.schemas",
    schemas,
    Object.keys(expected),
  );
  if (!schemaKeys.ok) return schemaKeys;
  for (const [name, expectedVersion] of Object.entries(expected)) {
    if (schemas[name] !== expectedVersion) {
      return invalidPayload(
        type,
        `payload.schema_manifest.schemas.${name}`,
        expectedVersion,
      );
    }
  }
  return {
    ok: true,
    payload: {
      protocol_version: PROTOCOL_VERSION,
      schemas: expected,
    },
  };
}

export function parseMotionTuningSamplesStatePayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<SystemMotionTuningSamplesStatePayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const samples = record.payload.samples;
  if (!Array.isArray(samples)) {
    return invalidPayload(envelope.type, "payload.samples", "array");
  }
  const rootError = record.payload.root_error;
  if (rootError !== undefined && typeof rootError !== "string") {
    return invalidPayload(envelope.type, "payload.root_error", "string | undefined");
  }
  const loadError = record.payload.load_error;
  if (loadError !== undefined && typeof loadError !== "string") {
    return invalidPayload(envelope.type, "payload.load_error", "string | undefined");
  }
  const diagnostics = record.payload.diagnostics;
  if (
    diagnostics !== undefined
    && (!Array.isArray(diagnostics) || !diagnostics.every((item) => typeof item === "string"))
  ) {
    return invalidPayload(envelope.type, "payload.diagnostics", "string[] | undefined");
  }
  const effectiveExamples = record.payload.effective_examples;
  if (effectiveExamples !== undefined && !Array.isArray(effectiveExamples)) {
    return invalidPayload(envelope.type, "payload.effective_examples", "array | undefined");
  }
  return {
    ok: true,
    payload: {
      root_error: rootError,
      samples,
      load_error: loadError,
      diagnostics,
      effective_examples: effectiveExamples as SystemMotionTuningSamplesStatePayload["effective_examples"],
    },
  };
}

export function parseSemanticAxisProfileSavedPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<SystemSemanticAxisProfileSavedPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const requestId = requiredString(envelope.type, record.payload, "request_id");
  if (!requestId.ok) return requestId;
  const modelName = requiredString(envelope.type, record.payload, "model_name");
  if (!modelName.ok) return modelName;
  const profileId = requiredString(envelope.type, record.payload, "profile_id");
  if (!profileId.ok) return profileId;
  const revision = requiredNumber(envelope.type, record.payload, "revision");
  if (!revision.ok) return revision;
  const sourceHash = requiredString(envelope.type, record.payload, "source_hash");
  if (!sourceHash.ok) return sourceHash;
  const savedAt = requiredString(envelope.type, record.payload, "saved_at");
  if (!savedAt.ok) return savedAt;
  return {
    ok: true,
    payload: {
      request_id: requestId.payload,
      model_name: modelName.payload,
      profile_id: profileId.payload,
      revision: revision.payload,
      source_hash: sourceHash.payload,
      saved_at: savedAt.payload,
    },
  };
}

export function parseSemanticAxisProfileSaveFailedPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<SystemSemanticAxisProfileSaveFailedPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const requestId = requiredString(envelope.type, record.payload, "request_id");
  if (!requestId.ok) return requestId;
  const modelName = requiredString(envelope.type, record.payload, "model_name");
  if (!modelName.ok) return modelName;
  const profileId = requiredString(envelope.type, record.payload, "profile_id");
  if (!profileId.ok) return profileId;
  const errorCode = requiredString(envelope.type, record.payload, "error_code");
  if (!errorCode.ok) return errorCode;
  const message = requiredString(envelope.type, record.payload, "message");
  if (!message.ok) return message;
  const expectedRevision = record.payload.expected_revision;
  if (
    expectedRevision !== undefined
    && (typeof expectedRevision !== "number" || !Number.isFinite(expectedRevision))
  ) {
    return invalidPayload(envelope.type, "payload.expected_revision", "finite number | undefined");
  }
  return {
    ok: true,
    payload: {
      request_id: requestId.payload,
      model_name: modelName.payload,
      profile_id: profileId.payload,
      expected_revision: expectedRevision,
      error_code: errorCode.payload,
      message: message.payload,
    },
  };
}

export function parseHistoryListPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<SystemHistoryListPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const histories = record.payload.histories;
  if (!Array.isArray(histories)) {
    return invalidPayload(envelope.type, "payload.histories", "array");
  }
  return { ok: true, payload: { histories } };
}

export function parseHistoryCreatedPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<SystemHistoryCreatedPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const historyUid = requiredString(envelope.type, record.payload, "history_uid");
  return historyUid.ok
    ? { ok: true, payload: { history_uid: historyUid.payload } }
    : historyUid;
}

export function parseHistoryDataPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<SystemHistoryDataPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const messages = record.payload.messages;
  if (!Array.isArray(messages)) {
    return invalidPayload(envelope.type, "payload.messages", "array");
  }
  return { ok: true, payload: { messages } };
}

export function parseHistoryDeletedPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<SystemHistoryDeletedPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const historyUid = requiredString(envelope.type, record.payload, "history_uid");
  if (!historyUid.ok) return historyUid;
  const success = requiredBoolean(envelope.type, record.payload, "success");
  if (!success.ok) return success;
  return {
    ok: true,
    payload: {
      history_uid: historyUid.payload,
      success: success.payload,
    },
  };
}
