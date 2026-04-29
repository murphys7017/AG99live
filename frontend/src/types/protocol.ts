import type { SemanticAxisProfile } from "./semantic-axis-profile";

export interface ProtocolEnvelope<TPayload = unknown> {
  type: string;
  version: string;
  message_id: string;
  timestamp: string;
  session_id: string;
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
}

export interface OutputAudioPayload {
  audio_url: string | null;
  text: string;
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
  | "gaze_x"
  | "gaze_y"
  | "eye_open_left"
  | "eye_open_right"
  | "mouth_open"
  | "mouth_smile"
  | "brow_bias";

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

export interface SemanticMotionIntentAxisValue {
  value: number;
}

export interface SemanticMotionIntent {
  schema_version: "engine.motion_intent.v2";
  profile_id: string;
  profile_revision: number;
  model_id: string;
  mode: "expressive" | "idle";
  emotion_label: string;
  duration_hint_ms?: number | null;
  axes: Record<string, SemanticMotionIntentAxisValue>;
  summary?: {
    axis_count?: number;
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
  source?: "semantic_axis" | "coupling" | "manual";
}

export interface SemanticParameterPlan {
  schema_version: "engine.parameter_plan.v2";
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
  };
}

export type MotionIntentPayload = SemanticMotionIntent;
export type MotionPlanPayload = SemanticParameterPlan;

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
  engine_hints: {
    driver_priority: string[];
    recommended_mode: string;
    available_channels: string[];
    base_expression_count: number;
    fallback_motion_count: number;
    motion_decomposition_level: string;
  };
}

export interface ModelSyncInfo {
  schema_version: string;
  driver_priority: string[];
  selected_model: string;
  available_models: string[];
  models: ModelSummary[];
}

export interface SystemModelSyncPayload {
  model_info: ModelSyncInfo;
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
  samples: MotionTuningSampleProtocolPayload[];
}
