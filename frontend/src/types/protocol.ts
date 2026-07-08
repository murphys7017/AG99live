import type { SemanticAxisProfile } from "./semantic-axis-profile";

export const SCHEMA_MOTION_INTENT_V3 = "engine.motion_intent.v3";
export const SCHEMA_CATALOG_MOTION_V1 = "engine.catalog_motion.v1";
export const SCHEMA_PARAMETER_PLAN_V2 = "engine.parameter_plan.v2";

export interface ProtocolEnvelope<TPayload = unknown> {
  type: string;
  version: string;
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
}

export interface OutputTextPayload {
  text: string;
  speaker_name: string;
  avatar: string;
  audio_expected: boolean;
}

export interface OutputAudioPayload {
  audio_url: string | null;
  caption_text: string;
  speaker_name: string;
  avatar: string;
}

export interface OutputImagePayload {
  images: string[];
}

export interface OutputTranscriptionPayload {
  text: string;
}

export interface ControlTurnFinishedPayload {
  success: boolean;
  reason?: string;
}

export interface ControlPlaybackFinishedPayload {
  success: boolean;
  reason?: string;
}

export interface ControlErrorPayload {
  message: string;
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
  parameter_id: string;
  parameter_name?: string;
  layer: "head" | "body" | string;
  neutral: number;
  output_range: {
    min: number;
    max: number;
  };
  amplitude: number;
  weight: number;
  phase: number;
  frequency_hz?: number;
  /** 说话跟随的方向偏好。1 = 正向偏移（如 head_yaw=右转, head_pitch=抬头），-1 = 反向偏移。
   *  不设置时由 defaultVoiceFollowingDirection 按 channel 名映射。 */
  direction?: 1 | -1;
}

export interface VoiceFollowingProfile {
  schema_version: "ag99.voice_following_profile.v1";
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
  category: string;
  parameter_ids: string[];
  parameter_count: number;
  affects_channels: string[];
  parameters: Array<{
    id: string;
    name: string;
    group_name: string;
    kind: string;
    domain: string;
    channels: string[];
    value: number;
    abs_value: number;
    blend: string;
    intensity: string;
  }>;
  dominant_parameters: Array<{
    id: string;
    value: number;
    blend: string;
    domain: string;
    channels: string[];
  }>;
  dominant_domains: string[];
  dominant_channels: string[];
  blend_modes: string[];
  intensity: string;
  touches_non_expression_parameters: boolean;
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
  group: string;
  category: string;
  duration: number;
  curve_count: number;
  parameter_count: number;
  affects_channels: string[];
  uses_expression_parameters: boolean;
  uses_physics_parameters: boolean;
  catalog_label: string;
  catalog_tags: string[];
  catalog_intensity: string;
  decomposition_level: string;
  component_count: number;
  component_ids: string[];
  driver_component_count: number;
  driver_component_ids: string[];
  dominant_channels: string[];
  dominant_domains: string[];
  channel_weights: Array<{ name: string; count: number }>;
  domain_weights: Array<{ name: string; count: number }>;
  kind_counts: Array<{ name: string; count: number }>;
  segment_types: Array<{ name: string; count: number }>;
  timeline_profile: {
    intro_energy: number;
    middle_energy: number;
    outro_energy: number;
    peak_window: { start_ratio: number; end_ratio: number };
    motion_trait: string;
  };
  motion_windows: Array<{ start_ratio: number; end_ratio: number }>;
  loop: boolean;
  fps: number;
}

export interface MotionResourceComponent {
  id: string;
  source_motion: string;
  source_file: string;
  source_group: string;
  source_category: string;
  curve_index: number;
  parameter_id: string;
  parameter_name: string;
  kind: string;
  domain: string;
  engine_role: string;
  channels: string[];
  group_name: string;
  duration: number;
  fps: number;
  loop: boolean;
  strength: string;
  trait: string;
  segment_types: string[];
  sample_count: number;
  value_profile: {
    start: number;
    end: number;
    min: number;
    max: number;
    baseline: number;
    span: number;
  };
  peak_abs_value: number;
  peak_time_ratio: number;
  active_ratio: number;
  energy_score: number;
  windows: Array<{ start_ratio: number; end_ratio: number }>;
}

export interface MotionResourcePool {
  decomposition_level: string;
  summary: {
    motion_count: number;
    component_count: number;
    driver_component_count: number;
    overlay_component_count: number;
    channel_pool_count: number;
    domain_pool_count: number;
    parameter_pool_count: number;
  };
  components: MotionResourceComponent[];
  driver_components: MotionResourceComponent[];
  channel_pool: Array<{
    pool_type: string;
    name: string;
    component_count: number;
    strength_counts: Array<{ name: string; count: number }>;
    trait_counts: Array<{ name: string; count: number }>;
    source_motions: string[];
    component_ids: string[];
  }>;
  domain_pool: Array<{
    pool_type: string;
    name: string;
    component_count: number;
    strength_counts: Array<{ name: string; count: number }>;
    trait_counts: Array<{ name: string; count: number }>;
    source_motions: string[];
    component_ids: string[];
  }>;
  parameter_pool: Array<{
    pool_type: string;
    name: string;
    component_count: number;
    strength_counts: Array<{ name: string; count: number }>;
    trait_counts: Array<{ name: string; count: number }>;
    source_motions: string[];
    component_ids: string[];
  }>;
  motion_presets: Array<{
    motion_name: string;
    motion_file: string;
    category: string;
    group: string;
    component_ids: string[];
    dominant_channels: string[];
    dominant_domains: string[];
    intensity: string;
    timeline_profile: {
      intro_energy: number;
      middle_energy: number;
      outro_energy: number;
      peak_window: { start_ratio: number; end_ratio: number };
      motion_trait: string;
    };
    catalog_tags: string[];
  }>;
}

