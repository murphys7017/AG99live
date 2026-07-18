import assert from "node:assert/strict";
import { compileMotionIntent } from "../src/model-engine/compiler/compileMotionIntent.js";
import { advanceParameterDynamics } from "../src/live2d/WebSDK/src/parameterdynamics.js";
import { normalizeMotionPayload } from "../src/model-engine/normalize.js";
import { parseSemanticParameterPlan } from "../src/model-engine/planParser.js";
import {
  prepareSemanticMotionPayload,
  startNormalizedMotionPayload,
} from "../src/model-engine/runtime/motionStart.js";
import { retimeSemanticParameterPlan } from "../src/model-engine/runtime/playbackClock.js";
import { buildSpeechOnlyMotionRequest } from "../src/model-engine/runtime/speechOnlyMotion.js";
import { useModelEngine } from "../src/model-engine/useModelEngine.js";
import { resolveMotionTiming } from "../src/model-engine/timing.js";
import {
  createModelEngineStageRegistry,
  listCompileStageRegistrations,
} from "../src/model-engine/compiler/registry.js";
import type {
  ModelSummary,
  MotionPlanPayload,
  NormalizedSemanticMotionIntentV3,
  NormalizedSemanticMotionIntentV4,
  SemanticParameterPlan,
} from "../src/types/protocol.js";
import type { SemanticAxisProfile } from "../src/types/semantic-axis-profile.js";
import type {
  ModelEngineCompileFailedEvent,
  ModelEnginePlanStartedEvent,
} from "../src/model-engine/runtime/contracts.js";
import type { CompileDiagnostics } from "../src/model-engine/compiler/contracts.js";

(globalThis as Record<string, unknown>).window = globalThis;

function testDefaultMotionDurationMatchesAdapterContract(): void {
  const resolved = resolveMotionTiming({ mode: "expressive" });
  assert.equal(resolved.resolvedDurationMs, 1000);
  assert.equal(resolved.timing.duration_ms, 1000);
  assert.equal(resolved.timingSource, "default");
}

const ignorePlanStarted = (_event: ModelEnginePlanStartedEvent): void => {};
const samplingIdentity = {
  turnId: "turn-level-test",
  messageId: "message-level-test",
};

