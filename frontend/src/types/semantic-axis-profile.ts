export const SCHEMA_SEMANTIC_AXIS_PROFILE_V1 = "ag99.semantic_axis_profile.v1";

export type SemanticAxisControlRole =
  | "primary"
  | "hint"
  | "derived"
  | "runtime"
  | "ambient"
  | "debug";

export type SemanticAxisProfileStatus =
  | "generated"
  | "user_modified"
  | "stale";

export interface SemanticAxisParameterBinding {
  parameter_id: string;
  parameter_name?: string;
  input_range: [number, number];
  output_range: [number, number];
  default_weight: number;
  invert: boolean;
}

export interface SemanticAxisDefinition {
  id: string;
  label: string;
  description: string;
  semantic_group: string;
  control_role: SemanticAxisControlRole;
  neutral: number;
  value_range: [number, number];
  soft_range: [number, number];
  strong_range: [number, number];
  positive_semantics: string[];
  negative_semantics: string[];
  usage_notes: string;
  parameter_bindings: SemanticAxisParameterBinding[];
}

export interface SemanticAxisCoupling {
  id: string;
  source_axis_id: string;
  target_axis_id: string;
  mode: "same_direction" | "opposite_direction";
  scale: number;
  deadzone: number;
  max_delta: number;
}

export interface SemanticAxisProfile {
  schema_version: typeof SCHEMA_SEMANTIC_AXIS_PROFILE_V1;
  profile_id: string;
  model_id: string;
  source_hash: string;
  last_scanned_hash: string;
  revision: number;
  status: SemanticAxisProfileStatus;
  user_modified: boolean;
  generated_at: string;
  updated_at: string;
  axes: SemanticAxisDefinition[];
  couplings: SemanticAxisCoupling[];
}
