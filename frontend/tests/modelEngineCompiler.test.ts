import assert from "node:assert/strict";
import { compileMotionIntent } from "../src/model-engine/compiler/compileMotionIntent.js";
import { normalizeMotionPayload } from "../src/model-engine/normalize.js";
import { startNormalizedMotionPayload } from "../src/model-engine/runtime/motionStart.js";
import { buildSpeechOnlyMotionPayload } from "../src/model-engine/runtime/speechOnlyMotion.js";
import { useModelEngine } from "../src/model-engine/useModelEngine.js";
import { listCompileStageRegistrations } from "../src/model-engine/compiler/registry.js";
import type { ModelSummary, MotionPlanPayload, SemanticMotionIntent } from "../src/types/protocol.js";
import type { SemanticAxisProfile } from "../src/types/semantic-axis-profile.js";
import type { ModelEnginePlanStartedEvent } from "../src/model-engine/runtime/contracts.js";
import type { CompileDiagnostics } from "../src/model-engine/compiler/contracts.js";

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
        id: "speech_head_sway",
        label: "Speech Head Sway",
        description: "Light head sway while speaking",
        semantic_group: "head",
        control_role: "derived",
        neutral: 50,
        value_range: [0, 100],
        soft_range: [46, 54],
        strong_range: [36, 64],
        positive_semantics: ["speaking head motion"],
        negative_semantics: ["speaking head motion opposite"],
        usage_notes: "Dedicated speech pose compensation axis.",
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
    schema_version: "ag99.voice_following_profile.v1",
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
        phase: 0,
        frequency_hz: 0.56,
        direction: -1,
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
        phase: 0.35,
        frequency_hz: 0.48,
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
        phase: 0.2,
        frequency_hz: 0.26,
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
        phase: 0.5,
        frequency_hz: 0.30,
        direction: -1,
      },
    },
    summary: {
      channel_count: 4,
      available_channels: ["head_roll", "head_pitch", "body_yaw", "body_roll"],
    },
  };
  return model;
}

