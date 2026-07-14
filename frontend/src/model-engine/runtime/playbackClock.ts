import type {
  PerformanceCurveHint,
  SemanticParameterPlan,
} from "../../types/protocol.js";
import { parseSemanticParameterPlan } from "../planParser.js";

export type MotionPlaybackClockSource = "audio" | "synthetic" | "audio_unavailable";
export type MotionPlaybackClockPhase =
  | "preparing"
  | "ready"
  | "playing"
  | "paused"
  | "terminal";

export interface MotionPlaybackClockContext {
  timelineId: string;
  turnId: string | null;
  messageId: string;
  source: MotionPlaybackClockSource;
  phase: MotionPlaybackClockPhase;
  startedAtMs: number | null;
  currentTimeMs: number;
  durationMs: number | null;
}

export type MotionTimelinePreparationResult =
  | {
    status: "prepared";
    source: "queued_motion" | "speech_only";
  }
  | {
    status: "not_applicable";
    reason: string;
  }
  | {
    status: "failed";
    reason: string;
  };

export type PerformanceCurveTimelineResolution =
  | {
    ok: true;
    clockSource: "audio" | "synthetic";
    targetDurationMs: number;
    speechActive: boolean;
  }
  | {
    ok: false;
    reason:
      | "performance_curve_hint_missing"
      | "playback_timeline_missing"
      | "playback_timeline_audio_unavailable"
      | "playback_timeline_duration_missing"
      | "playback_timeline_duration_invalid";
  };

function positiveDurationMs(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

export function resolvePlaybackTargetDurationMs(
  clock: MotionPlaybackClockContext | null | undefined,
  minRemainingDurationMs: number,
): number | null {
  if (!clock || clock.source === "audio_unavailable") {
    return null;
  }
  const durationMs = positiveDurationMs(clock.durationMs);
  if (durationMs === null) {
    return null;
  }
  if (clock.phase !== "playing" && clock.phase !== "paused") {
    return durationMs;
  }
  const currentTimeMs = Number.isFinite(clock.currentTimeMs)
    ? Math.max(0, Math.round(clock.currentTimeMs))
    : 0;
  return Math.max(minRemainingDurationMs, durationMs - currentTimeMs);
}

export function resolvePerformanceCurveTimeline(options: {
  hint?: PerformanceCurveHint | null;
  clock?: MotionPlaybackClockContext | null;
  minRemainingDurationMs: number;
}): PerformanceCurveTimelineResolution {
  if (!options.hint) {
    return { ok: false, reason: "performance_curve_hint_missing" };
  }
  const clock = options.clock;
  if (!clock) {
    return { ok: false, reason: "playback_timeline_missing" };
  }
  if (clock.source === "audio_unavailable") {
    return { ok: false, reason: "playback_timeline_audio_unavailable" };
  }
  const targetDurationMs = resolvePlaybackTargetDurationMs(
    clock,
    options.minRemainingDurationMs,
  );
  if (targetDurationMs === null) {
    return {
      ok: false,
      reason: clock.durationMs === null
        ? "playback_timeline_duration_missing"
        : "playback_timeline_duration_invalid",
    };
  }
  return {
    ok: true,
    clockSource: clock.source,
    targetDurationMs,
    speechActive:
      clock.source === "audio"
      && clock.phase !== "terminal",
  };
}

export function retimeSemanticParameterPlan(
  plan: SemanticParameterPlan,
  targetDurationMs: number | null | undefined,
): SemanticParameterPlan {
  if (targetDurationMs === null || targetDurationMs === undefined) {
    return plan;
  }
  if (!Number.isFinite(targetDurationMs) || targetDurationMs <= 0) {
    throw new Error("Motion plan target duration must be a positive finite number.");
  }
  const requestedDurationMs = Math.max(320, Math.min(15000, Math.round(targetDurationMs)));
  if (Math.abs(requestedDurationMs - plan.timing.duration_ms) <= 80) {
    return plan;
  }

  const sourceDurationMs = Math.max(plan.timing.duration_ms, 1);
  const sourceTotalMs = Math.max(
    sourceDurationMs,
    plan.timing.blend_in_ms + plan.timing.hold_ms + plan.timing.blend_out_ms,
  );
  const blendInMs = Math.max(
    60,
    Math.round(requestedDurationMs * plan.timing.blend_in_ms / sourceTotalMs),
  );
  const blendOutMs = Math.max(
    80,
    Math.round(requestedDurationMs * plan.timing.blend_out_ms / sourceTotalMs),
  );
  const holdMs = Math.max(120, requestedDurationMs - blendInMs - blendOutMs);
  const durationMs = blendInMs + holdMs + blendOutMs;
  const scale = durationMs / sourceDurationMs;

  const retimed = {
    ...plan,
    timing: {
      ...plan.timing,
      duration_ms: durationMs,
      blend_in_ms: blendInMs,
      hold_ms: holdMs,
      blend_out_ms: blendOutMs,
    },
    parameters: plan.parameters.map((parameter) => ({
      ...parameter,
      keyframes: parameter.keyframes?.map((keyframe) => ({
        ...keyframe,
        at_ms: Math.min(durationMs, Math.round(keyframe.at_ms * scale)),
        transition_ms: Math.round(keyframe.transition_ms * scale),
      })),
      modulation: parameter.modulation
        ? retimeSpeechGestureTrack(
          parameter.modulation,
          sourceDurationMs,
          durationMs,
        )
        : undefined,
    })),
  };
  const parsed = parseSemanticParameterPlan(retimed);
  if (!parsed.ok) {
    throw new Error(`Retimed motion plan is invalid: ${parsed.reason}`);
  }
  return parsed.value;
}

function retimeSpeechGestureTrack(
  modulation: NonNullable<SemanticParameterPlan["parameters"][number]["modulation"]>,
  sourceDurationMs: number,
  targetDurationMs: number,
): NonNullable<SemanticParameterPlan["parameters"][number]["modulation"]> {
  const sourceActiveDurationMs = sourceDurationMs - modulation.delay_ms;
  const targetActiveDurationMs = targetDurationMs - modulation.delay_ms;
  if (sourceActiveDurationMs <= 0 || targetActiveDurationMs <= 0) {
    throw new Error("Speech gesture delay must be shorter than the motion duration.");
  }
  const activeScale = targetActiveDurationMs / sourceActiveDurationMs;
  return {
    ...modulation,
    points: modulation.points.map((point) => ({
      ...point,
      at_ms: Math.round(point.at_ms * activeScale),
      transition_ms: Math.round(point.transition_ms * activeScale),
    })),
  };
}
