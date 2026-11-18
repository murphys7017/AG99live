import { INTERACTION_ROLES } from "../../types/semantic-axis-profile.js";
import type {
  ExpressionConstraint,
  ModelSummary,
  MotionMaterialCatalog,
  MotionConstraint,
  ParameterActionLibrary,
  ParameterScanPayload,
  ProtocolEnvelope,
  RuntimeCacheErrorsPayload,
  SystemModelSyncPayload,
  VoiceFollowingProfile,
} from "../../types/protocol.js";
import { MOTION_MATERIAL_CATALOG_SCHEMA_VERSION } from "../../types/protocol.js";
import type {
  SemanticAxisProfile,
  SemanticAxisRelationRule,
} from "../../types/semantic-axis-profile.js";
import {
  SCHEMA_MODEL_INFO_V4,
  SCHEMA_PARAMETER_ACTION_LIBRARY_V2,
  SCHEMA_SEMANTIC_AXIS_PROFILE_V3,
  SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1,
  SCHEMA_VOICE_FOLLOWING_PROFILE_V3,
} from "../../types/protocolSchema.generated.js";
import {
  asRecord,
  invalidPayload,
  type PayloadParseResult,
  validateExactKeys,
} from "./payloadValidation.js";

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
    ["model_info", "runtime_cache_errors"],
  );
  if (!rootKeys.ok) return rootKeys;

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
      "selected_model",
      "available_models",
      "models",
    ],
  );
  if (!modelInfoKeys.ok) return modelInfoKeys;
  if (modelInfoRecord.schema_version !== SCHEMA_MODEL_INFO_V4) {
    return invalidPayload(
      envelope.type,
      "payload.model_info.schema_version",
      SCHEMA_MODEL_INFO_V4,
    );
  }

  const selectedModel = parseNonEmptyString(
    envelope.type,
    modelInfoRecord.selected_model,
    "payload.model_info.selected_model",
  );
  if (!selectedModel.ok) return selectedModel;
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
        schema_version: SCHEMA_MODEL_INFO_V4,
        selected_model: selectedModel.payload,
        available_models: availableModels.payload,
        models,
      },
      runtime_cache_errors: runtimeCacheErrors,
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
    "parameter_scan",
    "parameter_action_library",
    "motion_material_catalog",
    "constraints",
    "semantic_axis_profile",
    "voice_following_profile",
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

  const parameterScan = parseParameterScan(type, record.parameter_scan, `${path}.parameter_scan`);
  if (!parameterScan.ok) return parameterScan;
  const parameterActionLibrary = parseParameterActionLibrary(
    type,
    record.parameter_action_library,
    `${path}.parameter_action_library`,
  );
  if (!parameterActionLibrary.ok) return parameterActionLibrary;
  const motionMaterialCatalog = parseOptionalMotionMaterialCatalog(
    type,
    record.motion_material_catalog,
    `${path}.motion_material_catalog`,
  );
  if (!motionMaterialCatalog.ok) return motionMaterialCatalog;
  const constraints = parseModelConstraints(type, record.constraints, `${path}.constraints`);
  if (!constraints.ok) return constraints;

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
      parameter_scan: parameterScan.payload,
      parameter_action_library: parameterActionLibrary.payload,
      motion_material_catalog: motionMaterialCatalog.payload,
      constraints: constraints.payload,
      semantic_axis_profile: semanticProfile.payload,
      voice_following_profile: voiceProfile.payload,
    },
  };
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