function buildProfile(): SemanticAxisProfile {
  return {
    schema_version: "ag99.semantic_axis_profile.v2",
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
        extreme_range: [16, 84],
        positive_semantics: ["right"],
        negative_semantics: ["left"],
        usage_notes: "Drive eye direction.",
        dynamics: {
          max_velocity: 180,
          max_acceleration: 900,
          life_motion_scale: 0.2,
          max_speech_offset_ratio: 0.04,
        },
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
        extreme_range: [18, 82],
        positive_semantics: ["turn right"],
        negative_semantics: ["turn left"],
        usage_notes: "Drive head direction.",
        dynamics: {
          max_velocity: 120,
          max_acceleration: 600,
          life_motion_scale: 0.55,
          max_speech_offset_ratio: 0.08,
        },
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
        extreme_range: [30, 70],
        positive_semantics: ["body right"],
        negative_semantics: ["body left"],
        usage_notes: "Follow head direction.",
        dynamics: {
          max_velocity: 70,
          max_acceleration: 300,
          life_motion_scale: 0.3,
          max_speech_offset_ratio: 0.06,
        },
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
        id: "speech_head_sway",
        label: "Speech Head Sway",
        description: "Light head sway while speaking",
        semantic_group: "head",
        control_role: "derived",
        neutral: 50,
        value_range: [0, 100],
        soft_range: [46, 54],
        strong_range: [36, 64],
        extreme_range: [26, 74],
        positive_semantics: ["speaking head motion"],
        negative_semantics: ["speaking head motion opposite"],
        usage_notes: "Dedicated speech pose compensation axis.",
        dynamics: {
          max_velocity: 120,
          max_acceleration: 600,
          life_motion_scale: 0,
          max_speech_offset_ratio: 0.08,
        },
        parameter_bindings: [
          {
            parameter_id: "ParamSpeechHeadSway",
            input_range: [0, 100],
            output_range: [-8, 8],
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
        extreme_range: [16, 90],
        positive_semantics: ["smile"],
        negative_semantics: ["frown"],
        usage_notes: "Primary smile axis.",
        dynamics: {
          max_velocity: 160,
          max_acceleration: 800,
          life_motion_scale: 0.12,
          max_speech_offset_ratio: 0.03,
        },
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
    relation_graph: {
      schema_version: "ag99.semantic_axis_relation_graph.v1",
      edges: [
        {
          id: "gaze_x_to_head_yaw",
          source_axis_id: "gaze_x",
          target_axis_id: "head_yaw",
          kind: "derive",
          mode: "same_direction",
          scale: 0.25,
          deadzone: 4,
          max_delta: 10,
        },
        {
          id: "head_yaw_to_body_yaw",
          source_axis_id: "head_yaw",
          target_axis_id: "body_yaw",
          kind: "bounded_ratio",
          mode: "same_direction",
          scale: 0.35,
          deadzone: 6,
          max_delta: 12,
        },
      ],
    },
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
    voice_following_profile: null,
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

function buildModelWithVoiceFollowingProfile(profile: SemanticAxisProfile): ModelSummary {
  const model = buildModel(profile);
  model.voice_following_profile = {
    schema_version: "ag99.voice_following_profile.v2",
    model_id: "model-1",
    revision: 1,
    channels: {
      head_roll: {
        channel: "head_roll",
        parameter_id: "ParamAngleZ",
        parameter_name: "ParamAngleZ",
        layer: "head",
        neutral: 0,
        output_range: { min: -30, max: 30 },
        amplitude: 2.8,
        weight: 0.75,
        follow_delay_ms: 0,
      },
      head_pitch: {
        channel: "head_pitch",
        parameter_id: "ParamAngleY",
        parameter_name: "ParamAngleY",
        layer: "head",
        neutral: 0,
        output_range: { min: -30, max: 30 },
        amplitude: 1.0,
        weight: 0.35,
        follow_delay_ms: 0,
      },
      head_yaw: {
        channel: "head_yaw",
        parameter_id: "ParamAngleX",
        parameter_name: "ParamAngleX",
        layer: "head",
        neutral: 0,
        output_range: { min: -30, max: 30 },
        amplitude: 2.4,
        weight: 0.7,
        follow_delay_ms: 0,
      },
      body_yaw: {
        channel: "body_yaw",
        parameter_id: "ParamBodyAngleX",
        parameter_name: "ParamBodyAngleX",
        layer: "body",
        neutral: 0,
        output_range: { min: -10, max: 10 },
        amplitude: 0.9,
        weight: 0.35,
        follow_delay_ms: 220,
      },
      body_roll: {
        channel: "body_roll",
        parameter_id: "ParamBodyAngleZ",
        parameter_name: "ParamBodyAngleZ",
        layer: "body",
        neutral: 0,
        output_range: { min: -10, max: 10 },
        amplitude: 1.2,
        weight: 0.45,
        follow_delay_ms: 180,
      },
      body_pitch: {
        channel: "body_pitch",
        parameter_id: "ParamBodyAngleY",
        parameter_name: "ParamBodyAngleY",
        layer: "body",
        neutral: 0,
        output_range: { min: -10, max: 10 },
        amplitude: 0.8,
        weight: 0.3,
        follow_delay_ms: 160,
      },
    },
    summary: {
      channel_count: 6,
      available_channels: [
        "head_roll",
        "head_pitch",
        "head_yaw",
        "body_yaw",
        "body_roll",
        "body_pitch",
      ],
    },
  };
  return model;
}

function buildIntent(
  overrides?: Partial<NormalizedSemanticMotionIntentV3>,
): NormalizedSemanticMotionIntentV3 {
  return {
    schema_version: "engine.motion_intent.v3",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    emotion_label: "happy",
    duration_hint_ms: 1200,
    axes: {
      gaze_x: 70,
      head_yaw: 80,
      mouth_smile: 62,
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

function testMotionCompileFailureEmitsStructuredFeedback(): void {
  const failures: ModelEngineCompileFailedEvent[] = [];
  const started = startNormalizedMotionPayload(
    {
      kind: "semantic_intent",
      intent: buildIntent({ axes: { unknown_axis: 70 } }),
    },
    {
      messageId: "msg-invalid-axis",
      turnId: "turn-invalid-axis",
      playbackTurnId: "turn-invalid-axis",
      playbackOrigin: "conversation",
      startReason: "playback_timeline_started",
      queuedDelayMs: 90,
    },
    {
      getSelectedModel: () => buildModel(buildProfile()),
      getSettings: () => ({ motionIntensityScale: 1, axisIntensityScale: {} }),
      playPlan: () => false,
      playCatalogMotion: () => false,
      onPlanStarted: ignorePlanStarted,
      onCompileFailed: (event) => failures.push(event),
    },
    {
      setState: () => {},
      setLastCompileReason: () => {},
      setLastCompileDiagnostics: () => {},
      setLastStartReason: () => {},
      pushHistory: () => {},
    },
  );

  assert.equal(started, false);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /semantic_axis_validation_failed/);
  assert.deepEqual(failures[0].feedback?.fields, ["unknown_axis"]);
}

function buildLevelIntent(
  overrides?: Partial<NormalizedSemanticMotionIntentV4>,
): NormalizedSemanticMotionIntentV4 {
  return {
    schema_version: "engine.motion_intent.v4",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    emotion_label: "happy",
    duration_hint_ms: 1200,
    axis_levels: {
      head_yaw: 2,
    },
    ...overrides,
  } as NormalizedSemanticMotionIntentV4;
}

function testNormalizeMotionPayloadAcceptsV3FlatAxes(): void {
  const result = normalizeMotionPayload({
    schema_version: "engine.motion_intent.v3",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    intent_tags: ["happy", "preview"],
    emotion_label: "happy",
    duration_hint_ms: 1000,
    resource_id: "expression.smile",
    axes: {
      head_yaw: 62,
      mouth_smile: 84,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.kind, "semantic_intent");
  assert.deepEqual(result.payload.intent.axes, {
    head_yaw: 62,
    mouth_smile: 84,
  });
  assert.equal(result.payload.intent.resource_id, "expression.smile");
}

function testNormalizeMotionPayloadAcceptsV4AxisLevels(): void {
  const result = normalizeMotionPayload({
    schema_version: "engine.motion_intent.v4",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    intent_tags: ["happy"],
    emotion_label: "happy",
    axis_levels: {
      head_yaw: -4,
      mouth_smile: 4,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.kind, "semantic_intent");
  assert.equal(result.payload.intent.schema_version, "engine.motion_intent.v4");
  if (result.payload.intent.schema_version !== "engine.motion_intent.v4") {
    throw new Error("Expected v4 semantic motion intent.");
  }
  assert.deepEqual(result.payload.intent.axis_levels, {
    head_yaw: -4,
    mouth_smile: 4,
  });
  assert.deepEqual(result.payload.intent.intent_tags, ["happy"]);
  assert.equal("axes" in result.payload.intent, false);
}

function testNormalizeMotionPayloadAcceptsV4MotionSequence(): void {
  const result = normalizeMotionPayload({
    schema_version: "engine.motion_intent.v4",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    intent_tags: ["测试", "左右扭头"],
    emotion_label: "测试",
    motion_steps: [
      { axis_levels: { head_yaw: -3 }, duration_weight: 1 },
      { axis_levels: { head_yaw: 3 }, duration_weight: 2 },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.kind, "semantic_intent");
  if (
    result.payload.kind !== "semantic_intent"
    || result.payload.intent.schema_version !== "engine.motion_intent.v4"
    || !result.payload.intent.motion_steps
  ) {
    throw new Error("Expected v4 semantic motion sequence.");
  }
  assert.deepEqual(result.payload.intent.motion_steps, [
    { axis_levels: { head_yaw: -3 }, duration_weight: 1 },
    { axis_levels: { head_yaw: 3 }, duration_weight: 2 },
  ]);
  assert.equal("axis_levels" in result.payload.intent, false);
}

function testNormalizeMotionPayloadRejectsMixedOrInvalidAxisLevelContracts(): void {
  const common = {
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    emotion_label: "happy",
  };
  const mixedV4 = normalizeMotionPayload({
    ...common,
    schema_version: "engine.motion_intent.v4",
    axis_levels: { head_yaw: 1 },
    axes: { head_yaw: 60 },
  });
  const invalidV4 = normalizeMotionPayload({
    ...common,
    schema_version: "engine.motion_intent.v4",
    axis_levels: { head_yaw: 1.5 },
  });
  const outOfRangeV4 = normalizeMotionPayload({
    ...common,
    schema_version: "engine.motion_intent.v4",
    axis_levels: { head_yaw: 5 },
  });
  const mixedV3 = normalizeMotionPayload({
    ...common,
    schema_version: "engine.motion_intent.v3",
    axes: { head_yaw: 60 },
    axis_levels: { head_yaw: 1 },
  });

  assert.equal(mixedV4.ok, false);
  assert.equal(mixedV4.reason, "motion_intent_v4.invalid_axis_levels");
  assert.equal(invalidV4.ok, false);
  assert.equal(invalidV4.reason, "motion_intent_v4.invalid_axis_levels");
  assert.equal(outOfRangeV4.ok, false);
  assert.equal(outOfRangeV4.reason, "motion_intent_v4.invalid_axis_levels");
  assert.equal(mixedV3.ok, false);
  assert.equal(mixedV3.reason, "motion_intent_v3.axis_levels_forbidden");
}

function testV4AxisLevelsResolveThroughProfileAnchors(): void {
  const profile = buildProfile();
  const headYaw = profile.axes.find((axis) => axis.id === "head_yaw");
  assert.ok(headYaw);
  headYaw.level_anchors = {
    "-4": 20,
    "-3": 30,
    "-2": 38,
    "-1": 45,
    "0": 50,
    "1": 56,
    "2": 64,
    "3": 70,
    "4": 80,
  };

  const result = compileMotionIntent(buildLevelIntent(), {
    model: buildModel(profile),
    targetDurationMs: 1200,
    samplingIdentity,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  const parameter = result.plan?.parameters.find((item) => item.parameter_id === "ParamAngleX");
  assert.ok((parameter?.input_value ?? 0) >= 60);
  assert.ok((parameter?.input_value ?? 100) <= 67);
  assert.deepEqual(result.diagnostics.transformTrace?.rawAxisLevels, { head_yaw: 2 });
  assert.deepEqual(result.diagnostics.transformTrace?.rawAxes, {});
  assert.equal(
    result.diagnostics.transformTrace?.resolvedAxes.head_yaw,
    parameter?.input_value,
  );
  assert.equal(parameter?.neutral_target_value, 0);
  assert.equal(parameter?.dynamics?.max_velocity, 72);
  assert.equal(parameter?.dynamics?.max_acceleration, 360);
  assert.equal(
    result.diagnostics.transformTrace?.axisSampling?.seed,
    "turn-level-test|message-level-test|hash|semantic_motion_transform.v4",
  );

  const extreme = compileMotionIntent(buildLevelIntent({
    axis_levels: { head_yaw: 4 },
  }), {
    model: buildModel(profile),
    targetDurationMs: 1200,
    samplingIdentity: { ...samplingIdentity, messageId: "message-level-extreme" },
    settings: { motionIntensityScale: 1, axisIntensityScale: {} },
  });
  assert.equal(extreme.ok, true);
  const extremeValue = extreme.plan?.parameters.find(
    (item) => item.parameter_id === "ParamAngleX",
  )?.input_value;
  assert.ok((extremeValue ?? 0) >= 75);
  assert.ok((extremeValue ?? 100) <= 90);

  const replay = compileMotionIntent(buildLevelIntent(), {
    model: buildModel(profile),
    targetDurationMs: 1200,
    samplingIdentity,
    settings: { motionIntensityScale: 1, axisIntensityScale: {} },
  });
  assert.equal(
    replay.diagnostics.transformTrace?.resolvedAxes.head_yaw,
    result.diagnostics.transformTrace?.resolvedAxes.head_yaw,
  );
  const differentMessage = compileMotionIntent(buildLevelIntent(), {
    model: buildModel(profile),
    targetDurationMs: 1200,
    samplingIdentity: {
      ...samplingIdentity,
      messageId: "message-level-test-2",
    },
    settings: { motionIntensityScale: 1, axisIntensityScale: {} },
  });
  assert.notEqual(
    differentMessage.diagnostics.transformTrace?.resolvedAxes.head_yaw,
    result.diagnostics.transformTrace?.resolvedAxes.head_yaw,
  );

  const amplified = compileMotionIntent(buildLevelIntent(), {
    model: buildModel(profile),
    targetDurationMs: 1200,
    samplingIdentity,
    settings: { motionIntensityScale: 2.5, axisIntensityScale: {} },
  });
  const amplifiedValue = amplified.diagnostics.transformTrace?.resolvedAxes.head_yaw;
  const amplifiedBounds = amplified.diagnostics.transformTrace?.axisSampling
    ?.sampleBounds.head_yaw;
  assert.equal(amplified.ok, true);
  assert.ok(amplifiedBounds);
  assert.ok((amplifiedValue ?? -Infinity) >= amplifiedBounds!.min);
  assert.ok((amplifiedValue ?? Infinity) <= amplifiedBounds!.max);
  assert.equal(
    amplified.diagnostics.warnings?.some((warning) =>
      warning.startsWith("semantic_intensity_limited_to_level:head_yaw:"),
    ),
    true,
  );
}

function testV4AxisSamplingRequiresIdentityAndKeepsNeutralExact(): void {
  const profile = buildProfile();
  const headYaw = profile.axes.find((axis) => axis.id === "head_yaw");
  assert.ok(headYaw);
  headYaw.level_anchors = {
    "-3": 30, "-2": 38, "-1": 45, "0": 50, "1": 56, "2": 64, "3": 70,
  };

  const missingIdentity = compileMotionIntent(buildLevelIntent(), {
    model: buildModel(profile),
  });
  assert.equal(missingIdentity.ok, false);
  assert.equal(missingIdentity.reason, "semantic_axis_sampling_identity_missing");

  const neutral = compileMotionIntent(buildLevelIntent({
    axis_levels: { head_yaw: 0 },
  }), {
    model: buildModel(profile),
    samplingIdentity,
  });
  assert.equal(neutral.ok, false);
  assert.equal(neutral.reason, "semantic_axes_all_neutral");
  assert.equal(
    neutral.diagnostics.transformTrace?.axisSampling?.sampledValues.head_yaw,
    50,
  );

  profile.source_hash = "";
  const missingProfileHash = compileMotionIntent(buildLevelIntent(), {
    model: buildModel(profile),
    samplingIdentity,
  });
  assert.equal(missingProfileHash.ok, false);
  assert.equal(
    missingProfileHash.reason,
    "semantic_axis_sampling_profile_hash_missing",
  );
}

function testV4MotionSequenceCompilesToParameterKeyframes(): void {
  const profile = buildProfile();
  const headYaw = profile.axes.find((axis) => axis.id === "head_yaw");
  assert.ok(headYaw);
  headYaw.level_anchors = {
    "-3": 30,
    "-2": 38,
    "-1": 45,
    "0": 50,
    "1": 56,
    "2": 64,
    "3": 70,
  };
  const intent = buildLevelIntent() as NormalizedSemanticMotionIntentV4;
  delete (intent as { axis_levels?: unknown }).axis_levels;
  (intent as { motion_steps: unknown }).motion_steps = [
    { axis_levels: { head_yaw: -3 }, duration_weight: 1 },
    { axis_levels: { head_yaw: 3 }, duration_weight: 1 },
  ];

  const result = compileMotionIntent(intent, {
    model: buildModel(profile),
    targetDurationMs: 1200,
    samplingIdentity,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  const headParameter = result.plan?.parameters.find(
    (item) => item.parameter_id === "ParamAngleX",
  );
  assert.equal(headParameter?.keyframes?.[0].at_ms, 0);
  assert.equal(headParameter?.keyframes?.[0].transition_ms, 0);
  assert.ok((headParameter?.keyframes?.[0].input_value ?? 100) < 35);
  assert.ok((headParameter?.keyframes?.[0].target_value ?? 100) < 0);
  assert.equal(headParameter?.keyframes?.[1].at_ms, 600);
  assert.ok((headParameter?.keyframes?.[1].transition_ms ?? 0) >= 500);
  assert.ok((headParameter?.keyframes?.[1].transition_ms ?? 1000) <= 600);
  assert.ok((headParameter?.keyframes?.[1].input_value ?? 0) > 66);
  assert.ok((headParameter?.keyframes?.[1].target_value ?? -100) > 0);
  assert.equal(
    result.diagnostics.warnings?.includes("motion_sequence_compiled:2"),
    true,
  );
  assert.deepEqual(result.diagnostics.transformTrace?.rawMotionSteps, [
    { axis_levels: { head_yaw: -3 }, duration_weight: 1 },
    { axis_levels: { head_yaw: 3 }, duration_weight: 1 },
  ]);
  const parsedPlan = parseSemanticParameterPlan(result.plan);
  if (!parsedPlan.ok) {
    throw new Error(parsedPlan.reason);
  }
  assert.equal(parsedPlan.ok, true);
  assert.equal(
    parsedPlan.value.parameters.find((item) => item.parameter_id === "ParamAngleX")
      ?.keyframes?.length,
    2,
  );
}

function testV4MotionSequenceAllowsExplicitNeutralWaypoint(): void {
  const profile = buildProfile();
  const headYaw = profile.axes.find((axis) => axis.id === "head_yaw");
  assert.ok(headYaw);
  headYaw.level_anchors = {
    "-3": 30, "-2": 38, "-1": 45, "0": 50, "1": 56, "2": 64, "3": 70,
  };
  const intent = buildLevelIntent() as NormalizedSemanticMotionIntentV4;
  delete (intent as { axis_levels?: unknown }).axis_levels;
  (intent as { motion_steps: unknown }).motion_steps = [
    { axis_levels: { head_yaw: -2 }, duration_weight: 1 },
    { axis_levels: { head_yaw: 0 }, duration_weight: 1 },
    { axis_levels: { head_yaw: 2 }, duration_weight: 1 },
  ];

  const result = compileMotionIntent(intent, {
    model: buildModel(profile),
    targetDurationMs: 1200,
    samplingIdentity,
    settings: { motionIntensityScale: 1, axisIntensityScale: {} },
  });

  assert.equal(result.ok, true);
  const headParameter = result.plan?.parameters.find(
    (item) => item.parameter_id === "ParamAngleX",
  );
  assert.equal(headParameter?.keyframes?.length, 3);
  assert.equal(headParameter?.keyframes?.[1].input_value, 50);
}

function testV4MotionSequenceRejectsTrapezoidalTransitionBudgetOverflow(): void {
  const profile = buildProfile();
  const headYaw = profile.axes.find((axis) => axis.id === "head_yaw");
  assert.ok(headYaw);
  headYaw.level_anchors = {
    "-3": 30, "-2": 38, "-1": 45, "0": 50, "1": 56, "2": 64, "3": 70,
  };
  headYaw.dynamics.max_velocity = 50;
  headYaw.dynamics.max_acceleration = 500;
  const intent = buildLevelIntent() as NormalizedSemanticMotionIntentV4;
  delete (intent as { axis_levels?: unknown }).axis_levels;
  (intent as { motion_steps: unknown }).motion_steps = [
    { axis_levels: { head_yaw: -3 }, duration_weight: 1 },
    { axis_levels: { head_yaw: 3 }, duration_weight: 1 },
  ];

  const result = compileMotionIntent(intent, {
    model: buildModel(profile),
    targetDurationMs: 1400,
    samplingIdentity,
    settings: { motionIntensityScale: 1, axisIntensityScale: {} },
  });

  assert.equal(result.ok, false);
  assert.equal(result.feedback?.code, "motion_sequence_transition_budget_exceeded");
  assert.match(result.reason, /^motion_sequence_transition_budget_exceeded:1:/);
}

function testParameterDynamicsLimitsAccelerationDuringTargetReversal(): void {
  const deltaSeconds = 1 / 60;
  const maxAcceleration = 12;
  let value = 0;
  let velocity = 0;
  for (let index = 0; index < 30; index += 1) {
    const next = advanceParameterDynamics(
      value,
      10,
      velocity,
      deltaSeconds,
      4,
      maxAcceleration,
      -20,
      20,
    );
    assert.ok(Math.abs(next.velocity - velocity) <= maxAcceleration * deltaSeconds + 1e-9);
    value = next.value;
    velocity = next.velocity;
  }

  const beforeReverseValue = value;
  const beforeReverseVelocity = velocity;
  const reversed = advanceParameterDynamics(
    value,
    -10,
    velocity,
    deltaSeconds,
    4,
    maxAcceleration,
    -20,
    20,
  );
  assert.ok(reversed.value > -10);
  assert.ok(reversed.value >= beforeReverseValue);
  assert.ok(
    Math.abs(reversed.velocity - beforeReverseVelocity)
      <= maxAcceleration * deltaSeconds + 1e-9,
  );
}

function testParameterDynamicsStopsAtTargetWithoutOvershoot(): void {
  const next = advanceParameterDynamics(
    0.99,
    1,
    2,
    1 / 60,
    4,
    12,
    -20,
    20,
  );

  assert.deepEqual(next, { value: 1, velocity: 0 });
}

function testParameterPlanRequiresNeutralTargetAndDynamics(): void {
  const profile = buildProfile();
  const headYaw = profile.axes.find((axis) => axis.id === "head_yaw");
  assert.ok(headYaw);
  headYaw.level_anchors = {
    "-3": 30, "-2": 38, "-1": 45, "0": 50, "1": 56, "2": 64, "3": 70,
  };
  const result = compileMotionIntent(buildLevelIntent(), {
    model: buildModel(profile),
    samplingIdentity,
  });
  assert.equal(result.ok, true);
  assert.ok(result.plan);

  const missingNeutral = JSON.parse(JSON.stringify(result.plan)) as Record<string, unknown> & {
    parameters: Array<Record<string, unknown>>;
  };
  delete missingNeutral.parameters[0].neutral_target_value;
  const neutralResult = parseSemanticParameterPlan(missingNeutral);
  assert.equal(neutralResult.ok, false);
  assert.equal(
    neutralResult.ok ? "" : neutralResult.reason,
    "parameter_plan_v2.neutral_target_value_not_number",
  );

  const missingDynamics = JSON.parse(JSON.stringify(result.plan)) as Record<string, unknown> & {
    parameters: Array<Record<string, unknown>>;
  };
  delete missingDynamics.parameters[0].dynamics;
  const dynamicsResult = parseSemanticParameterPlan(missingDynamics);
  assert.equal(dynamicsResult.ok, false);
  assert.equal(
    dynamicsResult.ok ? "" : dynamicsResult.reason,
    "parameter_plan_v2.invalid_dynamics",
  );

  const missingSource = JSON.parse(JSON.stringify(result.plan)) as Record<string, unknown> & {
    parameters: Array<Record<string, unknown>>;
  };
  delete missingSource.parameters[0].source;
  const sourceResult = parseSemanticParameterPlan(missingSource);
  assert.equal(sourceResult.ok, false);
  assert.equal(
    sourceResult.ok ? "" : sourceResult.reason,
    "parameter_plan_v2.invalid_parameter_source",
  );

  const planWithSpeechModulation = JSON.parse(JSON.stringify(result.plan)) as Record<string, unknown> & {
    parameters: Array<Record<string, unknown>>;
  };
  planWithSpeechModulation.parameters[0].modulation = {
    kind: "speech_pose_cycle",
    neutral: 0,
    amplitude: 1,
    phase: 0,
  };
  const modulationResult = parseSemanticParameterPlan(planWithSpeechModulation);
  assert.equal(modulationResult.ok, false);
  assert.equal(
    modulationResult.ok ? "" : modulationResult.reason,
    "parameter_plan_v2.invalid_modulation",
  );
}

function testV4AxisLevelsRejectUnknownAxesAndMissingAnchors(): void {
  const profile = buildProfile();
  const unknownResult = compileMotionIntent(buildLevelIntent({
    axis_levels: { unknown_axis: 1 },
  }), {
    model: buildModel(profile),
    samplingIdentity,
  });
  assert.equal(unknownResult.ok, false);
  assert.equal(
    unknownResult.reason,
    "semantic_axis_validation_failed:unknown_axis",
  );

  const missingAnchorResult = compileMotionIntent(buildLevelIntent(), {
    model: buildModel(profile),
    samplingIdentity,
  });
  assert.equal(missingAnchorResult.ok, false);
  assert.equal(
    missingAnchorResult.diagnostics.warnings?.includes(
      "semantic_axis_level_anchor_missing:head_yaw:2",
    ),
    true,
  );
}

function buildModelWithExpressionResource(
  profile: SemanticAxisProfile,
  parameterIds: string[],
): ModelSummary {
  const model = buildModel(profile);
  model.constraints.expressions = [{
    name: "Smile",
    file: "Expressions/Smile.exp3.json",
    catalog_id: "expression.smile",
    catalog_expose_as_resource: true,
    category: "positive",
    parameter_ids: parameterIds,
    parameter_count: parameterIds.length,
    affects_channels: ["head_roll"],
    parameters: [],
    dominant_parameters: [],
    dominant_domains: [],
    dominant_channels: [],
    blend_modes: [],
    intensity: "low",
    touches_non_expression_parameters: false,
  }];
  return model;
}

function buildModelWithMotionResource(profile: SemanticAxisProfile): ModelSummary {
  const model = buildModel(profile);
  model.constraints.motions = [{
    name: "SeriousExplain",
    file: "Motions/serious.motion3.json",
    catalog_id: "motion.serious_explain",
    catalog_expose_as_resource: true,
    group: "TapBody",
    category: "explain",
    duration: 1.8,
    catalog_label: "认真说明",
    catalog_intensity: "medium",
    component_ids: ["component-head-yaw"],
    driver_component_ids: ["component-head-yaw"],
  } as unknown as ModelSummary["constraints"]["motions"][number]];
  model.motion_resource_pool.components = [{
    id: "component-head-yaw",
    parameter_id: "ParamAngleX",
  } as unknown as ModelSummary["motion_resource_pool"]["components"][number]];
  return model;
}

function testCompiledPlanResolvesExpressionResourceForPlayback(): void {
  const result = compileMotionIntent(buildIntent({
    resource_id: "expression.smile",
  }), {
    model: buildModelWithExpressionResource(buildProfile(), ["ParamAngleZ"]),
    targetDurationMs: 1200,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.plan?.resource, {
    kind: "expression",
    resource_id: "expression.smile",
    expression_id: "Smile",
    parameter_ids: ["ParamAngleZ"],
  });
  assert.equal(
    result.diagnostics.transformTrace?.transformVersion,
    "semantic_motion_transform.v4",
  );
  assert.equal(result.diagnostics.transformTrace?.profileRevision, 1);
  assert.equal(result.diagnostics.transformTrace?.profileHash, "hash");
  assert.deepEqual(result.diagnostics.transformTrace?.resolvedResource, {
    resourceId: "expression.smile",
    resourceType: "expression",
    parameterIds: ["ParamAngleZ"],
  });
}

function testResourcePolicyRejectsUnknownResource(): void {
  const result = compileMotionIntent(buildIntent({
    resource_id: "expression.missing",
  }), {
    model: buildModel(buildProfile()),
    targetDurationMs: 1200,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "resource_not_found:expression.missing");
}

function testResourcePolicyRejectsParameterConflict(): void {
  const result = compileMotionIntent(buildIntent({
    resource_id: "expression.smile",
  }), {
    model: buildModelWithExpressionResource(buildProfile(), ["ParamMouthForm"]),
    targetDurationMs: 1200,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    "resource_parameter_conflict:expression.smile:ParamMouthForm",
  );
}

function testMotionResourceUsesCatalogPlaybackInsteadOfDirectPlan(): void {
  const profile = buildProfile();
  const headYaw = profile.axes.find((axis) => axis.id === "head_yaw");
  assert.ok(headYaw);
  headYaw.level_anchors = {
    "-3": 30, "-2": 38, "-1": 45, "0": 50, "1": 56, "2": 64, "3": 70,
  };
  const model = buildModelWithMotionResource(profile);
  let directPlanStarts = 0;
  const catalogMotions: Array<{ motion_id: string; group: string; index: number }> = [];
  const started = startNormalizedMotionPayload(
    {
      kind: "semantic_intent",
      intent: buildLevelIntent({ motion_resource_id: "motion.serious_explain" }),
    },
    {
      messageId: "msg-motion-resource",
      turnId: "turn-motion-resource",
      playbackTurnId: "turn-motion-resource",
      playbackOrigin: "conversation",
      startReason: "playback_timeline_started",
      queuedDelayMs: 90,
    },
    {
      getSelectedModel: () => model,
      getSettings: () => ({ motionIntensityScale: 1, axisIntensityScale: {} }),
      playPlan: () => {
        directPlanStarts += 1;
        return true;
      },
      playCatalogMotion: (motion, _model, options) => {
        catalogMotions.push(motion);
        options.onStarted(motion, "run-motion-resource");
        return true;
      },
      getPlayerMessage: () => "motion resource playing",
      onPlanStarted: ignorePlanStarted,
    },
    {
      setState: () => {},
      setLastCompileReason: () => {},
      setLastCompileDiagnostics: () => {},
      setLastStartReason: () => {},
      pushHistory: () => {},
    },
  );

  assert.equal(started, true);
  assert.equal(directPlanStarts, 0);
  assert.deepEqual(catalogMotions, [{
    schema_version: "engine.catalog_motion.v1",
    model_id: "model-1",
    motion_id: "motion.serious_explain",
    group: "TapBody",
    index: 0,
    file: "Motions/serious.motion3.json",
    label: "认真说明",
    emotion_label: "认真说明",
    duration_ms: 1800,
    priority: 3,
    summary: { source: "semantic_motion_resource" },
  }]);
}

function testNormalizeMotionPayloadAcceptsPerformanceCurveHint(): void {
  const result = normalizeMotionPayload({
    schema_version: "engine.motion_intent.v3",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    intent_tags: ["happy", "preview"],
    emotion_label: "happy",
    duration_hint_ms: 1000,
    performance_curve_hint: {
      schema_version: "ag99.performance_curve_hint.v1",
      curve_family: "quick_in_hold_soft_out",
      entry: "quick",
      hold: "steady",
      exit: "soft",
      emphasis: "early",
      energy: "medium",
    },
    axes: {
      head_yaw: 62,
      mouth_smile: 84,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.kind, "semantic_intent");
  assert.equal(result.payload.intent.performance_curve_hint?.curve_family, "quick_in_hold_soft_out");
}

function testNormalizeMotionPayloadRejectsInvalidPerformanceCurveHint(): void {
  const result = normalizeMotionPayload({
    schema_version: "engine.motion_intent.v3",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    intent_tags: ["happy"],
    emotion_label: "happy",
    performance_curve_hint: {
      schema_version: "ag99.performance_curve_hint.v1",
      curve_family: "not-a-curve",
      entry: "quick",
      hold: "steady",
      exit: "soft",
      emphasis: "early",
      energy: "medium",
    },
    axes: { head_yaw: 62 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "motion_intent.performance_curve_hint_invalid");
}

function testNormalizeMotionPayloadRejectsV3NestedAxes(): void {
  const result = normalizeMotionPayload({
    schema_version: "engine.motion_intent.v3",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    emotion_label: "happy",
    duration_hint_ms: 1000,
    axes: {
      head_yaw: { value: 62 },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "motion_intent_v3.invalid_flat_axes");
}

function testMotionStartRejectsPlayerThatOmitsStartedCallback(): void {
  const profile = buildProfile();
  const model = buildModel(profile);
  const compileResult = compileMotionIntent(buildIntent(), {
    model,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });
  assert.equal(compileResult.ok, true);
  assert.ok(compileResult.plan);

  const startedEvents: ModelEnginePlanStartedEvent[] = [];
  const stateChanges: Array<{ status: string; message: string }> = [];
  const started = startNormalizedMotionPayload(
    {
      kind: "semantic_plan",
      plan: compileResult.plan,
    },
    {
      messageId: "msg-plan",
      turnId: "turn-plan",
      playbackTurnId: "turn-plan",
      playbackOrigin: "conversation",
      startReason: "test",
      queuedDelayMs: 0,
    },
    {
      getSelectedModel: () => model,
      getSettings: () => ({
        motionIntensityScale: 1,
        axisIntensityScale: {},
      }),
      playPlan: (_plan, _model, _options) => true,
      playCatalogMotion: () => false,
      getPlayerMessage: () => "playing without callback",
      onPlanStarted: (event) => {
        startedEvents.push(event);
      },
    },
    {
      setState: (status, message) => {
        stateChanges.push({ status, message });
      },
      setLastCompileReason: () => {},
      setLastCompileDiagnostics: () => {},
      setLastStartReason: () => {},
      pushHistory: () => {},
    },
  );

  assert.equal(started, false);
  assert.equal(startedEvents.length, 0);
  assert.deepEqual(stateChanges.at(-1), {
    status: "failed",
    message: "motion_player_started_without_run_id",
  });
}

function testMotionStartUsesPlaybackTimelineDuration(): void {
  const profile = buildProfile();
  const model = buildModel(profile);
  const playedPlans: MotionPlanPayload[] = [];
  const payload = {
    kind: "semantic_intent" as const,
    intent: buildIntent({
      performance_curve_hint: {
        schema_version: "ag99.performance_curve_hint.v1" as const,
        curve_family: "quick_in_hold_soft_out" as const,
        entry: "quick" as const,
        hold: "steady" as const,
        exit: "soft" as const,
        emphasis: "early" as const,
        energy: "medium" as const,
      },
    }),
  };
  const dependencies = {
    getSelectedModel: () => model,
    getSettings: () => ({
      motionIntensityScale: 1,
      axisIntensityScale: {},
    }),
    playPlan: (plan: unknown, _model: ModelSummary | null, options: {
      onStarted: (plan: MotionPlanPayload, runId: string) => void;
    }) => {
      playedPlans.push(plan as MotionPlanPayload);
      options.onStarted(plan as MotionPlanPayload, "run-timeline-duration");
      return true;
    },
    playCatalogMotion: () => false,
    getPlayerMessage: () => "timeline duration applied",
    onPlanStarted: ignorePlanStarted,
  };
  const state = {
    setState: () => {},
    setLastCompileReason: () => {},
    setLastCompileDiagnostics: () => {},
    setLastStartReason: () => {},
    pushHistory: () => {},
  };
  const prepared = prepareSemanticMotionPayload(
    payload,
    {
      messageId: "msg-timeline",
      turnId: "turn-timeline",
      playbackTurnId: "turn-timeline",
      playbackOrigin: "conversation",
      startReason: "playback_timeline_preparing",
      queuedDelayMs: 0,
      playbackClock: {
        timelineId: "timeline-1",
        turnId: "turn-timeline",
        messageId: "msg-timeline",
        phase: "ready",
        source: "audio",
        startedAtMs: null,
        currentTimeMs: 0,
        durationMs: 2400,
      },
    },
    dependencies,
    state,
  );
  assert.ok(prepared);
  const started = startNormalizedMotionPayload(
    payload,
    {
      messageId: "msg-timeline",
      turnId: "turn-timeline",
      playbackTurnId: "turn-timeline",
      playbackOrigin: "conversation",
      startReason: "playback_timeline_started",
      queuedDelayMs: 0,
      playbackClock: {
        timelineId: "timeline-1",
        turnId: "turn-timeline",
        messageId: "msg-timeline",
        phase: "playing",
        source: "audio",
        startedAtMs: 100,
        currentTimeMs: 0,
        durationMs: 2400,
      },
    },
    dependencies,
    state,
    prepared,
  );

  assert.equal(started, true);
  const playedPlan = playedPlans[0];
  assert.ok(playedPlan);
  assert.equal(playedPlan?.timing.duration_ms, 2400);
  assert.deepEqual(playedPlan?.timing, {
    duration_ms: 2400,
    blend_in_ms: 240,
    hold_ms: 1632,
    blend_out_ms: 528,
    curve_preset: "snap_hold_soft_release",
  });
}

function testMotionStartRejectsAudioUnavailableTimelineForTiming(): void {
  const profile = buildProfile();
  const model = buildModel(profile);
  const playedPlans: MotionPlanPayload[] = [];

  const started = startNormalizedMotionPayload(
    {
      kind: "semantic_intent",
      intent: buildIntent(),
    },
    {
      messageId: "msg-audio-unavailable",
      turnId: "turn-audio-unavailable",
      playbackTurnId: "turn-audio-unavailable",
      playbackOrigin: "conversation",
      startReason: "playback_timeline_started",
      queuedDelayMs: 0,
      playbackClock: {
        timelineId: "timeline-audio-unavailable",
        turnId: "turn-audio-unavailable",
        messageId: "msg-audio-unavailable",
        phase: "playing",
        source: "audio_unavailable",
        startedAtMs: 100,
        currentTimeMs: 300,
        durationMs: 2400,
      },
    },
    {
      getSelectedModel: () => model,
      getSettings: () => ({
        motionIntensityScale: 1,
        axisIntensityScale: {},
      }),
      playPlan: (plan, _model, options) => {
        playedPlans.push(plan as MotionPlanPayload);
        options.onStarted(plan as MotionPlanPayload, "run-audio-unavailable");
        return true;
      },
      playCatalogMotion: () => false,
      getPlayerMessage: () => "audio unavailable timeline rejected",
      onPlanStarted: ignorePlanStarted,
    },
    {
      setState: () => {},
      setLastCompileReason: () => {},
      setLastCompileDiagnostics: () => {},
      setLastStartReason: () => {},
      pushHistory: () => {},
    },
  );

  assert.equal(started, true);
  assert.equal(playedPlans.length, 1);
  assert.equal(playedPlans[0].timing.duration_ms, 1200);
}

function testPerformanceCurveIsSkippedWhenAudioTimelineIsUnavailable(): void {
  const profile = buildProfile();
  const model = buildModel(profile);
  const playedPlans: MotionPlanPayload[] = [];
  const diagnostics: CompileDiagnostics[] = [];
  let lastCompileReason = "";

  const started = startNormalizedMotionPayload(
    {
      kind: "semantic_intent",
      intent: buildIntent({
        performance_curve_hint: {
          schema_version: "ag99.performance_curve_hint.v1",
          curve_family: "quick_in_hold_soft_out",
          entry: "quick",
          hold: "steady",
          exit: "soft",
          emphasis: "early",
          energy: "medium",
        },
      }),
    },
    {
      messageId: "msg-curve-unavailable",
      turnId: "turn-curve-unavailable",
      playbackTurnId: "turn-curve-unavailable",
      playbackOrigin: "conversation",
      startReason: "playback_timeline_started",
      queuedDelayMs: 0,
      playbackClock: {
        timelineId: "timeline-curve-unavailable",
        turnId: "turn-curve-unavailable",
        messageId: "msg-curve-unavailable",
        phase: "playing",
        source: "audio_unavailable",
        startedAtMs: 100,
        currentTimeMs: 300,
        durationMs: 2400,
      },
    },
    {
      getSelectedModel: () => model,
      getSettings: () => ({
        motionIntensityScale: 1,
        axisIntensityScale: {},
      }),
      playPlan: (plan, _model, options) => {
        playedPlans.push(plan as MotionPlanPayload);
        options.onStarted(plan as MotionPlanPayload, "run-curve-skipped");
        return true;
      },
      playCatalogMotion: () => false,
      getPlayerMessage: () => "performance curve skipped",
      onPlanStarted: ignorePlanStarted,
    },
    {
      setState: () => {},
      setLastCompileReason: (reason) => {
        lastCompileReason = reason;
      },
      setLastCompileDiagnostics: (nextDiagnostics) => {
        if (nextDiagnostics) {
          diagnostics.push(nextDiagnostics);
        }
      },
      setLastStartReason: () => {},
      pushHistory: () => {},
    },
  );

  assert.equal(started, true);
  assert.equal(playedPlans.length, 1);
  assert.notEqual(
    lastCompileReason,
    "performance_curve_timeline_unavailable:playback_timeline_audio_unavailable",
  );
  assert.equal(diagnostics.length, 1);
  assert.ok(
    diagnostics[0].warnings?.includes(
      "performance_curve_skipped:playback_timeline_audio_unavailable",
    ),
  );
}

function testAxisIntensityScaleAffectsOnlyTargetAxis(): void {
  const profile = buildProfile();
  const baseline = compileMotionIntent(buildIntent({
    axes: {
      mouth_smile: 60,
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
      mouth_smile: 60,
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
  assert.equal(baseline.diagnostics.intensityApplied, false);
  assert.equal(scaled.diagnostics.intensityApplied, true);
}

function testAxisRangeConstraintIsOwnedByRelationGraph(): void {
  const result = compileMotionIntent(buildIntent({
    axes: {
      mouth_smile: 60,
    },
  }), {
    model: buildModel(buildProfile()),
    settings: {
      motionIntensityScale: 2.5,
      axisIntensityScale: {
        mouth_smile: 2.5,
      },
    },
  });

  assert.equal(result.ok, true);
  const smile = result.plan?.parameters.find(
    (item) => item.parameter_id === "ParamMouthForm",
  );
  assert.ok(smile);
  assert.equal(smile?.input_value, 100);
  assert.equal(
    result.diagnostics.relationAdjustments?.some(
      (item) => item.ruleId === "axis_value_range:mouth_smile"
        && item.reason === "axis_value_range_limit"
        && item.before === 112.5
        && item.after === 100,
    ),
    true,
  );
}

function testRevisionMismatchRejectsCompile(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
    profile_revision: profile.revision + 2,
  }), {
    model: buildModel(profile),
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    `semantic_profile_revision_mismatch:${profile.revision + 2}:${profile.revision}`,
  );
}

function testCompileRejectsInvalidAxesInsteadOfSalvaging(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
    axes: {
      unknown_a: 60,
      unknown_b: 61,
      unknown_c: 62,
      mouth_smile: 68,
    },
  }), {
    model: buildModel(profile),
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.plan, null);
  assert.equal(result.feedback?.code.startsWith("semantic_axis_validation_failed:"), true);
  assert.equal(
    result.diagnostics.warnings?.includes("semantic_axis_ignored_unknown:unknown_a"),
    true,
  );
  assert.equal(
    result.diagnostics.invalidAxes?.length,
    3,
  );
}

function testCompileRejectsAllNeutralSemanticAxes(): void {
  const result = compileMotionIntent(buildIntent({
    axes: {
      head_yaw: 50,
      mouth_smile: 50,
    },
  }), {
    model: buildModel(buildProfile()),
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "semantic_axes_all_neutral");
  assert.equal(result.feedback?.code, "semantic_axes_all_neutral");
}

function testCompileRejectsInvalidBindingsInsteadOfSkippingThem(): void {
  const profile = buildProfile();
  profile.axes.find((axis) => axis.id === "head_yaw")?.parameter_bindings.push({
    parameter_id: "ParamBroken",
    input_range: [50, 50],
    output_range: [-1, 1],
    default_weight: 1,
    invert: false,
  });
  const result = compileMotionIntent(buildIntent({
    axes: {
      head_yaw: 80,
    },
  }), {
    model: buildModel(profile),
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.plan, null);
  assert.equal(
    result.reason,
    "binding_input_range_zero:head_yaw:ParamBroken",
  );
  assert.equal(
    result.feedback?.code,
    "binding_input_range_zero:head_yaw:ParamBroken",
  );
}

function testCompileRejectsBindingInputRangeMismatch(): void {
  const profile = buildProfile();
  const headYaw = profile.axes.find((axis) => axis.id === "head_yaw");
  assert.ok(headYaw);
  headYaw!.parameter_bindings[0].input_range = [0, 60];

  const result = compileMotionIntent(buildIntent({
    axes: {
      head_yaw: 80,
    },
  }), {
    model: buildModel(profile),
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    "binding_input_value_out_of_range:head_yaw:ParamAngleX",
  );
  assert.equal(
    result.feedback?.code,
    "binding_input_value_out_of_range:head_yaw:ParamAngleX",
  );
}

function testSpeechPoseRequiresExplicitVoiceFollowingProfile(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
    mode: "idle",
    axes: {},
  }), {
    model: buildModel(profile),
    targetDurationMs: 5000,
    speechActive: true,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "semantic_plan_parameters_empty");
}

function testSpeechPoseUsesVoiceFollowingProfileBeforeDerivedAxes(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
    mode: "idle",
    intent_tags: ["explain"],
    axes: {},
    performance_curve_hint: {
      schema_version: "ag99.performance_curve_hint.v1",
      curve_family: "soft_breathe",
      entry: "soft",
      hold: "breathing",
      exit: "soft",
      emphasis: "none",
      energy: "calm",
    },
  }), {
    model: buildModelWithVoiceFollowingProfile(profile),
    targetDurationMs: 5000,
    speechActive: true,
    samplingIdentity,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.plan);
  const headRoll = result.plan?.parameters.find((item) => item.parameter_id === "ParamAngleZ");
  const headPitch = result.plan?.parameters.find((item) => item.parameter_id === "ParamAngleY");
  const bodyRoll = result.plan?.parameters.find((item) => item.parameter_id === "ParamBodyAngleZ");
  const legacySpeechAxis = result.plan?.parameters.find(
    (item) => item.parameter_id === "ParamSpeechHeadSway",
  );

  assert.ok(headRoll);
  assert.ok(headPitch);
  assert.ok(bodyRoll);
  assert.equal(headRoll?.source, "speech_pose");
  assert.equal(headPitch?.source, "speech_pose");
  assert.equal(bodyRoll?.source, "speech_pose");
  assert.equal(headRoll?.input_value, 0);
  assert.equal(headPitch?.input_value, 0);
  assert.equal(bodyRoll?.input_value, 0);
  assert.equal(headRoll?.axis_id, "voice_following.head_roll");
  assert.equal(headRoll?.modulation?.kind, "speech_gesture_track");
  assert.equal(headRoll?.modulation?.preset, "gentle_support");
  assert.equal(headRoll?.modulation?.amplitude, 2.8 * 0.75);
  assert.equal(headRoll?.modulation?.delay_ms, 0);
  assert.equal(headRoll?.modulation?.direction, 1);
  assert.equal(headRoll?.modulation?.points[0].value, 0);
  assert.equal(headRoll?.modulation?.points.at(-1)?.value, 0);
  assert.ok((headRoll?.modulation?.points.length ?? 0) >= 4);
  assert.equal(headPitch?.modulation?.kind, "speech_gesture_track");
  assert.equal(bodyRoll?.modulation?.delay_ms, 180);
  assert.ok((headPitch?.weight ?? 1) < (headRoll?.weight ?? 0));
  assert.equal(legacySpeechAxis, undefined);
  assert.equal(
    result.diagnostics.warnings?.includes("speech_pose_applied:ParamAngleZ"),
    true,
  );
}

function testSpeechGestureTracksAreDeterministicAndTimelineBounded(): void {
  const profile = buildProfile();
  const model = buildModelWithVoiceFollowingProfile(profile);
  const compile = (messageId: string) => compileMotionIntent(buildIntent({
    mode: "idle",
    intent_tags: [],
    axes: {},
    duration_hint_ms: 2400,
  }), {
    model,
    targetDurationMs: 2400,
    speechActive: true,
    samplingIdentity: { turnId: "turn-deterministic", messageId },
    settings: { motionIntensityScale: 1, axisIntensityScale: {} },
  });

  const first = compile("message-same");
  const repeated = compile("message-same");
  assert.equal(first.ok, true);
  assert.equal(repeated.ok, true);
  assert.deepEqual(first.plan?.parameters, repeated.plan?.parameters);

  const signatures = new Set<string>();
  for (let index = 0; index < 12; index += 1) {
    const result = compile(`message-${index}`);
    assert.equal(result.ok, true);
    signatures.add(JSON.stringify(
      result.plan?.parameters.map((parameter) => ({
        axis: parameter.axis_id,
        preset: parameter.modulation?.preset,
        direction: parameter.modulation?.points[1]?.value,
      })),
    ));
    for (const parameter of result.plan?.parameters ?? []) {
      const modulation = parameter.modulation;
      if (!modulation) continue;
      let previousEndMs = -1;
      for (const point of modulation.points) {
        assert.ok(point.at_ms >= previousEndMs);
        previousEndMs = point.at_ms + point.transition_ms;
      }
      assert.ok(previousEndMs + modulation.delay_ms <= (result.plan?.timing.duration_ms ?? 0));
    }
  }
  assert.ok(signatures.size > 1);
}

function testSpeechGesturePresetSelectionUsesSemanticHints(): void {
  const profile = buildProfile();
  const model = buildModelWithVoiceFollowingProfile(profile);
  const cases: Array<{
    intent: Partial<NormalizedSemanticMotionIntentV3>;
    expected: string;
  }> = [
    {
      intent: {
        performance_curve_hint: {
          schema_version: "ag99.performance_curve_hint.v1",
          curve_family: "pulse_then_settle",
          entry: "quick",
          hold: "steady",
          exit: "soft",
          emphasis: "early",
          energy: "high",
        },
      },
      expected: "emphatic",
    },
    {
      intent: {
        performance_curve_hint: {
          schema_version: "ag99.performance_curve_hint.v1",
          curve_family: "soft_breathe",
          entry: "soft",
          hold: "breathing",
          exit: "soft",
          emphasis: "none",
          energy: "calm",
        },
      },
      expected: "gentle_support",
    },
    {
      intent: {
        performance_curve_hint: {
          schema_version: "ag99.performance_curve_hint.v1",
          curve_family: "quick_in_hold_soft_out",
          entry: "quick",
          hold: "steady",
          exit: "soft",
          emphasis: "early",
          energy: "teasing",
        },
      },
      expected: "lively_chat",
    },
    { intent: { intent_tags: ["解释", "认真"] }, expected: "calm_explain" },
  ];

  for (const [index, testCase] of cases.entries()) {
    const result = compileMotionIntent(buildIntent({
      mode: "idle",
      axes: {},
      duration_hint_ms: 2400,
      ...testCase.intent,
    }), {
      model,
      targetDurationMs: 2400,
      speechActive: true,
      samplingIdentity: { turnId: "turn-preset", messageId: `message-${index}` },
      settings: { motionIntensityScale: 1, axisIntensityScale: {} },
    });
    assert.equal(result.ok, true);
    const modulations = (result.plan?.parameters ?? [])
      .map((parameter) => parameter.modulation)
      .filter(Boolean);
    assert.ok(modulations.length >= 2);
    assert.equal(modulations.every((modulation) => modulation?.preset === testCase.expected), true);
    const headDelay = Math.min(...(result.plan?.parameters ?? [])
      .filter((parameter) => parameter.axis_id.startsWith("voice_following.head_"))
      .map((parameter) => parameter.modulation?.delay_ms ?? 0));
    const bodyDelays = (result.plan?.parameters ?? [])
      .filter((parameter) => parameter.axis_id.startsWith("voice_following.body_"))
      .map((parameter) => parameter.modulation?.delay_ms ?? 0);
    if (bodyDelays.length > 0) {
      assert.ok(bodyDelays.every((delay) => delay > headDelay));
    }
  }
}

function testSpeechGestureUsesAvailableChannelsForSparseModel(): void {
  const profile = buildProfile();
  const model = buildModelWithVoiceFollowingProfile(profile);
  const headYaw = model.voice_following_profile?.channels.head_yaw;
  assert.ok(headYaw);
  model.voice_following_profile = {
    ...model.voice_following_profile!,
    channels: { head_yaw: headYaw },
  };

  const result = compileMotionIntent(buildIntent({
    mode: "idle",
    axes: {},
    performance_curve_hint: {
      schema_version: "ag99.performance_curve_hint.v1",
      curve_family: "soft_breathe",
      entry: "soft",
      hold: "breathing",
      exit: "soft",
      emphasis: "none",
      energy: "calm",
    },
  }), {
    model,
    targetDurationMs: 1800,
    speechActive: true,
    samplingIdentity,
    settings: { motionIntensityScale: 1, axisIntensityScale: {} },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.plan?.parameters.map((parameter) => parameter.parameter_id), ["ParamAngleX"]);
  assert.equal(result.plan?.parameters[0]?.modulation?.preset, "gentle_support");
}

function testSpeechGestureSkipsDelayedBodyChannelsForShortAudio(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
    mode: "idle",
    axes: {},
  }), {
    model: buildModelWithVoiceFollowingProfile(profile),
    targetDurationMs: 320,
    speechActive: true,
    samplingIdentity,
    settings: { motionIntensityScale: 1, axisIntensityScale: {} },
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan?.timing.duration_ms, 320);
  assert.equal(
    result.plan?.parameters.some((parameter) => parameter.axis_id.startsWith("voice_following.body_")),
    false,
  );
  for (const parameter of result.plan?.parameters ?? []) {
    const modulation = parameter.modulation;
    assert.ok(modulation);
    const last = modulation?.points.at(-1);
    assert.ok(last);
    assert.ok((last?.at_ms ?? 0) + (last?.transition_ms ?? 0) + (modulation?.delay_ms ?? 0) <= 320);
  }
}

function testPerformanceCurveHintAdjustsExpressiveTiming(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
    performance_curve_hint: {
      schema_version: "ag99.performance_curve_hint.v1",
      curve_family: "quick_in_hold_soft_out",
      entry: "quick",
      hold: "steady",
      exit: "soft",
      emphasis: "early",
      energy: "medium",
    },
  }), {
    model: buildModel(profile),
    targetDurationMs: 2400,
    speechActive: true,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.plan);
  assert.deepEqual(result.plan?.timing, {
    duration_ms: 2400,
    blend_in_ms: 240,
    hold_ms: 1632,
    blend_out_ms: 528,
    curve_preset: "snap_hold_soft_release",
  });
  assert.equal(
    result.diagnostics.warnings?.includes("performance_curve_applied:quick_in_hold_soft_out"),
    true,
  );
  assert.equal(
    result.diagnostics.warnings?.includes("performance_curve_preset:snap_hold_soft_release"),
    true,
  );
}

function testPerformanceCurveHintAdjustsSpeechIdleTiming(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
    mode: "idle",
    axes: {},
    performance_curve_hint: {
      schema_version: "ag99.performance_curve_hint.v1",
      curve_family: "quick_in_hold_soft_out",
      entry: "quick",
      hold: "steady",
      exit: "soft",
      emphasis: "early",
      energy: "medium",
    },
  }), {
    model: buildModelWithVoiceFollowingProfile(profile),
    targetDurationMs: 2400,
    speechActive: true,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.plan);
  assert.deepEqual(result.plan?.timing, {
    duration_ms: 2400,
    blend_in_ms: 240,
    hold_ms: 1632,
    blend_out_ms: 528,
    curve_preset: "snap_hold_soft_release",
  });
  assert.equal(
    result.diagnostics.warnings?.includes("performance_curve_applied:quick_in_hold_soft_out"),
    true,
  );
  assert.equal(
    result.diagnostics.warnings?.includes("performance_curve_preset:snap_hold_soft_release"),
    true,
  );
}

function testSpeechOnlyPayloadUsesSelectedModelProfile(): void {
  const profile = buildProfile();
  const request = buildSpeechOnlyMotionRequest(
    buildModelWithVoiceFollowingProfile(profile),
  );

  assert.deepEqual(request, {
    kind: "speech_only",
    profileId: profile.profile_id,
    profileRevision: profile.revision,
    modelId: profile.model_id,
  });
}

function testSpeechOnlyPayloadRequiresVoiceFollowingProfile(): void {
  const profile = buildProfile();

  assert.equal(buildSpeechOnlyMotionRequest(buildModel(profile)), null);
  assert.equal(buildSpeechOnlyMotionRequest(null), null);
}

function testSpeechOnlyPlaybackUsesTimelineDuration(): void {
  const profile = buildProfile();
  const model = buildModelWithVoiceFollowingProfile(profile);
  const playedPlans: MotionPlanPayload[] = [];
  const engine = useModelEngine({
    getSelectedModel: () => model,
    getSettings: () => ({
      motionIntensityScale: 1,
      axisIntensityScale: {},
    }),
    playPlan: (plan, _model, options) => {
      playedPlans.push(plan as MotionPlanPayload);
      options.onStarted(plan as MotionPlanPayload, "run-speech-only");
      return true;
    },
    playCatalogMotion: () => false,
    stopPlan: () => {},
    onMotionRejected: () => {},
    canStartSpeechOnlyMotion: () => true,
    onPlanStarted: ignorePlanStarted,
  });

  const prepared = engine.preparePlaybackTimeline({
    timelineId: "timeline-speech",
    turnId: "turn-speech",
    messageId: "msg-speech",
    phase: "ready",
    source: "audio",
    startedAtMs: null,
    currentTimeMs: 0,
    durationMs: 2250,
  });
  assert.deepEqual(prepared, { status: "prepared", source: "speech_only" });
  const started = engine.handlePlaybackTimelineStarted({
    timelineId: "timeline-speech",
    turnId: "turn-speech",
    messageId: "msg-speech",
    phase: "playing",
    source: "audio",
    startedAtMs: 100,
    currentTimeMs: 0,
    durationMs: 2250,
  });

  assert.equal(started, true);
  const plan = playedPlans[0];
  assert.ok(plan);
  assert.equal(plan.mode, "idle");
  assert.equal(plan.timing.duration_ms, 2250);
  assert.equal(
    plan.parameters.some((item) => item.source === "speech_pose"),
    true,
  );
}

function testSpeechOnlyPreparationAcceptsPendingAudioClock(): void {
  const profile = buildProfile();
  const engine = useModelEngine({
    getSelectedModel: () => buildModelWithVoiceFollowingProfile(profile),
    getSettings: () => ({ motionIntensityScale: 1, axisIntensityScale: {} }),
    playPlan: () => true,
    playCatalogMotion: () => false,
    stopPlan: () => {},
    onMotionRejected: () => {},
    canStartSpeechOnlyMotion: () => true,
    onPlanStarted: ignorePlanStarted,
  });

  assert.deepEqual(
    engine.preparePlaybackTimeline({
      timelineId: "timeline-pending-audio",
      turnId: "turn-pending-audio",
      messageId: "msg-pending-audio",
      phase: "preparing",
      source: "audio_pending",
      startedAtMs: null,
      currentTimeMs: 0,
      durationMs: 2250,
    }),
    { status: "prepared", source: "speech_only" },
  );
}

function testSpeechOnlyPlaybackCanBeSuppressedForFailedMotionSegment(): void {
  const profile = buildProfile();
  const model = buildModelWithVoiceFollowingProfile(profile);
  const playedPlans: MotionPlanPayload[] = [];
  const engine = useModelEngine({
    getSelectedModel: () => model,
    getSettings: () => ({
      motionIntensityScale: 1,
      axisIntensityScale: {},
    }),
    playPlan: (plan) => {
      playedPlans.push(plan as MotionPlanPayload);
      return true;
    },
    playCatalogMotion: () => false,
    stopPlan: () => {},
    onMotionRejected: () => {},
    canStartSpeechOnlyMotion: () => false,
    onPlanStarted: ignorePlanStarted,
  });

  const started = engine.handlePlaybackTimelineStarted({
    timelineId: "timeline-speech",
    turnId: "turn-speech",
    messageId: "msg-speech",
    phase: "playing",
    source: "audio",
    startedAtMs: 100,
    currentTimeMs: 250,
    durationMs: 2250,
  });

  assert.equal(started, false);
  assert.equal(playedPlans.length, 0);
}

function testSpeechOnlyPreparationIsNotApplicableWithoutModelCapability(): void {
  const engine = useModelEngine({
    getSelectedModel: () => buildModel(buildProfile()),
    getSettings: () => ({ motionIntensityScale: 1, axisIntensityScale: {} }),
    playPlan: () => false,
    playCatalogMotion: () => false,
    stopPlan: () => {},
    onMotionRejected: () => {},
    canStartSpeechOnlyMotion: () => true,
    onPlanStarted: ignorePlanStarted,
  });

  assert.deepEqual(
    engine.preparePlaybackTimeline({
      timelineId: "timeline-no-speech-profile",
      turnId: "turn-no-speech-profile",
      messageId: "msg-no-speech-profile",
      phase: "ready",
      source: "audio",
      startedAtMs: null,
      currentTimeMs: 0,
      durationMs: 1800,
    }),
    {
      status: "not_applicable",
      reason: "speech_only_motion_profile_unavailable",
    },
  );
}

function testSegmentInterruptDoesNotStopNewerMotionOwner(): void {
  const model = buildModelWithVoiceFollowingProfile(buildProfile());
  const stopped: string[] = [];
  let runSequence = 0;
  const engine = useModelEngine({
    getSelectedModel: () => model,
    getSettings: () => ({ motionIntensityScale: 1, axisIntensityScale: {} }),
    playPlan: (plan, _model, options) => {
      runSequence += 1;
      options.onStarted(plan as MotionPlanPayload, `run-${runSequence}`);
      return true;
    },
    playCatalogMotion: () => false,
    stopPlan: (reason) => stopped.push(reason ?? ""),
    onMotionRejected: () => {},
    canStartSpeechOnlyMotion: () => true,
    onPlanStarted: ignorePlanStarted,
  });
  const timeline = (
    turnId: string,
    messageId: string,
    phase: "ready" | "playing",
  ) => ({
    timelineId: `timeline-${messageId}`,
    turnId,
    messageId,
    phase,
    source: "audio" as const,
    startedAtMs: phase === "playing" ? 100 : null,
    currentTimeMs: 0,
    durationMs: 2000,
  });

  assert.deepEqual(
    engine.preparePlaybackTimeline(timeline("turn-a", "msg-a", "ready")),
    { status: "prepared", source: "speech_only" },
  );
  assert.equal(engine.handlePlaybackTimelineStarted(timeline("turn-a", "msg-a", "playing")), true);
  assert.deepEqual(
    engine.preparePlaybackTimeline(timeline("turn-b", "msg-b", "ready")),
    { status: "prepared", source: "speech_only" },
  );
  assert.equal(engine.handlePlaybackTimelineStarted(timeline("turn-b", "msg-b", "playing")), true);

  engine.interruptPlaybackSegment("turn-a", "msg-a", "old_turn_replaced");
  assert.deepEqual(stopped, []);
  engine.interruptPlaybackSegment("turn-b", "msg-b", "current_turn_interrupted");
  assert.deepEqual(stopped, ["current_turn_interrupted"]);
}

function testSegmentInterruptRemovesItsPendingPayload(): void {
  const engine = useModelEngine({
    getSelectedModel: () => buildModel(buildProfile()),
    getSettings: () => ({ motionIntensityScale: 1, axisIntensityScale: {} }),
    playPlan: () => false,
    playCatalogMotion: () => false,
    stopPlan: () => assert.fail("pending motion must not stop an unrelated active player"),
    onMotionRejected: () => {},
    canStartSpeechOnlyMotion: () => false,
    onPlanStarted: ignorePlanStarted,
  });

  engine.ingestNormalizedPayload(
    { kind: "semantic_intent", intent: buildIntent() },
    {
      turnId: "turn-pending",
      playbackTurnId: "turn-pending",
      messageId: "msg-pending",
      receivedAtMs: performance.now(),
    },
  );
  assert.equal(engine.state.pendingCount, 1);
  engine.interruptPlaybackSegment("turn-pending", "msg-pending", "timeline_interrupted");
  assert.equal(engine.state.pendingCount, 0);
}

function testModelEngineInstancesKeepIndependentRuntimeState(): void {
  const createEngine = () => useModelEngine({
    getSelectedModel: () => buildModel(buildProfile()),
    getSettings: () => ({ motionIntensityScale: 1, axisIntensityScale: {} }),
    playPlan: () => false,
    playCatalogMotion: () => false,
    stopPlan: () => {},
    onMotionRejected: () => {},
    canStartSpeechOnlyMotion: () => false,
    onPlanStarted: ignorePlanStarted,
  });
  const first = createEngine();
  const second = createEngine();

  assert.equal(first.ingestNormalizedPayload(
    { kind: "semantic_intent", intent: buildIntent() },
    {
      turnId: "turn-isolated",
      messageId: "msg-first",
      receivedAtMs: performance.now(),
    },
  ), true);

  assert.equal(first.state.status, "pending");
  assert.equal(first.state.pendingCount, 1);
  assert.equal(second.state.status, "idle");
  assert.equal(second.state.pendingCount, 0);
  first.stop("test_cleanup");
}

function testTimelineTerminalIsMarkedWhenQueuedMotionFails(): void {
  const profile = buildProfile();
  const model = buildModel(profile);
  const failures: Array<{
    turnId: string | null;
    messageId: string;
    terminal: string;
    reason: string;
  }> = [];
  const engine = useModelEngine({
    getSelectedModel: () => model,
    getSettings: () => ({
      motionIntensityScale: 1,
      axisIntensityScale: {},
    }),
    playPlan: () => true,
    playCatalogMotion: () => false,
    stopPlan: () => {},
    canStartSpeechOnlyMotion: () => false,
    onPlanStarted: ignorePlanStarted,
    onMotionRejected: ({ turnId, messageId, reason }) => {
      failures.push({ turnId, messageId, terminal: "failed", reason });
    },
  });

  engine.ingestNormalizedPayload(
    {
      kind: "semantic_intent",
      intent: buildIntent(),
    },
    {
      messageId: "msg-failed-timeline",
      turnId: "turn-failed-timeline",
      playbackTurnId: "turn-failed-timeline",
      receivedAtMs: 100,
      playbackClock: {
        timelineId: "timeline-failed",
        turnId: "turn-failed-timeline",
        messageId: "msg-failed-timeline",
        phase: "playing",
        source: "audio_unavailable",
        startedAtMs: 100,
        currentTimeMs: 0,
        durationMs: null,
      },
    },
  );

  assert.deepEqual(failures, [
    {
      turnId: "turn-failed-timeline",
      messageId: "msg-failed-timeline",
      terminal: "failed",
      reason: "playback_timeline_audio_unavailable_before_motion_start",
    },
  ]);
}

function testSpeechPoseVoiceFollowingTargetDoesNotDoubleApplyWeight(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
    mode: "idle",
    intent_tags: ["explain"],
    axes: {},
  }), {
    model: buildModelWithVoiceFollowingProfile(profile),
    targetDurationMs: 2200,
    speechActive: true,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  const bodyYaw = result.plan?.parameters.find((item) => item.parameter_id === "ParamBodyAngleX");
  assert.ok(bodyYaw);
  assert.equal(bodyYaw?.target_value, 0);
  assert.equal(bodyYaw?.weight, 0.35);
  assert.equal(bodyYaw?.modulation?.amplitude, 0.9 * 0.35);
  assert.equal(bodyYaw?.modulation?.direction, 1);
  assert.equal(bodyYaw?.modulation?.delay_ms, 220);
  const headPitch = result.plan?.parameters.find((item) => item.parameter_id === "ParamAngleY");
  assert.ok(headPitch);
  assert.equal(headPitch?.target_value, 0);
  assert.equal(headPitch?.modulation?.amplitude, 1.0 * 0.35);
  assert.equal(headPitch?.weight, 0.35);
}

function testSpeechPoseComposesWithParameterAlreadyControlledBySemanticAxis(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
    intent_tags: ["explain"],
    axes: {
      head_yaw: 80,
    },
  }), {
    model: buildModelWithVoiceFollowingProfile(profile),
    targetDurationMs: 1600,
    speechActive: true,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  const bodyYawParameters = result.plan?.parameters.filter(
    (item) => item.parameter_id === "ParamBodyAngleX",
  ) ?? [];
  assert.equal(bodyYawParameters.length, 1);
  assert.equal(bodyYawParameters[0].source, "coupling");
  assert.equal(bodyYawParameters[0].modulation?.amplitude, 0.9 * 0.35);
  assert.equal(
    result.diagnostics.warnings?.includes(
      "speech_pose_modulation_pending:ParamBodyAngleX",
    ),
    true,
  );
}

function testSpeechPoseDoesNotApplyWithoutSpeechActive(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
    mode: "idle",
    axes: {
      mouth_smile: 62,
    },
  }), {
    model: buildModel(profile),
    targetDurationMs: 5000,
    speechActive: false,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.speechActive, false);
  assert.equal(
    result.diagnostics.warnings?.includes("speech_pose_skipped_inactive"),
    false,
  );
  assert.equal(
    result.diagnostics.appliedDerivedAxes?.includes("speech_head_sway"),
    false,
  );
}

function testSpeechPoseDoesNotUseGenericDerivedAxis(): void {
  const profile = buildProfile();
  profile.axes = profile.axes.filter((axis) => axis.id !== "speech_head_sway");
  const result = compileMotionIntent(buildIntent({
    mode: "idle",
    axes: {},
  }), {
    model: buildModel(profile),
    targetDurationMs: 5000,
    speechActive: true,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "semantic_plan_parameters_empty");
  assert.equal(
    result.diagnostics.warnings?.includes("speech_pose_skipped_no_candidate_axis"),
    false,
  );
}

function testSpeechPoseDoesNotOverwriteCouplingDerivedAxis(): void {
  const profile = buildProfile();
  profile.axes = profile.axes.map((axis) =>
    axis.id === "body_yaw"
      ? {
        ...axis,
        label: "Speech Body Yaw",
        description: "Dedicated speaking body motion",
        usage_notes: "Dedicated speech pose compensation axis.",
        positive_semantics: ["speaking body right"],
        negative_semantics: ["speaking body left"],
      }
      : axis,
  );

  const result = compileMotionIntent(buildIntent({
    axes: {
      head_yaw: 80,
    },
  }), {
    model: buildModel(profile),
    targetDurationMs: 1600,
    speechActive: true,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  const bodyYaw = result.plan?.parameters.find((item) => item.parameter_id === "ParamBodyAngleX");
  assert.ok(bodyYaw);
  assert.equal(bodyYaw?.source, "coupling");
  assert.equal(
    result.diagnostics.warnings?.includes("speech_pose_skipped_existing_axis:body_yaw"),
    false,
  );
}

function testRegistryCoreStageOrder(): void {
  const registrations = listCompileStageRegistrations();
  const coreStages = registrations.filter((r) => r.kind === "core");
  const extensionStages = registrations.filter((r) => r.kind === "extension");

  assert.equal(coreStages.length, 9);
  assert.equal(extensionStages.length, 1);

  const expectedOrder = [
    "intentValidator",
    "axisResolver",
    "intensity",
    "derivedCandidates",
    "modeResolver",
    "timing",
    "semanticAxisRelationGraph",
    "planBuilder",
    "resourcePolicy",
  ];

  const actualOrder = coreStages.map((r) => r.id);
  assert.deepEqual(actualOrder, expectedOrder);
  assert.equal(extensionStages[0].id, "speechPose");
  assert.equal(extensionStages[0].order, 47);
  assert.ok(
    registrations.find((r) => r.id === "derivedCandidates")!.order
      < extensionStages[0].order,
  );
  assert.ok(
    registrations.find((r) => r.id === "timing")!.order
      < extensionStages[0].order,
  );

  for (let i = 1; i < coreStages.length; i++) {
    assert.ok(
      coreStages[i].order > coreStages[i - 1].order,
      `stage ${coreStages[i].id} order (${coreStages[i].order}) should be greater than ${coreStages[i - 1].id} order (${coreStages[i - 1].order})`,
    );
  }

  for (const reg of coreStages) {
    assert.equal(reg.enabled({} as any), true, `core stage ${reg.id} should always be enabled`);
  }
}

function testStageRegistryInstancesKeepExtensionConfigurationIsolated(): void {
  const first = createModelEngineStageRegistry();
  const second = createModelEngineStageRegistry();
  first.setEnabled("speechPose", false);
  first.register({
    id: "testExtension",
    kind: "extension",
    order: 46,
    enabled: () => true,
    stage: { id: "testExtension", run: () => ({ ok: true }) },
  });

  assert.equal(first.list().some((item) => item.id === "testExtension"), true);
  assert.equal(second.list().some((item) => item.id === "testExtension"), false);
  assert.throws(() => first.setEnabled("intentValidator", false), /core stage/);
}

function testPlanRetimingScalesSequenceKeyframesInsideModelEngine(): void {
  const plan: SemanticParameterPlan = {
    schema_version: "engine.parameter_plan.v2",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    emotion_label: "sequence",
    timing: {
      duration_ms: 1000,
      blend_in_ms: 100,
      hold_ms: 700,
      blend_out_ms: 200,
      curve_preset: "smooth_hold",
    },
    parameters: [{
      axis_id: "head_yaw",
      parameter_id: "ParamAngleX",
      target_value: 10,
      neutral_target_value: 0,
      weight: 1,
      source: "semantic_axis",
      keyframes: [
        { at_ms: 0, transition_ms: 0, target_value: 0 },
        { at_ms: 500, transition_ms: 200, target_value: 10 },
        { at_ms: 1000, transition_ms: 0, target_value: 0 },
      ],
      modulation: {
        kind: "speech_gesture_track",
        preset: "calm_explain",
        amplitude: 1,
        direction: 1,
        delay_ms: 100,
        points: [
          { at_ms: 0, transition_ms: 0, value: 0 },
          { at_ms: 400, transition_ms: 100, value: 0.5 },
          { at_ms: 800, transition_ms: 100, value: 0 },
        ],
      },
      dynamics: {
        max_velocity: 60,
        max_acceleration: 240,
        life_motion_scale: 0.5,
        max_speech_offset: 2,
      },
    }],
  };

  const retimed = retimeSemanticParameterPlan(plan, 2000);
  assert.equal(retimed.timing.duration_ms, 2000);
  assert.equal(retimed.timing.curve_preset, "smooth_hold");
  assert.deepEqual(
    retimed.parameters[0].keyframes?.map(({ at_ms, transition_ms }) => ({ at_ms, transition_ms })),
    [
      { at_ms: 0, transition_ms: 0 },
      { at_ms: 1000, transition_ms: 400 },
      { at_ms: 2000, transition_ms: 0 },
    ],
  );
  assert.equal(plan.timing.duration_ms, 1000);
  assert.equal(retimed.parameters[0].modulation?.delay_ms, 100);
  assert.deepEqual(
    retimed.parameters[0].modulation?.points.map(({ at_ms, transition_ms }) => ({
      at_ms,
      transition_ms,
    })),
    [
      { at_ms: 0, transition_ms: 0 },
      { at_ms: 844, transition_ms: 211 },
      { at_ms: 1689, transition_ms: 211 },
    ],
  );
}

function testRelationGraphLimitsOppositeHeadBodyMotion(): void {
  const profile = buildProfile();
  profile.axes = profile.axes.map((axis) =>
    axis.id === "body_yaw"
      ? { ...axis, control_role: "primary" }
      : axis,
  );

  const result = compileMotionIntent(buildIntent({
    axes: {
      head_yaw: 90,
      body_yaw: 10,
    },
  }), {
    model: buildModel(profile),
    targetDurationMs: 1200,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  const bodyYaw = result.plan?.parameters.find(
    (item) => item.parameter_id === "ParamBodyAngleX",
  );
  assert.ok(bodyYaw);
  assert.equal(bodyYaw?.input_value, 42.1);
  assert.equal(
    result.diagnostics.relationAdjustments?.some(
      (item) => item.ruleId === "head_yaw_to_body_yaw"
        && item.targetAxisId === "body_yaw"
        && item.before === 10
        && item.after === 42.1,
    ),
    true,
  );
  assert.equal(
    result.diagnostics.transformTrace?.constrainedAxes.body_yaw,
    42.1,
  );
  assert.equal(
    result.diagnostics.relationEvaluations?.some(
      (item) => item.ruleId === "head_yaw_to_body_yaw"
        && item.status === "constrained"
        && item.reason === "opposite_direction_limit",
    ),
    true,
  );
}

function testRelationGraphDerivesBoundedRatioAtFinalStage(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
    axes: {
      head_yaw: 80,
    },
  }), {
    model: buildModel(profile),
    targetDurationMs: 1200,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.derivedAxes?.includes("body_yaw"), true);
  const bodyYaw = result.plan?.parameters.find(
    (item) => item.parameter_id === "ParamBodyAngleX",
  );
  assert.ok(bodyYaw);
  assert.equal(bodyYaw?.source, "coupling");
  assert.equal(
    result.diagnostics.relationEvaluations?.some(
      (item) => item.ruleId === "head_yaw_to_body_yaw"
        && item.status === "derived"
        && item.reason === "target_axis_derived",
    ),
    true,
  );
  assert.equal(
    result.diagnostics.relationEvaluations?.some(
      (item) => item.ruleId === "gaze_x_to_head_yaw"
        && item.status === "skipped"
        && item.reason === "source_axis_missing",
    ),
    true,
  );
}

function testExplicitEmptyRelationGraphDoesNotReviveLegacyCouplings(): void {
  const profile = buildProfile();
  profile.relation_graph = {
    schema_version: "ag99.semantic_axis_relation_graph.v1",
    edges: [],
  };

  const result = compileMotionIntent(buildIntent({
    axes: {
      head_yaw: 80,
    },
  }), {
    model: buildModel(profile),
    targetDurationMs: 1200,
    settings: {
      motionIntensityScale: 1,
      axisIntensityScale: {},
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.derivedAxes?.includes("body_yaw"), false);
  assert.equal(
    result.plan?.parameters.some((item) => item.parameter_id === "ParamBodyAngleX"),
    false,
  );
}

function run(): void {
  testDefaultMotionDurationMatchesAdapterContract();
  testRegistryCoreStageOrder();
  testStageRegistryInstancesKeepExtensionConfigurationIsolated();
  testPlanRetimingScalesSequenceKeyframesInsideModelEngine();
  testNormalizeMotionPayloadAcceptsV3FlatAxes();
  testNormalizeMotionPayloadAcceptsV4AxisLevels();
  testNormalizeMotionPayloadAcceptsV4MotionSequence();
  testNormalizeMotionPayloadRejectsMixedOrInvalidAxisLevelContracts();
  testV4AxisLevelsResolveThroughProfileAnchors();
  testV4AxisSamplingRequiresIdentityAndKeepsNeutralExact();
  testV4MotionSequenceCompilesToParameterKeyframes();
  testV4MotionSequenceAllowsExplicitNeutralWaypoint();
  testV4MotionSequenceRejectsTrapezoidalTransitionBudgetOverflow();
  testParameterDynamicsLimitsAccelerationDuringTargetReversal();
  testParameterDynamicsStopsAtTargetWithoutOvershoot();
  testParameterPlanRequiresNeutralTargetAndDynamics();
  testV4AxisLevelsRejectUnknownAxesAndMissingAnchors();
  testCompiledPlanResolvesExpressionResourceForPlayback();
  testResourcePolicyRejectsUnknownResource();
  testResourcePolicyRejectsParameterConflict();
  testMotionResourceUsesCatalogPlaybackInsteadOfDirectPlan();
  testMotionCompileFailureEmitsStructuredFeedback();
  testNormalizeMotionPayloadAcceptsPerformanceCurveHint();
  testNormalizeMotionPayloadRejectsInvalidPerformanceCurveHint();
  testNormalizeMotionPayloadRejectsV3NestedAxes();
  testMotionStartRejectsPlayerThatOmitsStartedCallback();
  testMotionStartUsesPlaybackTimelineDuration();
  testMotionStartRejectsAudioUnavailableTimelineForTiming();
  testPerformanceCurveIsSkippedWhenAudioTimelineIsUnavailable();
  testExplicitPrimaryAxisIsNotOverwrittenByCoupling();
  testAxisIntensityScaleAffectsOnlyTargetAxis();
  testAxisRangeConstraintIsOwnedByRelationGraph();
  testRevisionMismatchRejectsCompile();
  testCompileRejectsInvalidAxesInsteadOfSalvaging();
  testCompileRejectsAllNeutralSemanticAxes();
  testCompileRejectsInvalidBindingsInsteadOfSkippingThem();
  testCompileRejectsBindingInputRangeMismatch();
  testSpeechPoseRequiresExplicitVoiceFollowingProfile();
  testPerformanceCurveHintAdjustsExpressiveTiming();
  testPerformanceCurveHintAdjustsSpeechIdleTiming();
  testSpeechPoseUsesVoiceFollowingProfileBeforeDerivedAxes();
  testSpeechGestureTracksAreDeterministicAndTimelineBounded();
  testSpeechGesturePresetSelectionUsesSemanticHints();
  testSpeechGestureUsesAvailableChannelsForSparseModel();
  testSpeechGestureSkipsDelayedBodyChannelsForShortAudio();
  testSpeechOnlyPayloadUsesSelectedModelProfile();
  testSpeechOnlyPayloadRequiresVoiceFollowingProfile();
  testSpeechOnlyPlaybackUsesTimelineDuration();
  testSpeechOnlyPreparationAcceptsPendingAudioClock();
  testSpeechOnlyPlaybackCanBeSuppressedForFailedMotionSegment();
  testSpeechOnlyPreparationIsNotApplicableWithoutModelCapability();
  testSegmentInterruptDoesNotStopNewerMotionOwner();
  testSegmentInterruptRemovesItsPendingPayload();
  testModelEngineInstancesKeepIndependentRuntimeState();
  testTimelineTerminalIsMarkedWhenQueuedMotionFails();
  testSpeechPoseVoiceFollowingTargetDoesNotDoubleApplyWeight();
  testSpeechPoseComposesWithParameterAlreadyControlledBySemanticAxis();
  testSpeechPoseDoesNotApplyWithoutSpeechActive();
  testSpeechPoseDoesNotUseGenericDerivedAxis();
  testSpeechPoseDoesNotOverwriteCouplingDerivedAxis();
  testRelationGraphLimitsOppositeHeadBodyMotion();
  testRelationGraphDerivesBoundedRatioAtFinalStage();
  testExplicitEmptyRelationGraphDoesNotReviveLegacyCouplings();
  console.log("modelEngineCompiler tests passed");
}

run();
