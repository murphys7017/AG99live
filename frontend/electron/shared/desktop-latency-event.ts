import type { DesktopLatencyEvent } from "../../src/types/desktop";
import { DESKTOP_LATENCY_STAGES } from "../../src/types/latency.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoundedString(value: unknown, maxLength = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function parseDesktopLatencyEvent(value: unknown): DesktopLatencyEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.type === "pipeline_stage"
    && DESKTOP_LATENCY_STAGES.some((stage) => stage === value.stage)
    && (value.turnId === null || isBoundedString(value.turnId))
    && (value.streamId === null || isBoundedString(value.streamId))
    && isFiniteNonNegativeNumber(value.monotonicMs)
    && isFiniteNonNegativeNumber(value.timeOriginMs)
    && isFiniteNonNegativeNumber(value.timestampEpochMs)
  ) {
    return {
      type: value.type,
      stage: value.stage as typeof DESKTOP_LATENCY_STAGES[number],
      turnId: value.turnId,
      streamId: value.streamId,
      monotonicMs: value.monotonicMs,
      timeOriginMs: value.timeOriginMs,
      timestampEpochMs: value.timestampEpochMs,
    };
  }

  if (
    value.type === "audio_capture_ended"
    && isBoundedString(value.turnId)
    && isBoundedString(value.streamId)
    && isBoundedString(value.captureMode, 32)
    && isBoundedString(value.reason, 64)
    && typeof value.dropped === "boolean"
    && isFiniteNonNegativeNumber(value.captureEndedAtMonotonicMs)
    && isFiniteNonNegativeNumber(value.timestampEpochMs)
  ) {
    return {
      type: value.type,
      turnId: value.turnId,
      streamId: value.streamId,
      captureMode: value.captureMode,
      reason: value.reason,
      dropped: value.dropped,
      captureEndedAtMonotonicMs: value.captureEndedAtMonotonicMs,
      timestampEpochMs: value.timestampEpochMs,
    };
  }

  if (
    value.type === "audio_playback_started"
    && (value.turnId === null || isBoundedString(value.turnId))
    && (value.durationMs === null || isFiniteNonNegativeNumber(value.durationMs))
    && isFiniteNonNegativeNumber(value.startedAtMonotonicMs)
    && isFiniteNonNegativeNumber(value.timestampEpochMs)
  ) {
    return {
      type: value.type,
      turnId: value.turnId,
      durationMs: value.durationMs,
      startedAtMonotonicMs: value.startedAtMonotonicMs,
      timestampEpochMs: value.timestampEpochMs,
    };
  }

  return null;
}