function parseParameterActionLibrary(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<ParameterActionLibrary> {
  const record = asRecord(value);
  if (!record) return invalidPayload(type, path, "object");
  const libraryKeys = validateExactKeys(type, path, record, [
    "schema_version",
    "extraction_mode",
    "analysis",
    "summary",
    "domains",
    "channels",
    "parameters",
    "atoms",
  ]);
  if (!libraryKeys.ok) return libraryKeys;
  if (record.schema_version !== SCHEMA_PARAMETER_ACTION_LIBRARY_V2) {
    return invalidPayload(
      type,
      `${path}.schema_version`,
      SCHEMA_PARAMETER_ACTION_LIBRARY_V2,
    );
  }
  const extractionMode = parseNonEmptyString(
    type,
    record.extraction_mode,
    `${path}.extraction_mode`,
  );
  if (!extractionMode.ok) return extractionMode;

  const analysisRecord = asRecord(record.analysis);
  if (!analysisRecord) return invalidPayload(type, `${path}.analysis`, "object");
  const status = parseNonEmptyString(
    type,
    analysisRecord.status,
    `${path}.analysis.status`,
  );
  if (!status.ok) return status;
  const mode = parseNonEmptyString(
    type,
    analysisRecord.mode,
    `${path}.analysis.mode`,
  );
  if (!mode.ok) return mode;
  let error: string | undefined;
  if (analysisRecord.error !== undefined) {
    const parsedError = parseString(type, analysisRecord.error, `${path}.analysis.error`);
    if (!parsedError.ok) return parsedError;
    error = parsedError.payload;
  }

  const summaryRecord = asRecord(record.summary);
  if (!summaryRecord) return invalidPayload(type, `${path}.summary`, "object");
  const summaryValues: Record<string, number> = {};
  for (const key of [
    "motion_count",
    "driver_component_count",
    "selected_atom_count",
    "selected_parameter_count",
  ] as const) {
    const parsed = parseNonNegativeInteger(
      type,
      summaryRecord[key],
      `${path}.summary.${key}`,
    );
    if (!parsed.ok) return parsed;
    summaryValues[key] = parsed.payload;
  }

  const domains = parseParameterActionCounters(type, record.domains, `${path}.domains`);
  if (!domains.ok) return domains;
  const channels = parseParameterActionCounters(type, record.channels, `${path}.channels`);
  if (!channels.ok) return channels;
  const parameters = parseParameterActionParameters(
    type,
    record.parameters,
    `${path}.parameters`,
  );
  if (!parameters.ok) return parameters;
  const atoms = parseParameterActionAtoms(type, record.atoms, `${path}.atoms`);
  if (!atoms.ok) return atoms;

  return {
    ok: true,
    payload: {
      schema_version: SCHEMA_PARAMETER_ACTION_LIBRARY_V2,
      extraction_mode: extractionMode.payload,
      analysis: {
        status: status.payload,
        mode: mode.payload,
        ...(error === undefined ? {} : { error }),
      },
      summary: {
        motion_count: summaryValues.motion_count,
        driver_component_count: summaryValues.driver_component_count,
        selected_atom_count: summaryValues.selected_atom_count,
        selected_parameter_count: summaryValues.selected_parameter_count,
      },
      domains: domains.payload,
      channels: channels.payload,
      parameters: parameters.payload,
      atoms: atoms.payload,
    },
  };
}

function parseParameterActionCounters(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<ParameterActionLibrary["domains"]> {
  if (!Array.isArray(value)) return invalidPayload(type, path, "array");
  const result: ParameterActionLibrary["domains"] = [];
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    const record = asRecord(item);
    if (!record) return invalidPayload(type, itemPath, "object");
    const name = parseNonEmptyString(type, record.name, `${itemPath}.name`);
    if (!name.ok) return name;
    const count = parseNonNegativeInteger(type, record.count, `${itemPath}.count`);
    if (!count.ok) return count;
    result.push({ name: name.payload, count: count.payload });
  }
  return { ok: true, payload: result };
}

function parseParameterActionParameters(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<ParameterActionLibrary["parameters"]> {
  if (!Array.isArray(value)) return invalidPayload(type, path, "array");
  const result: ParameterActionLibrary["parameters"] = [];
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    const record = asRecord(item);
    if (!record) return invalidPayload(type, itemPath, "object");
    const kind = parseNonEmptyString(type, record.kind, `${itemPath}.kind`);
    if (!kind.ok) return kind;
    const channels = parseStringArray(type, record.channels, `${itemPath}.channels`);
    if (!channels.ok) return channels;
    const selectedAtomCount = parseNonNegativeInteger(
      type,
      record.selected_atom_count,
      `${itemPath}.selected_atom_count`,
    );
    if (!selectedAtomCount.ok) return selectedAtomCount;
    result.push({
      kind: kind.payload,
      channels: channels.payload,
      selected_atom_count: selectedAtomCount.payload,
    });
  }
  return { ok: true, payload: result };
}

function parseParameterActionAtoms(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<ParameterActionLibrary["atoms"]> {
  if (!Array.isArray(value)) return invalidPayload(type, path, "array");
  const result: ParameterActionLibrary["atoms"] = [];
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    const record = asRecord(item);
    if (!record) return invalidPayload(type, itemPath, "object");
    const strings: Record<string, string> = {};
    for (const key of [
      "id",
      "name",
      "label",
      "parameter_id",
      "parameter_name",
      "kind",
      "domain",
      "primary_channel",
      "polarity",
      "semantic_polarity",
      "trait",
      "strength",
      "source_motion",
      "source_file",
      "source_group",
      "source_category",
      "intensity",
    ] as const) {
      const parsed = parseString(type, record[key], `${itemPath}.${key}`);
      if (!parsed.ok) return parsed;
      strings[key] = parsed.payload;
    }
    if (!strings.id.trim()) return invalidPayload(type, `${itemPath}.id`, "non-empty string");
    if (!strings.name.trim()) return invalidPayload(type, `${itemPath}.name`, "non-empty string");
    if (!strings.label.trim()) return invalidPayload(type, `${itemPath}.label`, "non-empty string");
    if (!strings.parameter_id.trim()) {
      return invalidPayload(type, `${itemPath}.parameter_id`, "non-empty string");
    }
    const channels = parseStringArray(type, record.channels, `${itemPath}.channels`);
    if (!channels.ok) return channels;
    const sourceTags = parseStringArray(type, record.source_tags, `${itemPath}.source_tags`);
    if (!sourceTags.ok) return sourceTags;
    const score = parseFiniteNumber(type, record.score, `${itemPath}.score`);
    if (!score.ok) return score;
    const duration = parseNonNegativeNumber(type, record.duration, `${itemPath}.duration`);
    if (!duration.ok) return duration;
    const fps = parseNonNegativeNumber(type, record.fps, `${itemPath}.fps`);
    if (!fps.ok) return fps;
    const loop = typeof record.loop === "boolean"
      ? { ok: true as const, payload: record.loop }
      : invalidPayload(type, `${itemPath}.loop`, "boolean");
    if (!loop.ok) return loop;
    const energyScore = parseFiniteNumber(type, record.energy_score, `${itemPath}.energy_score`);
    if (!energyScore.ok) return energyScore;
    result.push({
      id: strings.id,
      name: strings.name,
      label: strings.label,
      parameter_id: strings.parameter_id,
      parameter_name: strings.parameter_name,
      kind: strings.kind,
      domain: strings.domain,
      channels: channels.payload,
      primary_channel: strings.primary_channel,
      polarity: strings.polarity,
      semantic_polarity: strings.semantic_polarity,
      trait: strings.trait,
      strength: strings.strength,
      score: score.payload,
      source_motion: strings.source_motion,
      source_file: strings.source_file,
      source_group: strings.source_group,
      source_category: strings.source_category,
      source_tags: sourceTags.payload,
      duration: duration.payload,
      fps: fps.payload,
      loop: loop.payload,
      energy_score: energyScore.payload,
      intensity: strings.intensity,
    });
  }
  return { ok: true, payload: result };
}

function parseOptionalMotionMaterialCatalog(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<MotionMaterialCatalog | null> {
  if (value === undefined || value === null) {
    return { ok: true, payload: null };
  }
  return parseMotionMaterialCatalog(type, value, path);
}

function parseMotionMaterialCatalog(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<MotionMaterialCatalog> {
  const record = asRecord(value);
  if (!record) return invalidPayload(type, path, "object");
  const keys = validateExactKeys(type, path, record, [
    "schema_version",
    "model_id",
    "profile_id",
    "profile_revision",
    "source_hash",
    "summary",
    "fragments",
    "atoms",
    "diagnostics",
  ]);
  if (!keys.ok) return keys;
  const shape = validateFields(type, record, path, {
    schema_version: "string",
    model_id: "string",
    profile_id: "string",
    profile_revision: "number",
    source_hash: "string",
    summary: "record",
    fragments: "array",
    atoms: "array",
    diagnostics: "record",
  });
  if (!shape.ok) return shape;
  if (record.schema_version !== MOTION_MATERIAL_CATALOG_SCHEMA_VERSION) {
    return invalidPayload(
      type,
      `${path}.schema_version`,
      MOTION_MATERIAL_CATALOG_SCHEMA_VERSION,
    );
  }
  const revision = parseNonNegativeInteger(type, record.profile_revision, `${path}.profile_revision`);
  if (!revision.ok) return revision;
  const summary = parseMotionMaterialSummary(type, record.summary, `${path}.summary`);
  if (!summary.ok) return summary;
  const fragments = parseMotionMaterialRecords(
    type,
    record.fragments,
    `${path}.fragments`,
    [
      "id", "source_motion", "source_file", "duration_ms", "channels", "domains",
      "parameter_ids", "axis_ids", "component_ids", "intensity", "trait", "tags",
      "recommended_scenarios", "compatibility_groups", "status", "status_reasons",
    ],
    {
      id: "string", source_motion: "string", source_file: "string", duration_ms: "number",
      channels: "array", domains: "array", parameter_ids: "array", axis_ids: "array",
      component_ids: "array", intensity: "string", trait: "string", tags: "array",
      recommended_scenarios: "array", compatibility_groups: "array", status: "string",
      status_reasons: "array",
    },
    [
      "channels", "domains", "parameter_ids", "axis_ids", "component_ids", "tags",
      "recommended_scenarios", "compatibility_groups", "status_reasons",
    ],
  );
  if (!fragments.ok) return fragments;
  const atoms = parseMotionMaterialRecords(
    type,
    record.atoms,
    `${path}.atoms`,
    [
      "id", "parameter_id", "axis_ids", "primary_channel", "polarity", "semantic_polarity",
      "trait", "strength", "score", "duration_ms", "active_window", "source_fragment_id",
      "compatibility_groups", "status", "status_reasons",
    ],
    {
      id: "string", parameter_id: "string", axis_ids: "array", primary_channel: "string",
      polarity: "string", semantic_polarity: "string", trait: "string", strength: "string",
      score: "number", duration_ms: "number", active_window: "record",
      source_fragment_id: "string", compatibility_groups: "array", status: "string",
      status_reasons: "array",
    },
    ["axis_ids", "compatibility_groups", "status_reasons"],
  );
  if (!atoms.ok) return atoms;
  const diagnostics = parseMotionMaterialDiagnostics(type, record.diagnostics, `${path}.diagnostics`);
  if (!diagnostics.ok) return diagnostics;
  return { ok: true, payload: record as unknown as MotionMaterialCatalog };
}

function parseMotionMaterialSummary(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<null> {
  const record = asRecord(value);
  if (!record) return invalidPayload(type, path, "object");
  const keys = validateExactKeys(type, path, record, [
    "fragment_count", "atom_count", "ambient_fragment_count", "ambient_atom_count",
    "compatible_fragment_count", "compatible_atom_count", "status_counts", "reason_counts",
  ]);
  if (!keys.ok) return keys;
  const shape = validateFields(type, record, path, {
    fragment_count: "number", atom_count: "number", ambient_fragment_count: "number",
    ambient_atom_count: "number", compatible_fragment_count: "number",
    compatible_atom_count: "number", status_counts: "array", reason_counts: "array",
  });
  if (!shape.ok) return shape;
  for (const key of [
    "fragment_count", "atom_count", "ambient_fragment_count", "ambient_atom_count",
    "compatible_fragment_count", "compatible_atom_count",
  ] as const) {
    const count = parseNonNegativeInteger(type, record[key], `${path}.${key}`);
    if (!count.ok) return count;
  }
  const statusCounts = parseMotionMaterialCounters(type, record.status_counts, `${path}.status_counts`);
  if (!statusCounts.ok) return statusCounts;
  return parseMotionMaterialCounters(type, record.reason_counts, `${path}.reason_counts`);
}

function parseMotionMaterialDiagnostics(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<null> {
  const record = asRecord(value);
  if (!record) return invalidPayload(type, path, "object");
  const keys = validateExactKeys(type, path, record, ["profile_ready", "status_counts", "reason_counts"]);
  if (!keys.ok) return keys;
  const shape = validateFields(type, record, path, {
    profile_ready: "boolean", status_counts: "array", reason_counts: "array",
  });
  if (!shape.ok) return shape;
  const statusCounts = parseMotionMaterialCounters(type, record.status_counts, `${path}.status_counts`);
  if (!statusCounts.ok) return statusCounts;
  return parseMotionMaterialCounters(type, record.reason_counts, `${path}.reason_counts`);
}

function parseMotionMaterialRecords(
  type: string,
  value: unknown,
  path: string,
  fields: readonly string[],
  shape: Record<string, FieldKind>,
  stringArrayKeys: readonly string[],
): PayloadParseResult<Record<string, unknown>[]> {
  if (!Array.isArray(value)) return invalidPayload(type, path, "array");
  const result: Record<string, unknown>[] = [];
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    const record = asRecord(item);
    if (!record) return invalidPayload(type, itemPath, "object");
    const keys = validateExactKeys(type, itemPath, record, fields);
    if (!keys.ok) return keys;
    const shapeResult = validateFields(type, record, itemPath, shape);
    if (!shapeResult.ok) return shapeResult;
    for (const key of stringArrayKeys) {
      const strings = parseStringArray(type, record[key], `${itemPath}.${key}`);
      if (!strings.ok) return strings;
    }
    if (record.duration_ms !== undefined) {
      const duration = parseNonNegativeInteger(type, record.duration_ms, `${itemPath}.duration_ms`);
      if (!duration.ok) return duration;
    }
    if (record.score !== undefined) {
      const score = parseFiniteNumber(type, record.score, `${itemPath}.score`);
      if (!score.ok) return score;
    }
    if (record.active_window !== undefined) {
      const window = asRecord(record.active_window);
      if (!window) return invalidPayload(type, `${itemPath}.active_window`, "object");
      const windowShape = validateFields(type, window, `${itemPath}.active_window`, {
        start_ratio: "number", end_ratio: "number",
      });
      if (!windowShape.ok) return windowShape;
      for (const key of ["start_ratio", "end_ratio"] as const) {
        const ratio = parseFiniteNumber(type, window[key], `${itemPath}.active_window.${key}`);
        if (!ratio.ok || ratio.payload < 0 || ratio.payload > 1) {
          return invalidPayload(type, `${itemPath}.active_window.${key}`, "ratio between 0 and 1");
        }
      }
    }
    result.push(record);
  }
  return { ok: true, payload: result };
}

function parseMotionMaterialCounters(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<null> {
  if (!Array.isArray(value)) return invalidPayload(type, path, "array");
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    const record = asRecord(item);
    if (!record) return invalidPayload(type, itemPath, "object");
    const keys = validateExactKeys(type, itemPath, record, ["name", "count"]);
    if (!keys.ok) return keys;
    const shape = validateFields(type, record, itemPath, { name: "string", count: "number" });
    if (!shape.ok) return shape;
    const count = parseNonNegativeInteger(type, record.count, `${itemPath}.count`);
    if (!count.ok) return count;
  }
  return { ok: true, payload: null };
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
    "group_index",
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
    group_index: "number",
    duration: "number",
    parameter_ids: "array",
    catalog_label: "string",
    catalog_intensity: "string",
  });
  if (!shape.ok) return shape;
  if (!Number.isInteger(item.group_index) || Number(item.group_index) < 0) {
    return invalidPayload(type, `${path}.group_index`, "non-negative integer");
  }
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
  if (record.schema_version !== SCHEMA_SEMANTIC_AXIS_PROFILE_V3) {
    return invalidPayload(type, `${path}.schema_version`, SCHEMA_SEMANTIC_AXIS_PROFILE_V3);
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
    relation_graph: "record",
  });
  if (!shape.ok) return shape;
  if (!Number.isInteger(record.revision) || Number(record.revision) <= 0) {
    return invalidPayload(type, `${path}.revision`, "positive integer");
  }
  if (!["generated", "user_modified", "stale"].includes(String(record.status))) {
    return invalidPayload(type, `${path}.status`, "known profile status");
  }

  const axisIds = new Set<string>();
  for (const [index, axis] of (record.axes as unknown[]).entries()) {
    const parsed = validateSemanticAxis(type, axis, `${path}.axes[${index}]`);
    if (!parsed.ok) return parsed;
    const axisId = String((axis as Record<string, unknown>).id).trim();
    if (axisIds.has(axisId)) {
      return invalidPayload(type, `${path}.axes[${index}].id`, "unique semantic axis id");
    }
    axisIds.add(axisId);
  }
  const relationGraph = parseSemanticAxisRelationGraph(
    type,
    record.relation_graph,
    `${path}.relation_graph`,
    axisIds,
  );
  if (!relationGraph.ok) return relationGraph;
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
  const axisId = String(axis.id);
  if (!axisId.trim()) {
    return invalidPayload(type, `${path}.id`, "non-empty string");
  }
  if (axisId !== axisId.trim()) {
    return invalidPayload(type, `${path}.id`, "trimmed semantic axis id");
  }
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
  const parameterIds = new Set<string>();
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
    if (binding.interaction_role !== undefined && (typeof binding.interaction_role !== "string"
      || !Object.prototype.hasOwnProperty.call(INTERACTION_ROLES, binding.interaction_role))) {
      return invalidPayload(type, `${bindingPath}.interaction_role`, "known interaction role");
    }
    const rawParameterId = String(binding.parameter_id);
    const parameterId = rawParameterId.trim();
    if (!parameterId) {
      return invalidPayload(type, `${bindingPath}.parameter_id`, "non-empty string");
    }
    if (rawParameterId !== parameterId) {
      return invalidPayload(type, `${bindingPath}.parameter_id`, "trimmed parameter binding id");
    }
    if (parameterIds.has(parameterId)) {
      return invalidPayload(type, `${bindingPath}.parameter_id`, "unique parameter binding id");
    }
    parameterIds.add(parameterId);
    const inputRange = parseFiniteRange(type, binding.input_range, `${bindingPath}.input_range`);
    if (!inputRange.ok) return inputRange;
    const outputRange = parseFiniteRange(
      type,
      binding.output_range,
      `${bindingPath}.output_range`,
      { requirePositiveSpan: true },
    );
    if (!outputRange.ok) return outputRange;
    if (binding.parameter_name !== undefined && typeof binding.parameter_name !== "string") {
      return invalidPayload(type, `${bindingPath}.parameter_name`, "string | undefined");
    }
  }
  return { ok: true, payload: null };
}

