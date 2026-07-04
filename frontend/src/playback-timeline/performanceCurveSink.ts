import type { PerformanceCurveHint } from "../types/protocol.js";
import type { PlaybackTimelineSnapshot } from "./contracts.js";

export type PerformanceCurveTimelineSource = "audio" | "synthetic";

export type PerformanceCurveTimelineResolution =
  | {
    ok: true;
    clockSource: PerformanceCurveTimelineSource;
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

function coercePositiveDurationMs(value: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.round(value);
}

function resolveTimelineDurationMs(
  timeline: PlaybackTimelineSnapshot,
  minRemainingDurationMs: number,
): number | null {
  const durationMs = coercePositiveDurationMs(timeline.durationMs);
  if (durationMs === null) {
    return null;
  }
  if (timeline.phase !== "playing" && timeline.phase !== "paused") {
    return durationMs;
  }
  const currentTimeMs = Number.isFinite(timeline.currentTimeMs)
    ? Math.max(0, Math.round(timeline.currentTimeMs))
    : 0;
  return Math.max(minRemainingDurationMs, durationMs - currentTimeMs);
}

export function resolvePerformanceCurveTimeline(
  options: {
    hint?: PerformanceCurveHint | null;
    timeline?: PlaybackTimelineSnapshot | null;
    minRemainingDurationMs: number;
  },
): PerformanceCurveTimelineResolution {
  if (!options.hint) {
    return {
      ok: false,
      reason: "performance_curve_hint_missing",
    };
  }
  const timeline = options.timeline;
  if (!timeline) {
    return {
      ok: false,
      reason: "playback_timeline_missing",
    };
  }
  if (timeline.clockSource === "audio_unavailable") {
    return {
      ok: false,
      reason: "playback_timeline_audio_unavailable",
    };
  }
  if (timeline.clockSource !== "audio" && timeline.clockSource !== "synthetic") {
    return {
      ok: false,
      reason: "playback_timeline_duration_missing",
    };
  }

  const targetDurationMs = resolveTimelineDurationMs(
    timeline,
    options.minRemainingDurationMs,
  );
  if (targetDurationMs === null) {
    return {
      ok: false,
      reason: timeline.durationMs === null
        ? "playback_timeline_duration_missing"
        : "playback_timeline_duration_invalid",
    };
  }

  return {
    ok: true,
    clockSource: timeline.clockSource,
    targetDurationMs,
    speechActive:
      timeline.clockSource === "audio"
      && (timeline.phase === "playing" || timeline.phase === "paused"),
  };
}
