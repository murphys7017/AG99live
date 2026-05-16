import assert from "node:assert/strict";
import { compileMotionIntent } from "../src/model-engine/compiler.js";
import type { ModelSummary, SemanticMotionIntent } from "../src/types/protocol.js";
import type { SemanticAxisProfile } from "../src/types/semantic-axis-profile.js";

function buildProfile(): SemanticAxisProfile {
  return {
    schema_version: "ag99.semantic_axis_profile.v1",
    profile_id: "profile-1",
    model_id: "model-1",
    source_hash: "hash",
    last_scanned_hash: "hash",
    revision: 1,
    status: "user_modified",
    user_modified: true,
    generated_at: "2026-05-16T00:00:00.000Z",
    updated_at: "2026-05-16T00:00:00.000Z",
    axes: [
      {
        id: "gaze_x",
        label: "Gaze X",
        description: "Eyes horizontal",
        semantic_group: "gaze",
        control_role: "primary",
        neutral: 50,
        value_range: [0, 100],
        soft_range: [44, 56],
        strong_range: [30, 70],
        positive_semantics: ["right"],
        negative_semantics: ["left"],
        usage_notes: "Drive eye direction.",
        parameter_bindings: [
          {
            parameter_id: "ParamEyeBallX",
            input_range: [0, 100],
            output_range: [-1, 1],
            default_weight: 1,
            invert: false,
          },
        ],
      },
      {
        id: "head_yaw",
        label: "Head Yaw",
        description: "Head horizontal",
        semantic_group: "head",
        control_role: "primary",
        neutral: 50,
        value_range: [0, 100],
        soft_range: [42, 58],
        strong_range: [30, 70],
        positive_semantics: ["turn right"],
        negative_semantics: ["turn left"],
        usage_notes: "Drive head direction.",
        parameter_bindings: [
          {
            parameter_id: "ParamAngleX",
            input_range: [0, 100],
            output_range: [-30, 30],
            default_weight: 1,
            invert: false,
          },
        ],
      },
      {
        id: "body_yaw",
        label: "Body Yaw",
        description: "Body horizontal",
        semantic_group: "body",
        control_role: "derived",
        neutral: 50,
        value_range: [0, 100],
        soft_range: [46, 54],
        strong_range: [38, 62],
        positive_semantics: ["body right"],
        negative_semantics: ["body left"],
        usage_notes: "Follow head direction.",
        parameter_bindings: [
          {
            parameter_id: "ParamBodyAngleX",
            input_range: [0, 100],
            output_range: [-10, 10],
            default_weight: 1,
            invert: false,
          },
        ],
      },
      {
        id: "mouth_smile",
        label: "Mouth Smile",
        description: "Smile amount",
        semantic_group: "mouth",
        control_role: "primary",
        neutral: 50,
        value_range: [0, 100],
        soft_range: [44, 60],
        strong_range: [30, 75],
        positive_semantics: ["smile"],
        negative_semantics: ["frown"],
        usage_notes: "Primary smile axis.",
        parameter_bindings: [
          {
            parameter_id: "ParamMouthForm",
            input_range: [0, 100],
            output_range: [-1, 1],
            default_weight: 1,
            invert: false,
          },
        ],
      },
    ],
    couplings: [
      {
        id: "gaze_x_to_head_yaw",
        source_axis_id: "gaze_x",
        target_axis_id: "head_yaw",
        mode: "same_direction",
        scale: 0.25,
        deadzone: 4,
        max_delta: 10,
      },
      {
        id: "head_yaw_to_body_yaw",
        source_axis_id: "head_yaw",
        target_axis_id: "body_yaw",
        mode: "same_direction",
        scale: 0.35,
        deadzone: 6,
        max_delta: 12,
      },
    ],
  };
}

