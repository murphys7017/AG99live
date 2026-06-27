import type { DirectParameterPlanTiming, PerformanceCurveHint } from "../types/protocol";
import {
  DEFAULT_MOTION_INTENT_DURATION_MS,
  MAX_MOTION_DURATION_MS,
  MIN_MOTION_DURATION_MS,
} from "./constants.js";
import type { MotionTimingResolution } from "./compiler/contracts.js";

interface ResolveMotionTimingOptions {
  mode: "idle" | "expressive";
  durationHintMs?: number | null;
  targetDurationMs?: number | null;
  speechActive?: boolean;
  performanceCurveHint?: PerformanceCurveHint | null;
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

export function buildParameterPlanTiming(
  durationMsRaw: number,
  mode: "expressive" | "idle",
): DirectParameterPlanTiming {
  const clampedDurationMs = Math.max(400, Math.min(6000, Math.round(durationMsRaw)));
  return resolveMotionTiming({ mode, durationHintMs: clampedDurationMs }).timing;
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
    const idleDurationMs =
      options.speechActive === true && syncedDuration !== null
        ? resolvedDurationMs
        : Math.max(480, Math.min(resolvedDurationMs, 2200));
    const curveTiming = resolvePerformanceCurveTiming({
      durationMs: idleDurationMs,
      hint: options.performanceCurveHint,
    });
    if (curveTiming) {
      return {
        timing: curveTiming,
        resolvedDurationMs: idleDurationMs,
        timingSource,
        performanceCurveFamily: options.performanceCurveHint?.curve_family,
      };
    }
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

  const curveTiming = resolvePerformanceCurveTiming({
    durationMs: resolvedDurationMs,
    hint: options.performanceCurveHint,
  });
  if (curveTiming) {
    return {
      timing: curveTiming,
      resolvedDurationMs,
      timingSource,
      performanceCurveFamily: options.performanceCurveHint?.curve_family,
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

interface ResolvePerformanceCurveTimingOptions {
  durationMs: number;
  hint?: PerformanceCurveHint | null;
}

export function resolvePerformanceCurveTiming(
  options: ResolvePerformanceCurveTimingOptions,
): DirectParameterPlanTiming | null {
  const hint = options.hint;
  if (!hint || hint.schema_version !== "ag99.performance_curve_hint.v1") {
    return null;
  }

  const durationMs = coerceDuration(options.durationMs);
  if (durationMs === null) {
    return null;
  }

  let entryRatio = entryRatioFor(hint.entry);
  let exitRatio = exitRatioFor(hint.exit);

  switch (hint.curve_family) {
    case "quick_in_hold_soft_out":
      entryRatio = Math.min(entryRatio, 0.10);
      exitRatio = Math.max(exitRatio, 0.22);
      break;
    case "slow_in_hold_quick_out":
      entryRatio = Math.max(entryRatio, 0.22);
      exitRatio = Math.min(exitRatio, 0.14);
      break;
    case "pulse_then_settle":
      entryRatio = Math.min(entryRatio, 0.09);
      exitRatio = Math.max(exitRatio, 0.20);
      break;
    case "soft_breathe":
      entryRatio = Math.max(entryRatio, 0.18);
      exitRatio = Math.max(exitRatio, 0.26);
      break;
    default:
      break;
  }

  if (hint.hold === "short") {
    entryRatio += 0.02;
    exitRatio += 0.02;
  } else if (hint.hold === "long") {
    entryRatio -= 0.02;
    exitRatio -= 0.02;
  } else if (hint.hold === "breathing") {
    entryRatio += 0.01;
    exitRatio += 0.04;
  }

  if (hint.energy === "high" || hint.energy === "teasing") {
    entryRatio = Math.max(0.04, entryRatio - 0.03);
  } else if (hint.energy === "low" || hint.energy === "calm") {
    entryRatio += 0.03;
    exitRatio += 0.03;
  }

  let blendInMs = clampMs(Math.round(durationMs * entryRatio), 60, 480);
  let blendOutMs = clampMs(Math.round(durationMs * exitRatio), 100, 720);
  let holdMs = durationMs - blendInMs - blendOutMs;

  if (holdMs < 120) {
    let shortage = 120 - holdMs;
    const reducibleOut = Math.max(blendOutMs - 100, 0);
    const reduceOut = Math.min(shortage, reducibleOut);
    blendOutMs -= reduceOut;
    shortage -= reduceOut;
    blendInMs = Math.max(60, blendInMs - shortage);
    holdMs = Math.max(120, durationMs - blendInMs - blendOutMs);
  }

  return {
    duration_ms: durationMs,
    blend_in_ms: blendInMs,
    hold_ms: holdMs,
    blend_out_ms: blendOutMs,
  };
}

function entryRatioFor(entry: PerformanceCurveHint["entry"]): number {
  switch (entry) {
    case "instant":
      return 0.04;
    case "quick":
      return 0.10;
    case "slow":
      return 0.24;
    case "soft":
    default:
      return 0.16;
  }
}

function exitRatioFor(exitKind: PerformanceCurveHint["exit"]): number {
  switch (exitKind) {
    case "quick":
      return 0.12;
    case "slow":
      return 0.30;
    case "soft":
    default:
      return 0.22;
  }
}

function clampMs(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