export interface BaseActionAnalysis {
  status: string;
  mode: string;
  provider_id: string;
  input_signature?: string;
  latency_ms?: number;
  cache_hit?: boolean;
  selected_channel_count?: number;
  error?: string;
  fallback_reason?: string;
}

export interface BaseActionFamily {
  name: string;
  label: string;
  channels: string[];
  atom_ids: string[];
  atom_count: number;
}

export interface BaseActionChannel {
  name: string;
  label: string;
  family: string;
  family_label: string;
  domain: string;
  available: boolean;
  primary_parameter_id: string;
  primary_parameter_name: string;
  candidate_parameter_ids: string[];
  candidate_component_count: number;
  selected_atom_count: number;
  polarity_modes: string[];
  atom_ids: string[];
}

export interface BaseActionAtom {
  id: string;
  name: string;
  label: string;
  channel: string;
  channel_label: string;
  family: string;
  family_label: string;
  domain: string;
  polarity: string;
  semantic_polarity: string;
  trait: string;
  strength: string;
  score: number;
  primary_parameter_match: boolean;
  channel_purity: number;
  primary_parameter_id: string;
  parameter_id: string;
  parameter_name: string;
  group_name: string;
  source_component_id: string;
  source_motion: string;
  source_file: string;
  source_group: string;
  source_category: string;
  source_tags: string[];
  duration: number;
  fps: number;
  loop: boolean;
  energy_score: number;
  peak_abs_value: number;
  peak_time_ratio: number;
  active_ratio: number;
  intensity: string;
}

export interface BaseActionLibrary {
  schema_version: string;
  extraction_mode: string;
  analysis: BaseActionAnalysis;
  focus_channels: string[];
  focus_domains: string[];
  ignored_domains: string[];
  summary: {
    motion_count: number;
    available_channel_count: number;
    selected_channel_count: number;
    candidate_component_count: number;
    selected_atom_count: number;
    family_count: number;
  };
  families: BaseActionFamily[];
  channels: BaseActionChannel[];
  atoms: BaseActionAtom[];
}

export interface ParameterActionCounterEntry {
  name: string;
  count: number;
}

export interface ParameterActionAnalysis {
  status: string;
  mode: string;
  provider_id: string;
  error?: string;
}

export interface ParameterActionParameterEntry {
  parameter_id: string;
  parameter_name: string;
  group_name: string;
  kind: string;
  domain: string;
  channels: string[];
  candidate_atom_count: number;
  selected_atom_count: number;
  atom_ids: string[];
}

export interface ParameterActionAtom {
  id: string;
  name: string;
  label: string;
  parameter_id: string;
  parameter_name: string;
  group_name: string;
  kind: string;
  domain: string;
  channels: string[];
  primary_channel: string;
  polarity: string;
  semantic_polarity: string;
  trait: string;
  strength: string;
  score: number;
  source_component_id: string;
  source_motion: string;
  source_file: string;
  source_group: string;
  source_category: string;
  source_tags: string[];
  duration: number;
  fps: number;
  loop: boolean;
  energy_score: number;
  peak_abs_value: number;
  peak_time_ratio: number;
  active_ratio: number;
  intensity: string;
  window_index: number;
  window_start_ratio: number;
  window_end_ratio: number;
  window_duration_ratio: number;
}

export interface ParameterActionLibrary {
  schema_version: string;
  extraction_mode: string;
  analysis: ParameterActionAnalysis;
  summary: {
    motion_count: number;
    driver_component_count: number;
    candidate_atom_count: number;
    selected_atom_count: number;
    candidate_parameter_count: number;
    selected_parameter_count: number;
    domain_count: number;
    channel_count: number;
  };
  domains: ParameterActionCounterEntry[];
  channels: ParameterActionCounterEntry[];
  parameters: ParameterActionParameterEntry[];
  atoms: ParameterActionAtom[];
}

export type DirectParameterAxisName =
  | "head_yaw"
  | "head_roll"
  | "head_pitch"
  | "body_yaw"
  | "body_roll"
  | "body_pitch"
  | "eye_open_left"
  | "eye_open_right"
  | "eye_smile_left"
  | "eye_smile_right"
  | "gaze_x"
  | "gaze_y"
  | "mouth_smile"
  | "mouth_x"
  | "brow_bias"
  | "brow_left_detail"
  | "brow_right_detail"
  | "mouth_open"
  | "breath";

