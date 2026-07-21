import type {
  ExpressionConstraint,
  ExpressionScanPayload,
  ModelSummary,
  MotionConstraint,
  ParameterActionLibrary,
  ParameterScanPayload,
  ProtocolEnvelope,
  ResourceScanPayload,
  RuntimeCacheErrorsPayload,
  SystemModelSyncPayload,
  VoiceFollowingProfile,
} from "../../types/protocol.js";
import type {
  SemanticAxisProfile,
  SemanticAxisRelationRule,
} from "../../types/semantic-axis-profile.js";
import {
  SCHEMA_MODEL_INFO_V2,
  SCHEMA_SEMANTIC_AXIS_PROFILE_V2,
  SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1,
  SCHEMA_VOICE_FOLLOWING_PROFILE_V3,
} from "../../types/protocolSchema.generated.js";
import {
  asRecord,
  invalidPayload,
  type PayloadParseResult,
  validateExactKeys,
} from "./payloadValidation.js";

const PARAMETER_ACTION_LIBRARY_SCHEMA_VERSION = "parameter_action_library.v1";

type FieldKind = "string" | "number" | "boolean" | "array" | "record";

export function parseSystemModelSyncPayload(
  envelope: ProtocolEnvelope<unknown>,
): PayloadParseResult<SystemModelSyncPayload> {
  const root = asRecord(envelope.payload);
  if (!root) {
    return invalidPayload(envelope.type, "payload", "object");
  }
  const rootKeys = validateExactKeys(
    envelope.type,
    "payload",
    root,
    ["model_info", "runtime_cache_errors", "conf_name", "conf_uid", "client_uid"],
  );
  if (!rootKeys.ok) return rootKeys;

  const confName = parseNonEmptyString(envelope.type, root.conf_name, "payload.conf_name");
  if (!confName.ok) return confName;
  const confUid = parseNonEmptyString(envelope.type, root.conf_uid, "payload.conf_uid");
  if (!confUid.ok) return confUid;
  const clientUid = parseNonEmptyString(envelope.type, root.client_uid, "payload.client_uid");
  if (!clientUid.ok) return clientUid;

  const modelInfoRecord = asRecord(root.model_info);
  if (!modelInfoRecord) {
    return invalidPayload(envelope.type, "payload.model_info", "object");
  }
  const modelInfoKeys = validateExactKeys(
    envelope.type,
    "payload.model_info",
    modelInfoRecord,
    [
      "schema_version",
      "driver_priority",
      "selected_model",
      "available_models",
      "models",
    ],
  );
  if (!modelInfoKeys.ok) return modelInfoKeys;
  if (modelInfoRecord.schema_version !== SCHEMA_MODEL_INFO_V2) {
    return invalidPayload(
      envelope.type,
      "payload.model_info.schema_version",
      SCHEMA_MODEL_INFO_V2,
    );
  }

  const selectedModel = parseNonEmptyString(
    envelope.type,
    modelInfoRecord.selected_model,
    "payload.model_info.selected_model",
  );
  if (!selectedModel.ok) return selectedModel;
  const driverPriority = parseStringArray(
    envelope.type,
    modelInfoRecord.driver_priority,
    "payload.model_info.driver_priority",
  );
  if (!driverPriority.ok) return driverPriority;
  const availableModels = parseStringArray(
    envelope.type,
    modelInfoRecord.available_models,
    "payload.model_info.available_models",
  );
  if (!availableModels.ok) return availableModels;

  if (!Array.isArray(modelInfoRecord.models) || modelInfoRecord.models.length === 0) {
    return invalidPayload(
      envelope.type,
      "payload.model_info.models",
      "non-empty model array",
    );
  }
  const models: ModelSummary[] = [];
  const modelNames = new Set<string>();
  for (const [index, value] of modelInfoRecord.models.entries()) {
    const parsed = parseModelSummary(
      envelope.type,
      value,
      `payload.model_info.models[${index}]`,
    );
    if (!parsed.ok) return parsed;
    if (modelNames.has(parsed.payload.name)) {
      return invalidPayload(
        envelope.type,
        `payload.model_info.models[${index}].name`,
        "unique model name",
      );
    }
    modelNames.add(parsed.payload.name);
    models.push(parsed.payload);
  }

  if (!modelNames.has(selectedModel.payload)) {
    return invalidPayload(
      envelope.type,
      "payload.model_info.selected_model",
      "name present in payload.model_info.models",
    );
  }
  if (
    availableModels.payload.length !== models.length
    || availableModels.payload.some((name, index) => name !== models[index].name)
  ) {
    return invalidPayload(
      envelope.type,
      "payload.model_info.available_models",
      "ordered names matching payload.model_info.models",
    );
  }

  const rootErrors = parseRuntimeCacheErrors(
    envelope.type,
    root.runtime_cache_errors,
    "payload.runtime_cache_errors",
  );
  if (!rootErrors.ok) return rootErrors;
  const runtimeCacheErrors = rootErrors.payload;
  return {
    ok: true,
    payload: {
      model_info: {
        schema_version: SCHEMA_MODEL_INFO_V2,
        driver_priority: driverPriority.payload,
        selected_model: selectedModel.payload,
        available_models: availableModels.payload,
        models,
      },
      runtime_cache_errors: runtimeCacheErrors,
      conf_name: confName.payload,
      conf_uid: confUid.payload,
      client_uid: clientUid.payload,
    },
  };
}

