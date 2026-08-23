import type { SemanticAxisProfile } from "./semantic-axis-profile";

export {
  PROTOCOL_SCHEMA_MANIFEST,
  PROTOCOL_SCHEMAS,
  SCHEMA_MODEL_INFO_V3,
  SCHEMA_MOTION_INTENT_V4,
  SCHEMA_MOTION_TUNING_SAMPLE_V2,
  SCHEMA_OUTPUT_SEGMENT_V4,
  SCHEMA_PARAMETER_ACTION_LIBRARY_V2,
  SCHEMA_PARAMETER_PLAN_V3,
  SCHEMA_PERFORMANCE_CURVE_HINT_V1,
  SCHEMA_SEMANTIC_AXIS_PROFILE_V3,
  SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1,
  SCHEMA_VOICE_FOLLOWING_PROFILE_V3,
} from "./protocolSchema.generated.js";
import {
  PROTOCOL_SCHEMA_MANIFEST,
  PROTOCOL_VERSION,
  SCHEMA_MODEL_INFO_V3,
  SCHEMA_MOTION_INTENT_V4,
  SCHEMA_MOTION_TUNING_SAMPLE_V2,
  SCHEMA_OUTPUT_SEGMENT_V4,
  SCHEMA_PARAMETER_ACTION_LIBRARY_V2,
  SCHEMA_PARAMETER_PLAN_V3,
  SCHEMA_PERFORMANCE_CURVE_HINT_V1,
  SCHEMA_SEMANTIC_AXIS_PROFILE_V3,
  SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1,
  SCHEMA_VOICE_FOLLOWING_PROFILE_V3,
} from "./protocolSchema.generated.js";

export interface ProtocolEnvelope<TPayload = unknown> {
  type: string;
  version: typeof PROTOCOL_VERSION;
  message_id: string;
  timestamp: string;
  turn_id: string | null;
  source: string;
  payload: TPayload;
}

export interface SystemServerInfoPayload {
  ws_url: string;
  http_base_url: string;
  auto_start_mic: boolean;
  schema_manifest: ProtocolSchemaManifest;
}

export type ProtocolSchemaManifest = typeof PROTOCOL_SCHEMA_MANIFEST;

export type OutputSegmentTextSlot =
  | { state: "present"; content: string }
  | { state: "absent" }
  | { state: "failed"; reason: string };

export type OutputSegmentAudioSlot =
  | { state: "present"; url: string }
  | { state: "absent" }
  | { state: "failed"; reason: string };

export type OutputSegmentMotionSlot =
  | {
    state: "present";
    message_type: "engine.motion_intent";
    mode: string;
    source: string;
    payload: Record<string, unknown>;
  }
  | { state: "absent" }
  | { state: "failed"; reason: string };

export const SPEECH_CUE_KINDS = [
  "breath",
  "sigh",
  "laugh",
  "chuckle",
  "hesitate",
  "emphasis",
] as const;

export const SPEECH_CUE_POSITIONS = ["before", "after"] as const;

export type OutputSegmentSpeechCue = {
  kind: typeof SPEECH_CUE_KINDS[number];
  phrase_index: number;
  position: typeof SPEECH_CUE_POSITIONS[number];
};

export type OutputSegmentSpeechSlot =
  | { state: "present"; cues: OutputSegmentSpeechCue[] }
  | { state: "absent" };

export interface OutputSegmentPayload {
  schema_version: typeof SCHEMA_OUTPUT_SEGMENT_V4;
  text: OutputSegmentTextSlot;
  audio: OutputSegmentAudioSlot;
  motion: OutputSegmentMotionSlot;
  speech: OutputSegmentSpeechSlot;
  images: string[];
  speaker_name: string;
  avatar: string;
}

export interface OutputTranscriptionPayload {
  text: string;
}

export interface ControlTurnFinishedPayload {
  success: boolean;
  reason?: string;
}

export interface ControlErrorPayload {
  message: string;
}

export interface SystemMotionLabRawEventRecordedPayload {
  event_id: string;
}

export interface SystemSemanticAxisProfileSavedPayload {
  request_id: string;
  model_name: string;
  profile_id: string;
  revision: number;
  source_hash: string;
  saved_at: string;
}

export interface SystemSemanticAxisProfileSaveFailedPayload {
  request_id: string;
  model_name: string;
  profile_id: string;
  expected_revision?: number;
  error_code: string;
  message: string;
}

export interface StandardChannelInfo {
  label: string;
  available: boolean;
  primary_parameter_id: string;
  primary_parameter_name: string;
  group_name: string;
  candidate_parameter_ids: string[];
}