function buildModel(profile: SemanticAxisProfile): ModelSummary {
  return {
    name: "model-1",
    root_path: "",
    model_path: "",
    model_url: "",
    icon_url: "",
    resource_scan: {
      model3_file: "",
      cdi3_file: "",
      physics3_file: "",
      texture_count: 0,
      texture_files: [],
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
      source: "",
      total_parameters: 0,
      drivable_parameters: 0,
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
      schema_version: "",
      extraction_mode: "",
      analysis: { status: "", mode: "", provider_id: "" },
      focus_channels: [],
      focus_domains: [],
      ignored_domains: [],
      summary: {
        motion_count: 0,
        available_channel_count: 0,
        selected_channel_count: 0,
        candidate_component_count: 0,
        selected_atom_count: 0,
        family_count: 0,
      },
      families: [],
      channels: [],
      atoms: [],
    },
    parameter_action_library: {
      schema_version: "",
      extraction_mode: "",
      analysis: { status: "", mode: "", provider_id: "" },
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
    motion_resource_pool: {
      decomposition_level: "",
      summary: {
        motion_count: 0,
        component_count: 0,
        driver_component_count: 0,
        overlay_component_count: 0,
        channel_pool_count: 0,
        domain_pool_count: 0,
        parameter_pool_count: 0,
      },
      components: [],
      driver_components: [],
      channel_pool: [],
      domain_pool: [],
      parameter_pool: [],
      motion_presets: [],
    },
    constraints: {
      expressions: [],
      motions: [],
    },
    semantic_axis_profile: profile,
    calibration_profile: null,
    engine_hints: {
      driver_priority: [],
      recommended_mode: "",
      available_channels: [],
      base_expression_count: 0,
      fallback_motion_count: 0,
      motion_decomposition_level: "",
    },
  };
}

function buildIntent(overrides?: Partial<SemanticMotionIntent>): SemanticMotionIntent {
  return {
    schema_version: "engine.motion_intent.v2",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    emotion_label: "happy",
    duration_hint_ms: 1200,
    axes: {
      gaze_x: { value: 70 },
      head_yaw: { value: 80 },
      mouth_smile: { value: 62 },
    },
    ...overrides,
  };
}

function testExplicitPrimaryAxisIsNotOverwrittenByCoupling(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent(), {
    model: buildModel(profile),
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.plan);

  const headYaw = result.plan?.parameters.find((item) => item.parameter_id === "ParamAngleX");
  const bodyYaw = result.plan?.parameters.find((item) => item.parameter_id === "ParamBodyAngleX");
  assert.ok(headYaw);
  assert.ok(bodyYaw);
  assert.equal(headYaw?.source, "semantic_axis");
  assert.equal(headYaw?.input_value, 80);
  assert.equal(bodyYaw?.source, "coupling");
  assert.equal(bodyYaw?.input_value, 60.5);
  assert.equal(
    result.diagnostics.warnings?.includes("semantic_coupling_skipped_explicit_target:gaze_x_to_head_yaw:head_yaw"),
    true,
  );
}

function testAxisIntensityScaleAffectsOnlyTargetAxis(): void {
  const profile = buildProfile();
  const baseline = compileMotionIntent(buildIntent({
    axes: {
      mouth_smile: { value: 60 },
    },
  }), {
    model: buildModel(profile),
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });
  const scaled = compileMotionIntent(buildIntent({
    axes: {
      mouth_smile: { value: 60 },
    },
  }), {
    model: buildModel(profile),
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {
        mouth_smile: 2,
      },
    },
  });

  assert.equal(baseline.ok, true);
  assert.equal(scaled.ok, true);
  const baselineSmile = baseline.plan?.parameters.find((item) => item.parameter_id === "ParamMouthForm");
  const scaledSmile = scaled.plan?.parameters.find((item) => item.parameter_id === "ParamMouthForm");
  assert.ok(baselineSmile);
  assert.ok(scaledSmile);
  assert.equal(baselineSmile?.input_value, 60);
  assert.equal(scaledSmile?.input_value, 70);
  assert.ok((scaledSmile?.target_value ?? 0) > (baselineSmile?.target_value ?? 0));
}

function run(): void {
  testExplicitPrimaryAxisIsNotOverwrittenByCoupling();
  testAxisIntensityScaleAffectsOnlyTargetAxis();
  console.log("modelEngineCompiler tests passed");
}

run();
