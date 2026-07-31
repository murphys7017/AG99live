import type { PerformanceCurveHint } from "../../types/protocol.js";

export type MotionPlaybackClockSource =
  | "audio"
  | "audio_tail_continuation"
  | "audio_pending"
  | "synthetic"
  | "audio_unavailable";
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
    source?: "queued_motion" | "speech_only";
  };

export type PerformanceCurveTimelineResolution =
  | {
    ok: true;
      clockSource: "audio" | "audio_tail_continuation" | "audio_pending" | "synthetic";
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
      (clock.source === "audio" || clock.source === "audio_pending")
      && clock.phase !== "terminal",
  };
}