function parseSemanticAxisRelationGraph(
  type: string,
  value: unknown,
  path: string,
  axisIds: ReadonlySet<string>,
): PayloadParseResult<null> {
  const graph = asRecord(value);
  if (!graph) return invalidPayload(type, path, "object");
  if (graph.schema_version !== SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1) {
    return invalidPayload(
      type,
      `${path}.schema_version`,
      SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1,
    );
  }
  if (!Array.isArray(graph.edges)) {
    return invalidPayload(type, `${path}.edges`, "array");
  }

  const ruleIds = new Set<string>();
  const targetOwners = new Map<string, string>();
  const adjacency = new Map<string, string[]>();
  for (const [index, value] of graph.edges.entries()) {
    const edgePath = `${path}.edges[${index}]`;
    const parsed = validateRelationRule(type, value, edgePath);
    if (!parsed.ok) return parsed;
    const rule = parsed.payload;
    if (!axisIds.has(rule.source_axis_id)) {
      return invalidPayload(type, `${edgePath}.source_axis_id`, "known semantic axis id");
    }
    if (!axisIds.has(rule.target_axis_id)) {
      return invalidPayload(type, `${edgePath}.target_axis_id`, "known semantic axis id");
    }
    if (ruleIds.has(rule.id)) {
      return invalidPayload(type, `${edgePath}.id`, "unique relation rule id");
    }
    ruleIds.add(rule.id);
    if (targetOwners.has(rule.target_axis_id)) {
      return invalidPayload(type, `${edgePath}.target_axis_id`, "unique relation target axis");
    }
    targetOwners.set(rule.target_axis_id, rule.id);
    const targets = adjacency.get(rule.source_axis_id) ?? [];
    targets.push(rule.target_axis_id);
    adjacency.set(rule.source_axis_id, targets);
  }
  if (hasRelationCycle(adjacency)) {
    return invalidPayload(type, `${path}.edges`, "acyclic relation graph");
  }
  return { ok: true, payload: null };
}