function parseModelSummary(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<ModelSummary> {
  const record = asRecord(value);
  if (!record) return invalidPayload(type, path, "object");
  const modelKeys = validateExactKeys(type, path, record, [
    "name",
    "root_path",
    "model_path",
    "model_url",
    "icon_url",
    "resource_scan",
    "parameter_scan",
    "expression_scan",
    "parameter_action_library",
    "constraints",
    "semantic_axis_profile",
    "voice_following_profile",
    "engine_hints",
  ]);
  if (!modelKeys.ok) return modelKeys;

  const strings: Record<string, string> = {};
  for (const key of ["name", "root_path", "model_path", "model_url", "icon_url"] as const) {
    const parsed = key === "icon_url"
      ? parseString(type, record[key], `${path}.${key}`)
      : parseNonEmptyString(type, record[key], `${path}.${key}`);
    if (!parsed.ok) return parsed;
    strings[key] = parsed.payload;
  }
  if (!isHttpUrl(strings.model_url)) {
    return invalidPayload(type, `${path}.model_url`, "absolute HTTP(S) URL");
  }
  if (strings.icon_url && !isHttpUrl(strings.icon_url)) {
    return invalidPayload(type, `${path}.icon_url`, "empty string or absolute HTTP(S) URL");
  }

  const resourceScan = parseResourceScan(type, record.resource_scan, `${path}.resource_scan`);
  if (!resourceScan.ok) return resourceScan;
  const parameterScan = parseParameterScan(type, record.parameter_scan, `${path}.parameter_scan`);
  if (!parameterScan.ok) return parameterScan;
  const expressionScan = parseExpressionScan(type, record.expression_scan, `${path}.expression_scan`);
  if (!expressionScan.ok) return expressionScan;
  const parameterActionLibrary = parseVersionedLibrary<ParameterActionLibrary>(
    type,
    record.parameter_action_library,
    `${path}.parameter_action_library`,
    PARAMETER_ACTION_LIBRARY_SCHEMA_VERSION,
    ["analysis", "summary"],
    ["domains", "channels", "parameters", "atoms"],
  );
  if (!parameterActionLibrary.ok) return parameterActionLibrary;
  const constraints = parseModelConstraints(type, record.constraints, `${path}.constraints`);
  if (!constraints.ok) return constraints;

  const engineHints = asRecord(record.engine_hints);
  if (!engineHints) return invalidPayload(type, `${path}.engine_hints`, "object");
  const engineShape = validateFields(type, engineHints, `${path}.engine_hints`, {
    driver_priority: "array",
    recommended_mode: "string",
    available_channels: "array",
    base_expression_count: "number",
    fallback_motion_count: "number",
    motion_decomposition_level: "string",
  });
  if (!engineShape.ok) return engineShape;
  for (const key of ["driver_priority", "available_channels"] as const) {
    const parsed = parseStringArray(type, engineHints[key], `${path}.engine_hints.${key}`);
    if (!parsed.ok) return parsed;
  }

  const semanticProfile = parseOptionalSemanticAxisProfile(
    type,
    record.semantic_axis_profile,
    `${path}.semantic_axis_profile`,
  );
  if (!semanticProfile.ok) return semanticProfile;
  if (semanticProfile.payload && semanticProfile.payload.model_id !== strings.name) {
    return invalidPayload(
      type,
      `${path}.semantic_axis_profile.model_id`,
      `selected model id ${strings.name}`,
    );
  }

  const voiceProfile = parseOptionalVoiceFollowingProfile(
    type,
    record.voice_following_profile,
    `${path}.voice_following_profile`,
  );
  if (!voiceProfile.ok) return voiceProfile;
  if (voiceProfile.payload && voiceProfile.payload.model_id !== strings.name) {
    return invalidPayload(
      type,
      `${path}.voice_following_profile.model_id`,
      `selected model id ${strings.name}`,
    );
  }

  return {
    ok: true,
    payload: {
      name: strings.name,
      root_path: strings.root_path,
      model_path: strings.model_path,
      model_url: strings.model_url,
      icon_url: strings.icon_url,
      resource_scan: resourceScan.payload,
      parameter_scan: parameterScan.payload,
      expression_scan: expressionScan.payload,
      parameter_action_library: parameterActionLibrary.payload,
      constraints: constraints.payload,
      semantic_axis_profile: semanticProfile.payload,
      voice_following_profile: voiceProfile.payload,
      engine_hints: {
        driver_priority: engineHints.driver_priority as string[],
        recommended_mode: engineHints.recommended_mode as string,
        available_channels: engineHints.available_channels as string[],
        base_expression_count: engineHints.base_expression_count as number,
        fallback_motion_count: engineHints.fallback_motion_count as number,
        motion_decomposition_level: engineHints.motion_decomposition_level as string,
      },
    },
  };
}

function parseResourceScan(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<ResourceScanPayload> {
  const record = asRecord(value);
  if (!record) return invalidPayload(type, path, "object");
  const shape = validateFields(type, record, path, {
    model3_file: "string",
    cdi3_file: "string",
    physics3_file: "string",
    texture_count: "number",
    texture_files: "array",
    expression_count: "number",
    expression_files: "array",
    motion_count: "number",
    motion_files: "array",
    motion_groups: "array",
    vtube_profile_count: "number",
    vtube_profiles: "array",
    has_motion_catalog: "boolean",
  });
  if (!shape.ok) return shape;
  for (const key of ["texture_files", "expression_files", "motion_files", "vtube_profiles"] as const) {
    const parsed = parseStringArray(type, record[key], `${path}.${key}`);
    if (!parsed.ok) return parsed;
  }
  return { ok: true, payload: record as unknown as ResourceScanPayload };
}

function parseParameterScan(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<ParameterScanPayload> {
  const record = asRecord(value);
  if (!record) return invalidPayload(type, path, "object");
  const shape = validateFields(type, record, path, {
    source: "string",
    total_parameters: "number",
    drivable_parameters: "number",
    physics_parameters: "number",
    expression_parameters: "number",
    groups: "array",
    domain_counts: "array",
    standard_channels: "record",
    primary_parameters: "array",
    parameters: "array",
  });
  return shape.ok
    ? { ok: true, payload: record as unknown as ParameterScanPayload }
    : shape;
}

function parseExpressionScan(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<ExpressionScanPayload> {
  const record = asRecord(value);
  if (!record) return invalidPayload(type, path, "object");
  const shape = validateFields(type, record, path, {
    total_expressions: "number",
    category_counts: "array",
    blend_counts: "array",
    domain_usage: "array",
    channel_usage: "array",
    base_expression_names: "array",
    special_state_names: "array",
    expression_driven_parameters: "array",
  });
  return shape.ok
    ? { ok: true, payload: record as unknown as ExpressionScanPayload }
    : shape;
}

function parseVersionedLibrary<TLibrary>(
  type: string,
  value: unknown,
  path: string,
  schemaVersion: string,
  recordKeys: string[],
  arrayKeys: string[],
): PayloadParseResult<TLibrary> {
  const record = asRecord(value);
  if (!record) return invalidPayload(type, path, "object");
  if (record.schema_version !== schemaVersion) {
    return invalidPayload(type, `${path}.schema_version`, schemaVersion);
  }
  const fields: Record<string, FieldKind> = {
    extraction_mode: "string",
  };
  for (const key of recordKeys) fields[key] = "record";
  for (const key of arrayKeys) fields[key] = "array";
  const shape = validateFields(type, record, path, fields);
  return shape.ok ? { ok: true, payload: record as TLibrary } : shape;
}

function parseModelConstraints(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<ModelSummary["constraints"]> {
  const constraints = asRecord(value);
  if (!constraints) return invalidPayload(type, path, "object");
  const constraintKeys = validateExactKeys(
    type,
    path,
    constraints,
    ["expressions", "motions"],
  );
  if (!constraintKeys.ok) return constraintKeys;
  if (!Array.isArray(constraints.expressions)) {
    return invalidPayload(type, `${path}.expressions`, "array");
  }
  if (!Array.isArray(constraints.motions)) {
    return invalidPayload(type, `${path}.motions`, "array");
  }
  const expressions: ExpressionConstraint[] = [];
  for (const [index, item] of constraints.expressions.entries()) {
    const parsed = parseExpressionConstraint(type, item, `${path}.expressions[${index}]`);
    if (!parsed.ok) return parsed;
    expressions.push(parsed.payload);
  }
  const motions: MotionConstraint[] = [];
  for (const [index, item] of constraints.motions.entries()) {
    const parsed = parseMotionConstraint(type, item, `${path}.motions[${index}]`);
    if (!parsed.ok) return parsed;
    motions.push(parsed.payload);
  }
  return { ok: true, payload: { expressions, motions } };
}

function parseExpressionConstraint(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<ExpressionConstraint> {
  const item = asRecord(value);
  if (!item) return invalidPayload(type, path, "object");
  const keys = validateExactKeys(type, path, item, [
    "name",
    "file",
    "catalog_id",
    "catalog_expose_as_resource",
    "parameter_ids",
  ]);
  if (!keys.ok) return keys;
  const shape = validateFields(type, item, path, {
    name: "string",
    file: "string",
    catalog_id: "string",
    catalog_expose_as_resource: "boolean",
    parameter_ids: "array",
  });
  if (!shape.ok) return shape;
  const parameterIds = parseStringArray(type, item.parameter_ids, `${path}.parameter_ids`);
  if (!parameterIds.ok) return parameterIds;
  return { ok: true, payload: item as unknown as ExpressionConstraint };
}

function parseMotionConstraint(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<MotionConstraint> {
  const item = asRecord(value);
  if (!item) return invalidPayload(type, path, "object");
  const keys = validateExactKeys(type, path, item, [
    "name",
    "file",
    "catalog_id",
    "catalog_expose_as_resource",
    "group",
    "duration",
    "parameter_ids",
    "catalog_label",
    "catalog_intensity",
  ]);
  if (!keys.ok) return keys;
  const shape = validateFields(type, item, path, {
    name: "string",
    file: "string",
    catalog_id: "string",
    catalog_expose_as_resource: "boolean",
    group: "string",
    duration: "number",
    parameter_ids: "array",
    catalog_label: "string",
    catalog_intensity: "string",
  });
  if (!shape.ok) return shape;
  const parameterIds = parseStringArray(type, item.parameter_ids, `${path}.parameter_ids`);
  if (!parameterIds.ok) return parameterIds;
  return { ok: true, payload: item as unknown as MotionConstraint };
}

function parseOptionalSemanticAxisProfile(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<SemanticAxisProfile | null> {
  if (value === undefined || value === null) return { ok: true, payload: null };
  const record = asRecord(value);
  if (!record) return invalidPayload(type, path, "object | null");
  if (record.schema_version !== SCHEMA_SEMANTIC_AXIS_PROFILE_V2) {
    return invalidPayload(type, `${path}.schema_version`, SCHEMA_SEMANTIC_AXIS_PROFILE_V2);
  }
  const shape = validateFields(type, record, path, {
    profile_id: "string",
    model_id: "string",
    source_hash: "string",
    last_scanned_hash: "string",
    revision: "number",
    status: "string",
    user_modified: "boolean",
    generated_at: "string",
    updated_at: "string",
    axes: "array",
    couplings: "array",
    relation_graph: "record",
  });
  if (!shape.ok) return shape;
  if (!Number.isInteger(record.revision) || Number(record.revision) <= 0) {
    return invalidPayload(type, `${path}.revision`, "positive integer");
  }
  if (!["generated", "user_modified", "stale"].includes(String(record.status))) {
    return invalidPayload(type, `${path}.status`, "known profile status");
  }

  for (const [index, axis] of (record.axes as unknown[]).entries()) {
    const parsed = validateSemanticAxis(type, axis, `${path}.axes[${index}]`);
    if (!parsed.ok) return parsed;
  }
  for (const [index, coupling] of (record.couplings as unknown[]).entries()) {
    const parsed = validateRelationRule(type, coupling, `${path}.couplings[${index}]`, false);
    if (!parsed.ok) return parsed;
  }

  const relationGraph = record.relation_graph as Record<string, unknown>;
  if (relationGraph.schema_version !== SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1) {
    return invalidPayload(
      type,
      `${path}.relation_graph.schema_version`,
      SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1,
    );
  }
  if (!Array.isArray(relationGraph.edges)) {
    return invalidPayload(type, `${path}.relation_graph.edges`, "array");
  }
  for (const [index, edge] of relationGraph.edges.entries()) {
    const parsed = validateRelationRule(
      type,
      edge,
      `${path}.relation_graph.edges[${index}]`,
      true,
    );
    if (!parsed.ok) return parsed;
  }
  return { ok: true, payload: record as unknown as SemanticAxisProfile };
}

function validateSemanticAxis(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<null> {
  const axis = asRecord(value);
  if (!axis) return invalidPayload(type, path, "object");
  const shape = validateFields(type, axis, path, {
    id: "string",
    label: "string",
    description: "string",
    semantic_group: "string",
    control_role: "string",
    neutral: "number",
    value_range: "array",
    soft_range: "array",
    strong_range: "array",
    extreme_range: "array",
    positive_semantics: "array",
    negative_semantics: "array",
    usage_notes: "string",
    dynamics: "record",
    parameter_bindings: "array",
  });
  if (!shape.ok) return shape;
  for (const key of ["value_range", "soft_range", "strong_range", "extreme_range"] as const) {
    const range = parseFiniteRange(type, axis[key], `${path}.${key}`);
    if (!range.ok) return range;
  }
  for (const key of ["positive_semantics", "negative_semantics"] as const) {
    const strings = parseStringArray(type, axis[key], `${path}.${key}`);
    if (!strings.ok) return strings;
  }
  if (axis.level_anchors !== undefined) {
    const anchors = asRecord(axis.level_anchors);
    if (!anchors || Object.values(anchors).some((item) => !isFiniteNumber(item))) {
      return invalidPayload(type, `${path}.level_anchors`, "finite number record");
    }
  }
  const dynamics = axis.dynamics as Record<string, unknown>;
  const dynamicsShape = validateFields(type, dynamics, `${path}.dynamics`, {
    max_velocity: "number",
    max_acceleration: "number",
    max_speech_offset_ratio: "number",
  });
  if (!dynamicsShape.ok) return dynamicsShape;
  for (const [index, value] of (axis.parameter_bindings as unknown[]).entries()) {
    const binding = asRecord(value);
    const bindingPath = `${path}.parameter_bindings[${index}]`;
    if (!binding) return invalidPayload(type, bindingPath, "object");
    const bindingShape = validateFields(type, binding, bindingPath, {
      parameter_id: "string",
      input_range: "array",
      output_range: "array",
      default_weight: "number",
      invert: "boolean",
    });
    if (!bindingShape.ok) return bindingShape;
    for (const key of ["input_range", "output_range"] as const) {
      const range = parseFiniteRange(type, binding[key], `${bindingPath}.${key}`);
      if (!range.ok) return range;
    }
    if (binding.parameter_name !== undefined && typeof binding.parameter_name !== "string") {
      return invalidPayload(type, `${bindingPath}.parameter_name`, "string | undefined");
    }
  }
  return { ok: true, payload: null };
}

function validateRelationRule(
  type: string,
  value: unknown,
  path: string,
  requireKind: boolean,
): PayloadParseResult<SemanticAxisRelationRule | null> {
  const rule = asRecord(value);
  if (!rule) return invalidPayload(type, path, "object");
  const fields: Record<string, FieldKind> = {
    id: "string",
    source_axis_id: "string",
    target_axis_id: "string",
    mode: "string",
    scale: "number",
    deadzone: "number",
    max_delta: "number",
  };
  if (requireKind) fields.kind = "string";
  const shape = validateFields(type, rule, path, fields);
  if (!shape.ok) return shape;
  if (!["same_direction", "opposite_direction"].includes(String(rule.mode))) {
    return invalidPayload(type, `${path}.mode`, "known relation mode");
  }
  if (requireKind && !["derive", "bounded_ratio"].includes(String(rule.kind))) {
    return invalidPayload(type, `${path}.kind`, "known relation kind");
  }
  return {
    ok: true,
    payload: requireKind ? rule as unknown as SemanticAxisRelationRule : null,
  };
}

function parseOptionalVoiceFollowingProfile(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<VoiceFollowingProfile | null> {
  if (value === undefined || value === null) return { ok: true, payload: null };
  const record = asRecord(value);
  if (!record) return invalidPayload(type, path, "object | null");
  if (record.schema_version !== SCHEMA_VOICE_FOLLOWING_PROFILE_V3) {
    return invalidPayload(type, `${path}.schema_version`, SCHEMA_VOICE_FOLLOWING_PROFILE_V3);
  }
  const shape = validateFields(type, record, path, {
    model_id: "string",
    revision: "number",
    channels: "record",
  });
  if (!shape.ok) return shape;
  if (!Number.isInteger(record.revision) || Number(record.revision) <= 0) {
    return invalidPayload(type, `${path}.revision`, "positive integer");
  }
  const channels = record.channels as Record<string, unknown>;
  for (const [channelId, value] of Object.entries(channels)) {
    const channelPath = `${path}.channels.${channelId}`;
    const channel = asRecord(value);
    if (!channel) return invalidPayload(type, channelPath, "object");
    const channelShape = validateFields(type, channel, channelPath, {
      channel: "string",
      semantic_axis_id: "string",
      layer: "string",
      amplitude_ratio: "number",
      follow_delay_ms: "number",
    });
    if (!channelShape.ok) return channelShape;
    if (channel.channel !== channelId) {
      return invalidPayload(type, `${channelPath}.channel`, `matching channel id ${channelId}`);
    }
    if (typeof channel.semantic_axis_id !== "string" || !channel.semantic_axis_id.trim()) {
      return invalidPayload(type, `${channelPath}.semantic_axis_id`, "non-empty string");
    }
    if (Number(channel.amplitude_ratio) <= 0 || Number(channel.amplitude_ratio) > 1) {
      return invalidPayload(type, `${channelPath}.amplitude_ratio`, "number in (0, 1]");
    }
    if (!Number.isInteger(channel.follow_delay_ms) || Number(channel.follow_delay_ms) < 0) {
      return invalidPayload(type, `${channelPath}.follow_delay_ms`, "non-negative integer");
    }
  }
  if (record.summary !== undefined) {
    const summary = asRecord(record.summary);
    if (!summary) return invalidPayload(type, `${path}.summary`, "object | undefined");
    if (summary.channel_count !== undefined && !isFiniteNumber(summary.channel_count)) {
      return invalidPayload(type, `${path}.summary.channel_count`, "finite number | undefined");
    }
    if (summary.available_channels !== undefined) {
      const available = parseStringArray(
        type,
        summary.available_channels,
        `${path}.summary.available_channels`,
      );
      if (!available.ok) return available;
    }
  }
  return { ok: true, payload: record as unknown as VoiceFollowingProfile };
}

function parseRuntimeCacheErrors(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<RuntimeCacheErrorsPayload> {
  const record = asRecord(value);
  if (!record) return invalidPayload(type, path, "object");
  const allowedKeys = new Set(["root", "scan_cache", "action_filter_cache", "motion_tuning_samples"]);
  const result: RuntimeCacheErrorsPayload = {};
  for (const [key, item] of Object.entries(record)) {
    if (!allowedKeys.has(key)) {
      return invalidPayload(type, `${path}.${key}`, "declared runtime cache error field");
    }
    if (typeof item !== "string") {
      return invalidPayload(type, `${path}.${key}`, "string");
    }
    result[key as keyof RuntimeCacheErrorsPayload] = item;
  }
  return { ok: true, payload: result };
}

function validateFields(
  type: string,
  record: Record<string, unknown>,
  path: string,
  fields: Record<string, FieldKind>,
): PayloadParseResult<null> {
  for (const [key, kind] of Object.entries(fields)) {
    const value = record[key];
    const valid = kind === "string"
      ? typeof value === "string"
      : kind === "number"
        ? isFiniteNumber(value)
        : kind === "boolean"
          ? typeof value === "boolean"
          : kind === "array"
            ? Array.isArray(value)
            : asRecord(value) !== null;
    if (!valid) return invalidPayload(type, `${path}.${key}`, kind);
  }
  return { ok: true, payload: null };
}

function parseString(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<string> {
  return typeof value === "string"
    ? { ok: true, payload: value }
    : invalidPayload(type, path, "string");
}

function parseNonEmptyString(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<string> {
  return typeof value === "string" && value.trim()
    ? { ok: true, payload: value.trim() }
    : invalidPayload(type, path, "non-empty string");
}

function parseStringArray(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<string[]> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return invalidPayload(type, path, "string[]");
  }
  return { ok: true, payload: [...value] as string[] };
}

function parseFiniteRange(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<[number, number]> {
  if (
    !Array.isArray(value)
    || value.length !== 2
    || !isFiniteNumber(value[0])
    || !isFiniteNumber(value[1])
    || value[0] > value[1]
  ) {
    return invalidPayload(type, path, "ordered finite [min, max]");
  }
  return { ok: true, payload: [value[0], value[1]] };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}