export interface DirectParameterCalibrationRange {
  min?: number | null;
  max?: number | null;
}

export interface DirectParameterAxisCalibration {
  parameter_id?: string;
  parameter_ids?: string[];
  direction?: number | string | null;
  baseline?: number | null;
  clip_min?: number | null;
  clip_max?: number | null;
  output_min?: number | null;
  output_max?: number | null;
  value_min?: number | null;
  value_max?: number | null;
  recommended_range?: DirectParameterCalibrationRange | null;
  observed_range?: DirectParameterCalibrationRange | null;
  confidence?: string | null;
  source?: string | null;
  recommended?: boolean | null;
  safe_to_apply?: boolean | null;
  skip_reason?: string | null;
  supplementary_preferred_parameter_ids?: string[];
  preferred_parameter_ids?: string[];
  supplementary_blocked_parameter_ids?: string[];
  supplementary_excluded_parameter_ids?: string[];
  blocked_parameter_ids?: string[];
  supplementary_max_atoms?: number | null;
  supplementary_top_k?: number | null;
  supplementary_weight_scale?: number | null;
  supplementary_target_scale?: number | null;
}

export interface DirectParameterCalibrationProfile {
  schema_version?: string;
  axes?: Partial<Record<DirectParameterAxisName, DirectParameterAxisCalibration | null>>;
  axis_calibrations?: Partial<Record<DirectParameterAxisName, DirectParameterAxisCalibration | null>>;
}

export interface PerformanceCurveHint {
  schema_version: "ag99.performance_curve_hint.v1";
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

/**
 * Normalized semantic motion intent consumed by ModelEngine.
 */
export interface NormalizedSemanticMotionIntent {
  schema_version: typeof SCHEMA_MOTION_INTENT_V3;
  profile_id: string;
  profile_revision: number;
  model_id: string;
  mode: "expressive" | "idle";
  intent_tags?: string[];
  emotion_label: string;
  duration_hint_ms?: number | null;
  fallback_pose_id?: string;
  performance_curve_hint?: PerformanceCurveHint;
  axes: Record<string, number>;
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
    skeleton_repair_added_axes?: string[];
    skeleton_repair_replaced_axes?: string[];
  };
}

export interface DirectParameterPlanTiming {
  duration_ms: number;
  blend_in_ms: number;
  hold_ms: number;
  blend_out_ms: number;
}

export interface SemanticParameterPlanEntry {
  axis_id: string;
  parameter_id: string;
  target_value: number;
  weight: number;
  input_value?: number;
  source?: SemanticParameterPlanSource;
  modulation?: {
    kind: "speech_pose_cycle";
    neutral: number;
    amplitude: number;
    phase: number;
    frequency_hz?: number;
    direction?: 1 | -1;
  };
}

export const SEMANTIC_PARAMETER_PLAN_SOURCES = [
  "semantic_axis",
  "coupling",
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
  schema_version: typeof SCHEMA_PARAMETER_PLAN_V2;
  profile_id: string;
  profile_revision: number;
  model_id: string;
  mode: "expressive" | "idle";
  emotion_label: string;
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
    skeleton_repair_added_axes?: string[];
    skeleton_repair_replaced_axes?: string[];
  };
}

export type SemanticMotionIntent = NormalizedSemanticMotionIntent;
export type MotionIntentPayload = NormalizedSemanticMotionIntent;
export type MotionPlanPayload = SemanticParameterPlan;

export interface CatalogMotionPayload {
  schema_version: typeof SCHEMA_CATALOG_MOTION_V1;
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
  base_action_library: BaseActionLibrary;
  parameter_action_library: ParameterActionLibrary;
  motion_resource_pool: MotionResourcePool;
  constraints: {
    expressions: ExpressionConstraint[];
    motions: MotionConstraint[];
  };
  semantic_axis_profile?: SemanticAxisProfile | null;
  calibration_profile?: DirectParameterCalibrationProfile | null;
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
  action_filter_cache?: string;
  motion_tuning_samples?: string;
}

export interface ModelSyncInfo {
  schema_version: string;
  driver_priority: string[];
  selected_model: string;
  available_models: string[];
  models: ModelSummary[];
  runtime_cache_errors?: RuntimeCacheErrorsPayload;
}

export interface SystemModelSyncPayload {
  model_info: ModelSyncInfo;
  runtime_cache_errors?: RuntimeCacheErrorsPayload;
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
  id: string;
  created_at: string;
  source_record_id: string;
  model_name: string;
  profile_id: string;
  profile_revision: number;
  emotion_label: string;
  assistant_text: string;
  feedback: string;
  tags: string[];
  enabled_for_llm_reference?: boolean;
  original_axes: Record<string, number>;
  adjusted_axes: Record<string, number>;
  adjusted_plan: MotionPlanPayload;
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
    input: string;
    output: {
      emotion: string;
      mode: string;
      duration_ms?: number | null;
      axes: Record<string, number>;
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
