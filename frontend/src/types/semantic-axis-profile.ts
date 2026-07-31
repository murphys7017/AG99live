export {
  SCHEMA_SEMANTIC_AXIS_PROFILE_V3,
  SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1,
} from "./protocolSchema.generated.js";
import {
  SCHEMA_SEMANTIC_AXIS_PROFILE_V3,
  SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1,
} from "./protocolSchema.generated.js";

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

export interface SemanticAxisDynamics {
  max_velocity: number;
  max_acceleration: number;
  max_speech_offset_ratio: number;
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
  extreme_range: [number, number];
  level_anchors?: Record<string, number>;
  positive_semantics: string[];
  negative_semantics: string[];
  usage_notes: string;
  dynamics: SemanticAxisDynamics;
  parameter_bindings: SemanticAxisParameterBinding[];
}

export type SemanticAxisRelationRuleKind = "derive" | "bounded_ratio";

export interface SemanticAxisRelationRule {
  id: string;
  source_axis_id: string;
  target_axis_id: string;
  kind: SemanticAxisRelationRuleKind;
  mode: "same_direction" | "opposite_direction";
  scale: number;
  deadzone: number;
  max_delta: number;
}

export interface SemanticAxisRelationGraph {
  schema_version: typeof SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1;
  edges: SemanticAxisRelationRule[];
}

export interface SemanticAxisProfile {
  schema_version: typeof SCHEMA_SEMANTIC_AXIS_PROFILE_V3;
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
  relation_graph: SemanticAxisRelationGraph;
}