function buildIntent(overrides?: Partial<SemanticMotionIntent>): SemanticMotionIntent {
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
    fallback_pose_id: "neutral",
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

function testNormalizeMotionPayloadRejectsV3NestedAxes(): void {
  const result = normalizeMotionPayload({
    schema_version: "engine.motion_intent.v3",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    emotion_label: "happy",
    duration_hint_ms: 1000,
    fallback_pose_id: "neutral",
    axes: {
      head_yaw: { value: 62 },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "motion_intent_v3.invalid_flat_axes");
}

function testMotionStartNotifiesStartedWhenPlayerOmitsCallback(): void {
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
      resolveMotionTargetDurationMs: () => null,
      isSpeechActiveForPayload: () => false,
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

  assert.equal(started, true);
  assert.equal(startedEvents.length, 1);
  assert.equal(startedEvents[0].messageId, "msg-plan");
  assert.equal(startedEvents[0].payloadKind, "semantic_plan");
  assert.equal(startedEvents[0].playerMessage, "playing without callback");
  assert.equal(stateChanges.at(-1)?.status, "playing");
}

function testMotionStartUsesPlaybackTimelineDuration(): void {
  const profile = buildProfile();
  const model = buildModel(profile);
  let resolverCalled = false;
  const playedPlans: MotionPlanPayload[] = [];

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
      messageId: "msg-timeline",
      turnId: "turn-timeline",
      playbackTurnId: "turn-timeline",
      startReason: "audio_playing_event",
      queuedDelayMs: 0,
      playbackTimeline: {
        timelineId: "timeline-1",
        turnId: "turn-timeline",
        messageId: "msg-timeline",
        phase: "playing",
        clockSource: "audio",
        startedAtMs: 100,
        currentTimeMs: 300,
        durationMs: 2400,
        playbackRate: 1,
        sinks: [
          {
            id: "audio",
            required: true,
            terminal: "started",
          },
        ],
      },
    },
    {
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
      getPlayerMessage: () => "timeline duration applied",
    },
    {
      resolveMotionTargetDurationMs: () => {
        resolverCalled = true;
        return null;
      },
      isSpeechActiveForPayload: () => false,
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
  assert.equal(resolverCalled, false);
  const playedPlan = playedPlans[0];
  assert.ok(playedPlan);
  assert.equal(playedPlan?.timing.duration_ms, 2100);
  assert.deepEqual(playedPlan?.timing, {
    duration_ms: 2100,
    blend_in_ms: 210,
    hold_ms: 1428,
    blend_out_ms: 462,
  });
}

function testMotionStartRejectsAudioUnavailableTimelineForTiming(): void {
  const profile = buildProfile();
  const model = buildModel(profile);
  let resolverCalled = false;
  let speechFallbackCalled = false;
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
      startReason: "audio_playing_event",
      queuedDelayMs: 0,
      playbackTimeline: {
        timelineId: "timeline-audio-unavailable",
        turnId: "turn-audio-unavailable",
        messageId: "msg-audio-unavailable",
        phase: "playing",
        clockSource: "audio_unavailable",
        startedAtMs: 100,
        currentTimeMs: 300,
        durationMs: 2400,
        playbackRate: 1,
        sinks: [
          {
            id: "audio",
            required: true,
            terminal: "started",
          },
        ],
      },
    },
    {
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
      getPlayerMessage: () => "audio unavailable timeline rejected",
    },
    {
      resolveMotionTargetDurationMs: () => {
        resolverCalled = true;
        return 1800;
      },
      isSpeechActiveForPayload: () => {
        speechFallbackCalled = true;
        return true;
      },
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
  assert.equal(resolverCalled, false);
  assert.equal(speechFallbackCalled, false);
  assert.equal(playedPlans.length, 1);
  assert.equal(playedPlans[0].timing.duration_ms, 1200);
}

function testPerformanceCurveSkipsAudioUnavailableTimeline(): void {
  const profile = buildProfile();
  const model = buildModel(profile);
  let resolverCalled = false;
  let speechFallbackCalled = false;
  const playedPlans: MotionPlanPayload[] = [];
  const diagnostics: CompileDiagnostics[] = [];

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
      startReason: "audio_playing_event",
      queuedDelayMs: 0,
      playbackTimeline: {
        timelineId: "timeline-curve-unavailable",
        turnId: "turn-curve-unavailable",
        messageId: "msg-curve-unavailable",
        phase: "playing",
        clockSource: "audio_unavailable",
        startedAtMs: 100,
        currentTimeMs: 300,
        durationMs: 2400,
        playbackRate: 1,
        sinks: [
          {
            id: "audio",
            required: true,
            terminal: "started",
          },
        ],
      },
    },
    {
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
      getPlayerMessage: () => "performance curve skipped",
    },
    {
      resolveMotionTargetDurationMs: () => {
        resolverCalled = true;
        return 1800;
      },
      isSpeechActiveForPayload: () => {
        speechFallbackCalled = true;
        return true;
      },
    },
    {
      setState: () => {},
      setLastCompileReason: () => {},
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
  assert.equal(resolverCalled, false);
  assert.equal(speechFallbackCalled, false);
  assert.equal(playedPlans.length, 1);
  assert.deepEqual(playedPlans[0].timing, {
    duration_ms: 1200,
    blend_in_ms: 216,
    hold_ms: 684,
    blend_out_ms: 300,
  });
  const lastDiagnostics = diagnostics.at(-1);
  assert.equal(
    lastDiagnostics?.warnings?.includes(
      "performance_curve_skipped:playback_timeline_audio_unavailable",
    ),
    true,
  );
  assert.equal(
    lastDiagnostics?.warnings?.includes("performance_curve_applied:quick_in_hold_soft_out"),
    false,
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

function testRevisionMismatchBecomesWarningInsteadOfCompileFailure(): void {
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

  assert.equal(result.ok, true);
  assert.ok(result.plan);
  assert.equal(result.plan?.profile_revision, profile.revision);
  assert.equal(
    result.diagnostics.warnings?.includes(
      `semantic_profile_revision_mismatch:${profile.revision + 2}:${profile.revision}`,
    ),
    true,
  );
}

function testCompileSalvagesValidAxesWhenIntentContainsManyInvalidAxes(): void {
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

  assert.equal(result.ok, true);
  assert.ok(result.plan);
  assert.equal(
    result.plan?.parameters.some((item) => item.parameter_id === "ParamMouthForm"),
    true,
  );
  assert.equal(
    result.diagnostics.warnings?.includes("semantic_axis_ignored_unknown:unknown_a"),
    true,
  );
  assert.equal(
    result.diagnostics.warnings?.includes("semantic_axis_error_rate_exceeded_but_salvaged:3/3"),
    true,
  );
}

function testCompileSkipsInvalidBindingsAndKeepsUsableParameters(): void {
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

  assert.equal(result.ok, true);
  assert.ok(result.plan);
  assert.equal(
    result.plan?.parameters.some((item) => item.parameter_id === "ParamAngleX"),
    true,
  );
  assert.equal(
    result.plan?.parameters.some((item) => item.parameter_id === "ParamBroken"),
    false,
  );
  assert.equal(
    result.diagnostics.warnings?.includes(
      "binding_input_range_zero:head_yaw:ParamBroken_skipped",
    ),
    true,
  );
}

function testSpeechPoseAppliesForSpeechLinkedIdleIntent(): void {
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

  assert.equal(result.ok, true);
  assert.ok(result.plan);
  assert.equal(result.plan?.mode, "idle");
  assert.equal(result.plan?.timing.duration_ms, 5000);
  assert.equal(result.diagnostics.speechActive, true);
  assert.equal(result.diagnostics.timingSource, "audio_sync");
  assert.equal(
    result.diagnostics.appliedDerivedAxes?.includes("speech_head_sway"),
    true,
  );

  const speechPose = result.plan?.parameters.find(
    (item) => item.parameter_id === "ParamSpeechHeadSway",
  );
  assert.ok(speechPose);
  assert.equal(speechPose?.source, "speech_pose");
  assert.notEqual(speechPose?.input_value, 50);
  assert.equal(
    result.diagnostics.warnings?.includes("speech_pose_applied:speech_head_sway"),
    true,
  );
}

function testSpeechPoseUsesVoiceFollowingProfileBeforeDerivedAxes(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
    mode: "idle",
    axes: {},
  }), {
    model: buildModelWithVoiceFollowingProfile(profile),
    targetDurationMs: 5000,
    speechActive: true,
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
  assert.deepEqual(headRoll?.modulation, {
    kind: "speech_pose_cycle",
    neutral: 0,
    amplitude: 2.8,
    phase: 0,
    frequency_hz: 0.56,
    direction: -1,
  });
  assert.equal(headPitch?.modulation?.frequency_hz, 0.48);
  assert.ok(
    (headPitch?.modulation?.frequency_hz ?? 0) < (headRoll?.modulation?.frequency_hz ?? 0),
  );
  assert.ok((headPitch?.weight ?? 1) < (headRoll?.weight ?? 0));
  assert.equal(legacySpeechAxis, undefined);
  assert.equal(
    result.diagnostics.warnings?.includes("speech_pose_applied:ParamAngleZ"),
    true,
  );
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
  });
  assert.equal(
    result.diagnostics.warnings?.includes("performance_curve_applied:quick_in_hold_soft_out"),
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
  });
  assert.equal(
    result.diagnostics.warnings?.includes("performance_curve_applied:quick_in_hold_soft_out"),
    true,
  );
}

function testSpeechOnlyPayloadUsesSelectedModelProfile(): void {
  const profile = buildProfile();
  const payload = buildSpeechOnlyMotionPayload(
    buildModelWithVoiceFollowingProfile(profile),
  );

  assert.ok(payload);
  assert.equal(payload.kind, "semantic_intent");
  assert.equal(payload.intent.profile_id, profile.profile_id);
  assert.equal(payload.intent.profile_revision, profile.revision);
  assert.equal(payload.intent.model_id, profile.model_id);
  assert.equal(payload.intent.mode, "idle");
  assert.equal(payload.intent.emotion_label, "speech");
  assert.deepEqual(payload.intent.axes, {});
}

function testSpeechOnlyPayloadRequiresVoiceFollowingProfile(): void {
  const profile = buildProfile();

  assert.equal(buildSpeechOnlyMotionPayload(buildModel(profile)), null);
  assert.equal(buildSpeechOnlyMotionPayload(null), null);
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
    playPlan: (plan) => {
      playedPlans.push(plan as MotionPlanPayload);
      return true;
    },
    playCatalogMotion: () => false,
    stopPlan: () => {},
    getCurrentTurnId: () => "turn-speech",
  });

  const started = engine.notifyAudioPlaybackStarted(
    "turn-speech",
    "msg-speech",
    {
      timelineId: "timeline-speech",
      turnId: "turn-speech",
      messageId: "msg-speech",
      phase: "playing",
      clockSource: "audio",
      startedAtMs: 100,
      currentTimeMs: 250,
      durationMs: 2250,
      playbackRate: 1,
      sinks: [
        {
          id: "audio",
          required: true,
          terminal: "started",
        },
      ],
    },
  );

  assert.equal(started, true);
  const plan = playedPlans[0];
  assert.ok(plan);
  assert.equal(plan.mode, "idle");
  assert.equal(plan.timing.duration_ms, 2000);
  assert.equal(
    plan.parameters.some((item) => item.source === "speech_pose"),
    true,
  );
}