function validateRelationRule(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<SemanticAxisRelationRule> {
  const rule = asRecord(value);
  if (!rule) return invalidPayload(type, path, "object");
  const shape = validateFields(type, rule, path, {
    id: "string",
    source_axis_id: "string",
    target_axis_id: "string",
    kind: "string",
    mode: "string",
    scale: "number",
    deadzone: "number",
    max_delta: "number",
  });
  if (!shape.ok) return shape;
  const typedRule = rule as unknown as SemanticAxisRelationRule;
  if (!typedRule.id.trim()) return invalidPayload(type, `${path}.id`, "non-empty string");
  if (!typedRule.source_axis_id.trim()) {
    return invalidPayload(type, `${path}.source_axis_id`, "non-empty string");
  }
  if (!typedRule.target_axis_id.trim()) {
    return invalidPayload(type, `${path}.target_axis_id`, "non-empty string");
  }
  if (typedRule.source_axis_id === typedRule.target_axis_id) {
    return invalidPayload(type, `${path}.target_axis_id`, "different source and target axis");
  }
  if (!["same_direction", "opposite_direction"].includes(typedRule.mode)) {
    return invalidPayload(type, `${path}.mode`, "known relation mode");
  }
  if (!["derive", "bounded_ratio"].includes(typedRule.kind)) {
    return invalidPayload(type, `${path}.kind`, "known relation kind");
  }
  if ([typedRule.scale, typedRule.deadzone, typedRule.max_delta].some((item) => item < 0)) {
    return invalidPayload(type, path, "non-negative relation limits");
  }
  return {
    ok: true,
    payload: typedRule,
  };
}

function hasRelationCycle(adjacency: ReadonlyMap<string, readonly string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (axisId: string): boolean => {
    if (visited.has(axisId)) return false;
    if (visiting.has(axisId)) return true;
    visiting.add(axisId);
    for (const targetAxisId of adjacency.get(axisId) ?? []) {
      if (visit(targetAxisId)) return true;
    }
    visiting.delete(axisId);
    visited.add(axisId);
    return false;
  };
  return [...adjacency.keys()].some((axisId) => visit(axisId));
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
  const allowedKeys = new Set(["root", "scan_cache", "motion_tuning_samples"]);
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

function parseFiniteNumber(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<number> {
  return isFiniteNumber(value)
    ? { ok: true, payload: value }
    : invalidPayload(type, path, "finite number");
}

function parseNonNegativeNumber(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<number> {
  const parsed = parseFiniteNumber(type, value, path);
  if (!parsed.ok) return parsed;
  return parsed.payload >= 0
    ? parsed
    : invalidPayload(type, path, "non-negative finite number");
}

function parseNonNegativeInteger(
  type: string,
  value: unknown,
  path: string,
): PayloadParseResult<number> {
  const parsed = parseFiniteNumber(type, value, path);
  if (!parsed.ok) return parsed;
  return Number.isInteger(parsed.payload) && parsed.payload >= 0
    ? parsed
    : invalidPayload(type, path, "non-negative integer");
}

function parseFiniteRange(
  type: string,
  value: unknown,
  path: string,
  options: { requirePositiveSpan?: boolean } = {},
): PayloadParseResult<[number, number]> {
  const requirePositiveSpan = options.requirePositiveSpan === true;
  const expected = requirePositiveSpan
    ? "strictly increasing finite [min, max]"
    : "ordered finite [min, max]";
  if (
    !Array.isArray(value)
    || value.length !== 2
    || !isFiniteNumber(value[0])
    || !isFiniteNumber(value[1])
    || (requirePositiveSpan ? value[0] >= value[1] : value[0] > value[1])
  ) {
    return invalidPayload(type, path, expected);
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
