import type {
  ModelSummary,
  MotionPlanPayload,
  OutputSegmentSpeechCue,
} from "../../types/protocol.js";
import type {
  CompileDiagnostics,
  CompiledSemanticMotion,
} from "../../types/compiledSemanticMotion.js";
import type { ModelEngineSettings } from "../settings.js";

export type MotionAxisValueSource =
  | "semantic_axis"
  | "relation_graph"
  | "speech_pose"
  | "expression"
  | "continuity";

export interface CompileOptions {
  model: ModelSummary;
  assistantText?: string;
  speechCues?: readonly OutputSegmentSpeechCue[];
  targetDurationMs?: number | null;
  speechActive?: boolean;
  source?: string;
  settings?: Partial<ModelEngineSettings>;
  runtimeWarnings?: readonly string[];
  samplingIdentity?: {
    turnId: string;
    messageId: string;
  };
  allowNeutralAxisPose?: boolean;
}

export interface MotionFeedback {
  code: string;
  message: string;
  fields: string[];
}

export interface CompileResult {
  ok: boolean;
  plan: MotionPlanPayload | null;
  reason: string;
  diagnostics: CompileDiagnostics;
  feedback?: MotionFeedback;
  semanticMotion?: CompiledSemanticMotion;
}

export type CompileSemanticMotionResult =
  | {
      ok: true;
      motion: CompiledSemanticMotion;
      reason: "";
    }
  | {
      ok: false;
      motion: null;
      reason: string;
      diagnostics: CompileDiagnostics;
      feedback: MotionFeedback;
    };
