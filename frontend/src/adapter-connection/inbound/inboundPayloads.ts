import type {
  ControlErrorPayload,
  ControlTurnFinishedPayload,
  OutputAudioPayload,
  OutputImagePayload,
  OutputTextPayload,
  OutputTranscriptionPayload,
  ProtocolEnvelope,
  SystemHistoryCreatedPayload,
  SystemHistoryDataPayload,
  SystemHistoryDeletedPayload,
  SystemHistoryListPayload,
  SystemSemanticAxisProfileSavedPayload,
  SystemSemanticAxisProfileSaveFailedPayload,
  SystemModelSyncPayload,
  SystemMotionTuningSamplesStatePayload,
  SystemServerInfoPayload,
} from "../../types/protocol.js";

export interface PayloadParseError {
  code: "invalid_payload";
  message: string;
  path: string;
}

export type PayloadParseResult<TPayload> =
  | { ok: true; payload: TPayload }
  | { ok: false; error: PayloadParseError };

function invalidPayload(type: string, path: string, expected: string): PayloadParseResult<never> {
  return {
    ok: false,
    error: {
      code: "invalid_payload",
      path,
      message: `收到非法协议载荷（type=${type}, path=${path}, expected=${expected}）。`,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(
  type: string,
  record: Record<string, unknown>,
  key: string,
): PayloadParseResult<string> {
  const value = record[key];
  if (typeof value !== "string") {
    return invalidPayload(type, `payload.${key}`, "string");
  }
  return { ok: true, payload: value };
}

function optionalString(
  value: unknown,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredBoolean(
  type: string,
  record: Record<string, unknown>,
  key: string,
): PayloadParseResult<boolean> {
  const value = record[key];
  if (typeof value !== "boolean") {
    return invalidPayload(type, `payload.${key}`, "boolean");
  }
  return { ok: true, payload: value };
}

function requiredNumber(
  type: string,
  record: Record<string, unknown>,
  key: string,
): PayloadParseResult<number> {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalidPayload(type, `payload.${key}`, "finite number");
  }
  return { ok: true, payload: value };
}

function parseObjectPayload<TPayload>(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<Record<string, unknown>> {
  const record = asRecord(envelope.payload);
  if (!record) {
    return invalidPayload(envelope.type, "payload", "object");
  }
  return { ok: true, payload: record };
}

export function parseOutputTextPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<OutputTextPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const text = requiredString(envelope.type, record.payload, "text");
  if (!text.ok) return text;
  return {
    ok: true,
    payload: {
      text: text.payload,
      speaker_name: optionalString(record.payload.speaker_name) ?? "",
      avatar: optionalString(record.payload.avatar) ?? "",
    },
  };
}

export function parseOutputAudioPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<OutputAudioPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const text = requiredString(envelope.type, record.payload, "text");
  if (!text.ok) return text;
  const audioUrl = record.payload.audio_url;
  if (audioUrl !== null && typeof audioUrl !== "string") {
    return invalidPayload(envelope.type, "payload.audio_url", "string | null");
  }
  return {
    ok: true,
    payload: {
      text: text.payload,
      audio_url: audioUrl,
      speaker_name: optionalString(record.payload.speaker_name) ?? "",
      avatar: optionalString(record.payload.avatar) ?? "",
    },
  };
}

export function parseOutputImagePayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<OutputImagePayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;
  const images = record.payload.images;
  if (!Array.isArray(images) || !images.every((item) => typeof item === "string")) {
    return invalidPayload(envelope.type, "payload.images", "string[]");
  }
  return { ok: true, payload: { images } };
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
  return {
    ok: true,
    payload: {
      ws_url: wsUrl.payload,
      http_base_url: httpBaseUrl.payload,
      auto_start_mic: autoStartMic.payload,
    },
  };
}

export function parseSystemModelSyncPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<SystemModelSyncPayload> {
  const record = parseObjectPayload(envelope);
  if (!record.ok) return record;

  const confName = requiredString(envelope.type, record.payload, "conf_name");
  if (!confName.ok) return confName;
  const confUid = requiredString(envelope.type, record.payload, "conf_uid");
  if (!confUid.ok) return confUid;
  const clientUid = requiredString(envelope.type, record.payload, "client_uid");
  if (!clientUid.ok) return clientUid;

  const modelInfoRecord = asRecord(record.payload.model_info);
  if (!modelInfoRecord) {
    return invalidPayload(envelope.type, "payload.model_info", "object");
  }

  // Parse model_info.selected_model (required string)
  const selectedModel = requiredString(envelope.type, modelInfoRecord, "selected_model");
  if (!selectedModel.ok) return selectedModel;

  // Parse model_info.models (required non-empty array of ModelSummary-like objects)
  const modelsRaw = modelInfoRecord.models;
  if (!Array.isArray(modelsRaw) || modelsRaw.length < 1) {
    return invalidPayload(envelope.type, "payload.model_info.models", "non-empty array");
  }
  const models: SystemModelSyncPayload["model_info"]["models"] = [];
  for (const item of modelsRaw) {
    const parsed = parseModelSummarySnapshot(envelope.type, item);
    if (!parsed.ok) return parsed;
    models.push(parsed.payload);
  }

  // Parse runtime_cache_errors (optional object, not deep-validated per-field)
  const runtimeCacheErrors = parseRuntimeCacheErrorsPayload(envelope.type, record.payload.runtime_cache_errors);

  return {
    ok: true,
    payload: {
      model_info: {
        schema_version: "",
        driver_priority: [],
        selected_model: selectedModel.payload,
        models,
        available_models: [],
        runtime_cache_errors: runtimeCacheErrors,
      },
      runtime_cache_errors: runtimeCacheErrors,
      conf_name: confName.payload,
      conf_uid: confUid.payload,
      client_uid: clientUid.payload,
    },
  };
}

function parseModelSummarySnapshot(
  type: string,
  value: unknown,
): PayloadParseResult<SystemModelSyncPayload["model_info"]["models"][number]> {
  const record = asRecord(value);
  if (!record) {
    return invalidPayload(type, "payload.model_info.models[]", "object");
  }
  const name = requiredString(type, record, "name");
  if (!name.ok) return name;
  return {
    ok: true,
    payload: {
      name: name.payload,
      root_path: optionalString(record.root_path) ?? "",
      model_path: optionalString(record.model_path) ?? "",
      model_url: optionalString(record.model_url) ?? "",
      icon_url: optionalString(record.icon_url) ?? "",
      resource_scan: asRecord(record.resource_scan) ?? undefined as never,
      parameter_scan: asRecord(record.parameter_scan) ?? undefined as never,
      expression_scan: asRecord(record.expression_scan) ?? undefined as never,
      base_action_library: asRecord(record.base_action_library) ?? undefined as never,
      parameter_action_library: asRecord(record.parameter_action_library) ?? undefined as never,
      motion_resource_pool: asRecord(record.motion_resource_pool) ?? undefined as never,
      constraints: { expressions: [], motions: [] },
      semantic_axis_profile: parseSemanticAxisProfileSnapshot(record.semantic_axis_profile),
      calibration_profile: asRecord(record.calibration_profile) ?? null,
      voice_following_profile: asRecord(record.voice_following_profile) ?? null,
      engine_hints: {
        driver_priority: [],
        recommended_mode: "idle",
        available_channels: [],
        base_expression_count: 0,
        fallback_motion_count: 0,
        motion_decomposition_level: "none",
      },
    } as unknown as SystemModelSyncPayload["model_info"]["models"][number],
  };
}

function parseSemanticAxisProfileSnapshot(
  value: unknown,
): SystemModelSyncPayload["model_info"]["models"][number]["semantic_axis_profile"] {
  const record = asRecord(value);
  if (!record) return null;
  const profileId = record.profile_id;
  if (typeof profileId !== "string") return null;
  const revision = record.revision;
  if (typeof revision !== "number" || !Number.isFinite(revision)) return null;
  const axes = record.axes;
  if (!Array.isArray(axes)) return null;
  // 浅校验 axes 至少包含 id 字段即可接受，深层语义校验由 feature 层负责
  for (const axis of axes) {
    const axisRecord = asRecord(axis);
    if (!axisRecord || typeof axisRecord.id !== "string") return null;
  }
  return value as SystemModelSyncPayload["model_info"]["models"][number]["semantic_axis_profile"];
}

function parseRuntimeCacheErrorsPayload(
  type: string,
  value: unknown,
): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === "string") {
      result[key] = val;
    }
    // 非 string 字段直接丢弃，不整体 reject
  }
  return Object.keys(result).length > 0 ? result : undefined;
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