export interface ParameterEntry {
  id: string;
  name: string;
  group_id: string;
  group_name: string;
  kind: string;
  domain: string;
  channels: string[];
  expression_usage_count: number;
  expression_categories: string[];
  expression_max_abs_value: number;
  expression_mean_abs_value: number;
  expression_blends: string[];
  expression_examples: string[];
  expression_profile: string;
}

export interface ParameterScanPayload {
  source: string;
  total_parameters: number;
  drivable_parameters: number;
  physics_parameters: number;
  expression_parameters: number;
  groups: Array<{
    name: string;
    count: number;
    dominant_domain: string;
    domain_counts: Array<{ name: string; count: number }>;
  }>;
  domain_counts: Array<{ name: string; count: number }>;
  standard_channels: Record<string, StandardChannelInfo>;
  primary_parameters: Array<{
    channel: string;
    parameter_id: string;
    parameter_name: string;
    group_name: string;
  }>;
  parameters: ParameterEntry[];
}

export interface VoiceFollowingChannelProfile {
  channel: string;
  semantic_axis_id: string;
  layer: "head" | "body" | string;
  amplitude_ratio: number;
  follow_delay_ms: number;
}

export interface VoiceFollowingProfile {
  schema_version: typeof SCHEMA_VOICE_FOLLOWING_PROFILE_V3;
  model_id: string;
  revision: number;
  channels: Record<string, VoiceFollowingChannelProfile>;
  summary?: {
    channel_count?: number;
    available_channels?: string[];
  };
}

export interface ExpressionConstraint {
  name: string;
  file: string;
  catalog_id: string;
  catalog_expose_as_resource: boolean;
  parameter_ids: string[];
}

export interface ExpressionScanPayload {
  total_expressions: number;
  category_counts: Array<{ name: string; count: number }>;
  blend_counts: Array<{ name: string; count: number }>;
  domain_usage: Array<{ name: string; count: number }>;
  channel_usage: Array<{ name: string; count: number }>;
  base_expression_names: string[];
  special_state_names: string[];
  expression_driven_parameters: Array<{
    parameter_id: string;
    parameter_name: string;
    domain: string;
    kind: string;
    usage_count: number;
    max_abs_value: number;
    profile: string;
  }>;
}

export interface ResourceScanPayload {
  model3_file: string;
  cdi3_file: string;
  physics3_file: string;
  texture_count: number;
  texture_files: string[];
  expression_count: number;
  expression_files: string[];
  motion_count: number;
  motion_files: string[];
  motion_groups: Array<{ name: string; count: number }>;
  vtube_profile_count: number;
  vtube_profiles: string[];
  has_motion_catalog: boolean;
}

export interface MotionConstraint {
  name: string;
  file: string;
  catalog_id: string;
  catalog_expose_as_resource: boolean;
  group: string;
  group_index: number;
  duration: number;
  parameter_ids: string[];
  catalog_label: string;
  catalog_intensity: string;
}

export interface ParameterActionCounterEntry {
  name: string;
  count: number;
}

export interface ParameterActionAnalysis {
  status: string;
  mode: string;
  error?: string;
}

export interface ParameterActionParameterEntry {
  kind: string;
  channels: string[];
  selected_atom_count: number;
}

export interface ParameterActionAtom {
  id: string;
  name: string;
  label: string;
  kind: string;
  domain: string;
  channels: string[];
  primary_channel: string;
  polarity: string;
  semantic_polarity: string;
  trait: string;
  strength: string;
  score: number;
  source_motion: string;
  source_file: string;
  source_group: string;
  source_category: string;
  source_tags: string[];
  duration: number;
  fps: number;
  loop: boolean;
  energy_score: number;
  intensity: string;
}

export interface ParameterActionLibrary {
  schema_version: typeof SCHEMA_PARAMETER_ACTION_LIBRARY_V2;
  extraction_mode: string;
  analysis: ParameterActionAnalysis;
  summary: {
    motion_count: number;
    driver_component_count: number;
    selected_atom_count: number;
    selected_parameter_count: number;
  };
  domains: ParameterActionCounterEntry[];
  channels: ParameterActionCounterEntry[];
  parameters: ParameterActionParameterEntry[];
  atoms: ParameterActionAtom[];
}

export interface PerformanceCurveHint {
  schema_version: typeof SCHEMA_PERFORMANCE_CURVE_HINT_V1;
  curve_family:
    | "default"
    | "quick_in_hold_soft_out"
    | "slow_in_hold_quick_out"
    | "pulse_then_settle"
    | "soft_breathe";
  entry: "instant" | "quick" | "soft" | "slow";
  hold: "short" | "steady" | "long" | "breathing";
  exit: "quick" | "soft" | "slow";
  emphasis: "none" | "early" | "middle" | "late" | "punctuated";
  energy: "low" | "medium" | "high" | "teasing" | "calm";
}

