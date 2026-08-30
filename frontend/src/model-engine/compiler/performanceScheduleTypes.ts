import type {
  PerformanceParameterNodeTrace,
  PerformanceTimingEventTrace,
} from "../../types/compiledSemanticMotion.js";
import type { OutputSegmentSpeechCue } from "../../types/protocol.js";

export type PerformancePhraseBoundary = "strong" | "soft" | "none";

export interface PerformancePhraseSlot {
  readonly index: number;
  readonly sourcePhraseIndex: number;
  readonly text: string;
  readonly boundary: PerformancePhraseBoundary;
  readonly weight: number;
  readonly emphasis: number;
  readonly startRatio: number;
  readonly endRatio: number;
}

export interface PerformanceSpeechCueMapping {
  readonly cueIndex: number;
  readonly kind: OutputSegmentSpeechCue["kind"];
  readonly sourcePhraseIndex: number;
  readonly position: OutputSegmentSpeechCue["position"];
  readonly targetPhraseIndices: readonly number[];
  readonly status: "mapped" | "ignored";
  readonly reason: string;
}

export interface PerformanceSemanticStepSlot {
  readonly index: number;
  readonly durationWeight: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly startRatio: number;
  readonly endRatio: number;
}

export interface PerformancePhraseStepAlignment {
  readonly kind: "estimated_time_overlap";
  readonly phraseIndex: number;
  readonly stepIndex: number;
  readonly overlapRatio: number;
  readonly phraseCoverageRatio: number;
  readonly stepCoverageRatio: number;
  readonly primaryForPhrase: boolean;
}

export type PerformanceHesitationReason = NonNullable<
  PerformanceTimingEventTrace["hesitationReason"]
>;

export interface PerformanceHesitationWindow {
  readonly index: number;
  readonly reason: PerformanceHesitationReason;
  readonly startMs: number;
  readonly resumeMs: number;
  readonly holdMs: number;
  readonly stepIndex?: number;
  readonly afterPhraseIndex?: number;
  readonly phraseIndices?: readonly number[];
}

export interface PerformanceSequenceStepInput {
  readonly durationWeight: number;
  readonly axes: readonly {
    readonly axisId: string;
    readonly value: number;
    readonly neutralValue: number;
  }[];
}

export interface PerformanceSchedule {
  readonly durationMs: number;
  readonly textSource: "assistant_text" | "duration_only";
  readonly phrases: readonly PerformancePhraseSlot[];
  readonly speechCueMappings: readonly PerformanceSpeechCueMapping[];
  readonly semanticSteps: readonly PerformanceSemanticStepSlot[];
  readonly estimatedAlignments: readonly PerformancePhraseStepAlignment[];
  readonly hesitationWindows: readonly PerformanceHesitationWindow[];
  readonly decisions: readonly string[];
  readonly events: readonly PerformanceTimingEventTrace[];
  readonly parameterNodes: readonly PerformanceParameterNodeTrace[];
}

export type PerformanceScheduleCompileResult =
  | { ok: true; schedule: PerformanceSchedule; reason: "" }
  | { ok: false; schedule: null; reason: string };

export type PerformancePartTrackStrategy = "semantic" | "gaze" | "face";
export type PerformanceStagedPartTrackStrategy = Exclude<
  PerformancePartTrackStrategy,
  "semantic"
>;

export interface PerformancePartTrackTiming {
  readonly strategy: PerformancePartTrackStrategy;
  readonly events: readonly PerformanceTimingEventTrace[];
  readonly parameterEvents: readonly PerformanceTimingEventTrace[];
  readonly requiredOwnedUntilMs: number;
  readonly staggered: boolean;
  readonly residual: boolean;
  readonly compressed: boolean;
}

export interface PerformanceSpeechPhraseGroup {
  readonly phraseIndices: readonly number[];
  readonly text: string;
  readonly emphasis: number;
  readonly startRatio: number;
  readonly endRatio: number;
}

export interface PerformanceSpeechTrackTiming {
  readonly events: readonly PerformanceTimingEventTrace[];
  readonly phraseEvents: readonly PerformanceTimingEventTrace[];
}

export type PerformanceScheduleMutationResult<T> =
  | { ok: true; value: T; reason: "" }
  | { ok: false; value: null; reason: string };