function testSpeechPoseVoiceFollowingTargetDoesNotDoubleApplyWeight(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
    mode: "idle",
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
  const bodyRoll = result.plan?.parameters.find((item) => item.parameter_id === "ParamBodyAngleZ");
  assert.ok(bodyRoll);
  assert.equal(bodyRoll?.target_value, -1.2);
  assert.equal(bodyRoll?.weight, 0.45);
  assert.equal(bodyRoll?.modulation?.direction, -1);
  const headPitch = result.plan?.parameters.find((item) => item.parameter_id === "ParamAngleY");
  assert.ok(headPitch);
  assert.equal(Math.abs(headPitch?.target_value ?? 0), 1.0);
  assert.equal(headPitch?.weight, 0.35);
}

function testSpeechPoseSkipsVoiceFollowingParameterAlreadyControlledBySemanticAxis(): void {
  const profile = buildProfile();
  const result = compileMotionIntent(buildIntent({
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
  const semanticHeadYaw = result.plan?.parameters.find((item) => item.parameter_id === "ParamAngleX");
  const voiceHeadRoll = result.plan?.parameters.find((item) => item.parameter_id === "ParamAngleZ");
  assert.ok(semanticHeadYaw);
  assert.ok(voiceHeadRoll);
  assert.equal(semanticHeadYaw?.source, "semantic_axis");
  assert.equal(voiceHeadRoll?.source, "speech_pose");
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
    true,
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
    true,
  );
}

function testRegistryCoreStageOrder(): void {
  const registrations = listCompileStageRegistrations();
  const coreStages = registrations.filter((r) => r.kind === "core");
  const extensionStages = registrations.filter((r) => r.kind === "extension");

  assert.equal(coreStages.length, 7);
  assert.equal(extensionStages.length, 1);

  const expectedOrder = [
    "intentValidator",
    "axisResolver",
    "intensity",
    "coupling",
    "modeResolver",
    "timing",
    "planBuilder",
  ];

  const actualOrder = coreStages.map((r) => r.id);
  assert.deepEqual(actualOrder, expectedOrder);
  assert.equal(extensionStages[0].id, "speechPose");
  assert.equal(extensionStages[0].order, 45);
  assert.ok(
    registrations.find((r) => r.id === "coupling")!.order
      < extensionStages[0].order,
  );
  assert.ok(
    extensionStages[0].order
      < registrations.find((r) => r.id === "modeResolver")!.order,
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

function run(): void {
  testRegistryCoreStageOrder();
  testNormalizeMotionPayloadAcceptsV3FlatAxes();
  testNormalizeMotionPayloadAcceptsPerformanceCurveHint();
  testNormalizeMotionPayloadRejectsV3NestedAxes();
  testMotionStartNotifiesStartedWhenPlayerOmitsCallback();
  testMotionStartUsesPlaybackTimelineDuration();
  testMotionStartRejectsAudioUnavailableTimelineForTiming();
  testPerformanceCurveSkipsAudioUnavailableTimeline();
  testExplicitPrimaryAxisIsNotOverwrittenByCoupling();
  testAxisIntensityScaleAffectsOnlyTargetAxis();
  testRevisionMismatchBecomesWarningInsteadOfCompileFailure();
  testCompileSalvagesValidAxesWhenIntentContainsManyInvalidAxes();
  testCompileSkipsInvalidBindingsAndKeepsUsableParameters();
  testSpeechPoseAppliesForSpeechLinkedIdleIntent();
  testPerformanceCurveHintAdjustsExpressiveTiming();
  testPerformanceCurveHintAdjustsSpeechIdleTiming();
  testSpeechPoseUsesVoiceFollowingProfileBeforeDerivedAxes();
  testSpeechOnlyPayloadUsesSelectedModelProfile();
  testSpeechOnlyPayloadRequiresVoiceFollowingProfile();
  testSpeechOnlyPlaybackUsesTimelineDuration();
  testSpeechPoseVoiceFollowingTargetDoesNotDoubleApplyWeight();
  testSpeechPoseSkipsVoiceFollowingParameterAlreadyControlledBySemanticAxis();
  testSpeechPoseDoesNotApplyWithoutSpeechActive();
  testSpeechPoseDoesNotUseGenericDerivedAxis();
  testSpeechPoseDoesNotOverwriteCouplingDerivedAxis();
  console.log("modelEngineCompiler tests passed");
}

run();