export type MotionAxisLevel = -4 | -3 | -2 | -1 | 0 | 1 | 2 | 3 | 4;
export type MotionAxisLevelMap = Record<string, MotionAxisLevel>;
export interface MotionAxisLevelStep {
  axis_levels: MotionAxisLevelMap;
  duration_weight: 1 | 2 | 3;
}

interface NormalizedSemanticMotionIntentBase {
  profile_id: string;
  profile_revision: number;
  model_id: string;
  mode: "expressive" | "idle";
  intent_tags?: string[];
  emotion_label: string;
  duration_hint_ms?: number | null;
  performance_curve_hint?: PerformanceCurveHint;
  summary?: {
    axis_count?: number;
    active_groups?: string[];
    skeleton_groups?: string[];
    skeleton_groups_present?: string[];
    missing_skeleton_groups?: string[];
    max_delta_from_neutral?: number;
    neutralish_axis_count?: number;
    expressive_axis_count?: number;
    neutralish_axes?: string[];
    expressive_axes?: string[];
    outside_soft_range_axes?: string[];
    pose_descriptors?: string[];
  };
}

interface NormalizedSemanticMotionIntentV4Base
  extends NormalizedSemanticMotionIntentBase {
  schema_version: typeof SCHEMA_MOTION_INTENT_V4;
  axes?: never;
  resource_id?: never;
}

export type NormalizedSemanticMotionIntentV4 =
  NormalizedSemanticMotionIntentV4Base & (
    | {
      axis_levels: MotionAxisLevelMap;
      motion_steps?: never;
      expression_resource_id?: string;
      motion_resource_id?: never;
    }
    | {
      axis_levels?: never;
      motion_steps: MotionAxisLevelStep[];
      motion_resource_id?: never;
      expression_resource_id?: string;
    }
    | {
      axis_levels?: never;
      motion_steps?: never;
      expression_resource_id?: never;
      motion_resource_id: string;
    }
  );

/** Normalized semantic motion intent consumed by ModelEngine. */
export type NormalizedSemanticMotionIntent = NormalizedSemanticMotionIntentV4;

export interface DirectParameterPlanTiming {
  duration_ms: number;
  blend_in_ms: number;
  hold_ms: number;
  blend_out_ms: number;
  curve_preset?: PerformanceCurvePresetName;
}

export type PerformanceCurvePresetName =
  | "smooth_hold"
  | "snap_hold_soft_release"
  | "slow_build_quick_release"
  | "pulse_settle"
  | "breathing_swell";

export type ParameterResponsePolicy =
  | { kind: "bounded" }
  | {
      kind: "spring";
      frequency_hz: number;
      damping_ratio: number;
    };

export interface SemanticParameterPlanEntry {
  axis_id: string;
  parameter_id: string;
  target_value: number;
  neutral_target_value: number;
  weight: number;
  input_value?: number;
  source: SemanticParameterPlanSource;
  keyframes?: Array<{
    at_ms: number;
    transition_ms: number;
    target_value: number;
    input_value?: number;
  }>;
  modulation?: {
    kind: "speech_gesture_track";
    preset: "calm_explain" | "lively_chat" | "gentle_support" | "emphatic";
    amplitude: number;
    direction: 1 | -1;
    delay_ms: number;
    points: Array<{
      at_ms: number;
      transition_ms: number;
      value: number;
    }>;
  };
  dynamics: {
    max_velocity: number;
    max_acceleration: number;
    max_speech_offset: number;
    response: ParameterResponsePolicy;
  };
}

export const SEMANTIC_PARAMETER_PLAN_SOURCES = [
  "semantic_axis",
  "relation_graph",
  "speech_pose",
  "expression",
  "continuity",
  "manual",
] as const;

export type SemanticParameterPlanSource =
  typeof SEMANTIC_PARAMETER_PLAN_SOURCES[number];

export function isSemanticParameterPlanSource(
  value: unknown,
): value is SemanticParameterPlanSource {
  return typeof value === "string"
    && (SEMANTIC_PARAMETER_PLAN_SOURCES as readonly string[]).includes(value);
}

