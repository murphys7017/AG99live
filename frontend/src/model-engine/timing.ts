import type { DirectParameterPlan } from "../types/protocol";
import {
  DEFAULT_MOTION_INTENT_DURATION_MS,
  MAX_MOTION_DURATION_MS,
  MIN_MOTION_DURATION_MS,
} from "./constants";
import type { MotionTimingResolution } from "./contracts";

interface ResolveMotionTimingOptions {
  mode: DirectParameterPlan["mode"];
  durationHintMs?: number | null;
  targetDurationMs?: number | null;
}

function coerceDuration(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.max(
    MIN_MOTION_DURATION_MS,
    Math.min(MAX_MOTION_DURATION_MS, Math.round(value)),
  );
}

export function resolveMotionTiming(
  options: ResolveMotionTimingOptions,
): MotionTimingResolution {
  const syncedDuration = coerceDuration(options.targetDurationMs);
  const hintedDuration = coerceDuration(options.durationHintMs);
  let resolvedDurationMs = DEFAULT_MOTION_INTENT_DURATION_MS;
  let timingSource: MotionTimingResolution["timingSource"] = "default";

  if (syncedDuration !== null) {
    resolvedDurationMs = syncedDuration;
    timingSource = "audio_sync";
  } else if (hintedDuration !== null) {
    resolvedDurationMs = hintedDuration;
    timingSource = "hint";
  }

  if (options.mode === "idle") {
    const idleDurationMs = Math.max(480, Math.min(resolvedDurationMs, 2200));
    return {
      timing: {
        duration_ms: idleDurationMs,
        blend_in_ms: 80,
        hold_ms: Math.max(220, idleDurationMs - 200),
        blend_out_ms: 120,
      },
      resolvedDurationMs: idleDurationMs,
      timingSource,
    };
  }

  let blendInMs = Math.max(
    80,
    Math.min(Math.round(resolvedDurationMs * 0.18), 360),
  );
  let blendOutMs = Math.max(
    120,
    Math.min(Math.round(resolvedDurationMs * 0.25), 520),
  );
  let holdMs = resolvedDurationMs - blendInMs - blendOutMs;

  if (holdMs < 120) {
    let shortage = 120 - holdMs;
    const reducibleOut = Math.max(blendOutMs - 120, 0);
    const reduceOut = Math.min(shortage, reducibleOut);
    blendOutMs -= reduceOut;
    shortage -= reduceOut;
    blendInMs = Math.max(80, blendInMs - shortage);
    holdMs = Math.max(120, resolvedDurationMs - blendInMs - blendOutMs);
  }

  return {
    timing: {
      duration_ms: resolvedDurationMs,
      blend_in_ms: blendInMs,
      hold_ms: holdMs,
      blend_out_ms: blendOutMs,
    },
    resolvedDurationMs,
    timingSource,
  };
}
