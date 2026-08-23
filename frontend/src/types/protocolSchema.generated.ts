// Generated from astrbot_plugin_ag99live_adapter/protocol/schema_manifest.json.
export const PROTOCOL_VERSION = "v2" as const;
export const SCHEMA_MODEL_INFO_V3 = "live2d_scan.v3" as const;
export const SCHEMA_MOTION_INTENT_V4 = "engine.motion_intent.v4" as const;
export const SCHEMA_MOTION_TUNING_SAMPLE_V2 = "ag99.motion_tuning_sample.v2" as const;
export const SCHEMA_OUTPUT_SEGMENT_V4 = "output.segment.v4" as const;
export const SCHEMA_PARAMETER_ACTION_LIBRARY_V2 = "parameter_action_library.v2" as const;
export const SCHEMA_PARAMETER_PLAN_V3 = "engine.parameter_plan.v3" as const;
export const SCHEMA_PERFORMANCE_CURVE_HINT_V1 = "ag99.performance_curve_hint.v1" as const;
export const SCHEMA_SEMANTIC_AXIS_PROFILE_V3 = "ag99.semantic_axis_profile.v3" as const;
export const SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1 = "ag99.semantic_axis_relation_graph.v1" as const;
export const SCHEMA_VOICE_FOLLOWING_PROFILE_V3 = "ag99.voice_following_profile.v3" as const;

export const PROTOCOL_SCHEMAS = {
  model_info: SCHEMA_MODEL_INFO_V3,
  motion_intent: SCHEMA_MOTION_INTENT_V4,
  motion_tuning_sample: SCHEMA_MOTION_TUNING_SAMPLE_V2,
  output_segment: SCHEMA_OUTPUT_SEGMENT_V4,
  parameter_action_library: SCHEMA_PARAMETER_ACTION_LIBRARY_V2,
  parameter_plan: SCHEMA_PARAMETER_PLAN_V3,
  performance_curve_hint: SCHEMA_PERFORMANCE_CURVE_HINT_V1,
  semantic_axis_profile: SCHEMA_SEMANTIC_AXIS_PROFILE_V3,
  semantic_axis_relation_graph: SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1,
  voice_following_profile: SCHEMA_VOICE_FOLLOWING_PROFILE_V3,
} as const;

export const PROTOCOL_SCHEMA_MANIFEST = {
  protocol_version: PROTOCOL_VERSION,
  schemas: PROTOCOL_SCHEMAS,
} as const;