export interface SemanticParameterPlan {
  schema_version: typeof SCHEMA_PARAMETER_PLAN_V3;
  profile_id: string;
  profile_revision: number;
  model_id: string;
  mode: "expressive" | "idle";
  emotion_label: string;
  resource?: SemanticPlanResource;
  timing: DirectParameterPlanTiming;
  parameters: SemanticParameterPlanEntry[];
  diagnostics?: {
    warnings?: string[];
  };
  summary?: {
    axis_count?: number;
    parameter_count?: number;
    target_duration_ms?: number;
    active_groups?: string[];
    skeleton_groups?: string[];
    skeleton_groups_present?: string[];
    missing_skeleton_groups?: string[];
    max_delta_from_neutral?: number;
    neutralish_axis_count?: number;
    expressive_axis_count?: number;
    neutralish_axes?: string[];
    expressive_axes?: string[];
    outside_soft_range_axes?: string[];
    pose_descriptors?: string[];
  };
}

export interface SemanticExpressionPlanResource {
  kind: "expression";
  resource_id: string;
  expression_id: string;
  parameter_ids: string[];
}

export type SemanticPlanResource = SemanticExpressionPlanResource;

export type SemanticMotionIntent = NormalizedSemanticMotionIntent;
export type MotionPlanPayload = SemanticParameterPlan;

export interface MotionResourcePayload {
  model_id: string;
  motion_id: string;
  group: string;
  index: number;
  file: string;
  label: string;
  emotion_label: string;
  duration_ms: number | null;
  priority: number;
  summary?: {
    source?: string;
  };
}

export interface ModelSummary {
  name: string;
  root_path: string;
  model_path: string;
  model_url: string;
  icon_url: string;
  resource_scan: ResourceScanPayload;
  parameter_scan: ParameterScanPayload;
  expression_scan: ExpressionScanPayload;
  parameter_action_library: ParameterActionLibrary;
  constraints: {
    expressions: ExpressionConstraint[];
    motions: MotionConstraint[];
  };
  semantic_axis_profile?: SemanticAxisProfile | null;
  voice_following_profile?: VoiceFollowingProfile | null;
  engine_hints: {
    driver_priority: string[];
    recommended_mode: string;
    available_channels: string[];
    base_expression_count: number;
    fallback_motion_count: number;
    motion_decomposition_level: string;
  };
}

export interface RuntimeCacheErrorsPayload {
  root?: string;
  scan_cache?: string;
  motion_tuning_samples?: string;
}

export interface ModelSyncInfo {
  schema_version: typeof SCHEMA_MODEL_INFO_V3;
  driver_priority: string[];
  selected_model: string;
  available_models: string[];
  models: ModelSummary[];
}

export interface SystemModelSyncPayload {
  model_info: ModelSyncInfo;
  runtime_cache_errors: RuntimeCacheErrorsPayload;
  conf_name: string;
  conf_uid: string;
  client_uid: string;
}

export interface SystemSemanticAxisProfileSavePayload {
  request_id: string;
  model_name: string;
  profile_id: string;
  expected_revision: number;
  profile: SemanticAxisProfile;
}

export interface MotionTuningSampleProtocolPayload {
  schema_version: typeof SCHEMA_MOTION_TUNING_SAMPLE_V2;
  id: string;
  created_at: string;
  source_record_id: string;
  turn_id: string;
  message_id: string;
  model_name: string;
  profile_id: string;
  profile_revision: number;
  profile_hash?: string;
  transform_version?: string;
  emotion_label: string;
  user_text?: string;
  assistant_text?: string;
  feedback: string;
  tags: string[];
  enabled_for_llm_reference?: boolean;
  original_axes: Record<string, number>;
  raw_axis_levels?: Record<string, number>;
  resolved_axes?: Record<string, number>;
  constrained_axes?: Record<string, number>;
  adjusted_axes?: Record<string, number>;
  compiled_semantic_motion: unknown;
}

export interface SystemMotionTuningSampleSavePayload {
  sample: MotionTuningSampleProtocolPayload;
}

export interface SystemMotionTuningSampleDeletePayload {
  sample_id: string;
}

export interface SystemMotionTuningSamplesStatePayload {
  root_error?: string;
  samples: MotionTuningSampleProtocolPayload[];
  load_error?: string;
  diagnostics?: string[];
  effective_examples?: Array<{
    category?: string;
    input: string;
    output: {
      intent_tags: string[];
      duration_hint_ms?: number | null;
      axis_levels?: Record<string, number>;
      motion_steps?: Array<{
        axis_levels: Record<string, number>;
        duration_weight: number;
      }>;
      expression_resource_id?: string;
      motion_resource_id?: string;
    };
    source?: string;
    tags?: string[];
  }>;
}

export interface SystemHistoryListPayload {
  histories: unknown[];
}

export interface SystemHistoryCreatedPayload {
  history_uid: string;
}

export interface SystemHistoryDataPayload {
  messages: unknown[];
}

export interface SystemHistoryDeletedPayload {
  history_uid: string;
  success: boolean;
}
