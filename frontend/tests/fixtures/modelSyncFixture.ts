export function makeValidSemanticAxisProfile(modelId = "model-a") {
  return {
    schema_version: "ag99.semantic_axis_profile.v3",
    profile_id: `${modelId}.semantic.v3`,
    model_id: modelId,
    source_hash: "source-hash",
    last_scanned_hash: "source-hash",
    revision: 1,
    status: "generated",
    user_modified: false,
    generated_at: "2026-05-08T00:00:00.000Z",
    updated_at: "2026-05-08T00:00:00.000Z",
    axes: [],
    relation_graph: {
      schema_version: "ag99.semantic_axis_relation_graph.v1",
      edges: [],
    },
  };
}

export function makeValidVoiceFollowingProfile(modelId = "model-a") {
  return {
    schema_version: "ag99.voice_following_profile.v3",
    model_id: modelId,
    revision: 1,
    channels: {
      head_yaw: {
        channel: "head_yaw",
        semantic_axis_id: "head_yaw",
        layer: "head",
        amplitude_ratio: 0.3,
        follow_delay_ms: 0,
      },
    },
    summary: {
      channel_count: 1,
      available_channels: ["head_yaw"],
    },
  };
}

export function makeValidModelSummary(overrides: Record<string, unknown> = {}) {
  const name = typeof overrides.name === "string" ? overrides.name : "model-a";
  return {
    name,
    root_path: `/live2ds/${name}`,
    model_path: `${name}.model3.json`,
    model_url: `https://example.com/live2ds/${name}/${name}.model3.json`,
    icon_url: "",
    parameter_scan: {
      source: `${name}.cdi3.json`,
      total_parameters: 1,
      drivable_parameters: 1,
      physics_parameters: 0,
      expression_parameters: 0,
      groups: [],
      domain_counts: [],
      standard_channels: {},
      primary_parameters: [],
      parameters: [],
    },
    parameter_action_library: {
      schema_version: "parameter_action_library.v2",
      extraction_mode: "rule_seed",
      analysis: { status: "seeded", mode: "parameter_track" },
      summary: {
        motion_count: 0,
        driver_component_count: 0,
        candidate_atom_count: 0,
        selected_atom_count: 0,
        candidate_parameter_count: 0,
        selected_parameter_count: 0,
        domain_count: 0,
        channel_count: 0,
      },
      domains: [],
      channels: [],
      parameters: [],
      atoms: [],
    },
    constraints: { expressions: [], motions: [] },
    semantic_axis_profile: makeValidSemanticAxisProfile(name),
    voice_following_profile: makeValidVoiceFollowingProfile(name),
    ...overrides,
  };
}

export function makeValidModelSyncPayload(overrides: Record<string, unknown> = {}) {
  const model = makeValidModelSummary();
  return {
    model_info: {
      schema_version: "live2d_scan.v4",
      selected_model: model.name,
      available_models: [model.name],
      models: [model],
    },
    runtime_cache_errors: {},
    ...overrides,
  };
}
