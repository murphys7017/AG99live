export function makeValidSemanticAxisProfile(modelId = "model-a") {
  return {
    schema_version: "ag99.semantic_axis_profile.v2",
    profile_id: `${modelId}.semantic.v2`,
    model_id: modelId,
    source_hash: "source-hash",
    last_scanned_hash: "source-hash",
    revision: 1,
    status: "generated",
    user_modified: false,
    generated_at: "2026-05-08T00:00:00.000Z",
    updated_at: "2026-05-08T00:00:00.000Z",
    axes: [],
    couplings: [],
    relation_graph: {
      schema_version: "ag99.semantic_axis_relation_graph.v1",
      edges: [],
    },
  };
}

export function makeValidVoiceFollowingProfile(modelId = "model-a") {
  return {
    schema_version: "ag99.voice_following_profile.v2",
    model_id: modelId,
    revision: 1,
    channels: {
      head_yaw: {
        channel: "head_yaw",
        parameter_id: "ParamAngleX",
        parameter_name: "Angle X",
        layer: "head",
        neutral: 0,
        output_range: { min: -30, max: 30 },
        amplitude: 2.2,
        weight: 0.65,
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
    resource_scan: {
      model3_file: `${name}.model3.json`,
      cdi3_file: `${name}.cdi3.json`,
      physics3_file: `${name}.physics3.json`,
      texture_count: 1,
      texture_files: ["texture.png"],
      expression_count: 0,
      expression_files: [],
      motion_count: 0,
      motion_files: [],
      motion_groups: [],
      vtube_profile_count: 0,
      vtube_profiles: [],
      has_motion_catalog: false,
    },
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
    expression_scan: {
      total_expressions: 0,
      category_counts: [],
      blend_counts: [],
      domain_usage: [],
      channel_usage: [],
      base_expression_names: [],
      special_state_names: [],
      expression_driven_parameters: [],
    },
    base_action_library: {
      schema_version: "base_action_library.v1",
      extraction_mode: "deterministic",
      analysis: {},
      focus_channels: [],
      focus_domains: [],
      ignored_domains: [],
      summary: {},
      families: [],
      channels: [],
      atoms: [],
    },
    parameter_action_library: {
      schema_version: "parameter_action_library.v1",
      extraction_mode: "deterministic",
      analysis: {},
      summary: {},
      domains: [],
      channels: [],
      parameters: [],
      atoms: [],
    },
    motion_resource_pool: {
      decomposition_level: "parameter",
      summary: {},
      components: [],
      driver_components: [],
      channel_pool: [],
      domain_pool: [],
      parameter_pool: [],
      motion_presets: [],
    },
    constraints: { expressions: [], motions: [] },
    semantic_axis_profile: makeValidSemanticAxisProfile(name),
    calibration_profile: {
      schema_version: "direct_parameter_calibration.v1",
      axes: {},
    },
    voice_following_profile: makeValidVoiceFollowingProfile(name),
    engine_hints: {
      driver_priority: ["parameters", "expression", "motion"],
      recommended_mode: "parameters",
      available_channels: ["head_yaw"],
      base_expression_count: 0,
      fallback_motion_count: 0,
      motion_decomposition_level: "parameter",
    },
    ...overrides,
  };
}

export function makeValidModelSyncPayload(overrides: Record<string, unknown> = {}) {
  const model = makeValidModelSummary();
  return {
    model_info: {
      schema_version: "live2d_scan.v1",
      driver_priority: ["parameters", "expression", "motion"],
      selected_model: model.name,
      available_models: [model.name],
      models: [model],
    },
    conf_name: "default",
    conf_uid: "conf-1",
    client_uid: "client-1",
    ...overrides,
  };
}
