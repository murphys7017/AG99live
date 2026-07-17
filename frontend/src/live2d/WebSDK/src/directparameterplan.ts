import type { SemanticParameterPlan } from "../../../types/protocol";

export interface DirectParameterExecutionPlan {
  plan: SemanticParameterPlan;
  timing: {
    durationMs: number;
    blendInMs: number;
    holdMs: number;
    blendOutMs: number;
    curvePreset:
      | "smooth_hold"
      | "snap_hold_soft_release"
      | "slow_build_quick_release"
      | "pulse_settle"
      | "breathing_swell";
    totalMs: number;
  };
  reason: "";
}

/** Projects an already validated ModelEngine plan into WebSDK execution timing. */
export function prepareDirectParameterExecution(
  plan: SemanticParameterPlan,
): DirectParameterExecutionPlan {
  const {
    duration_ms: durationMs,
    blend_in_ms: blendInMs,
    hold_ms: holdMs,
    blend_out_ms: blendOutMs,
    curve_preset: curvePreset = "smooth_hold",
  } = plan.timing;

  return {
    plan,
    timing: {
      durationMs,
      blendInMs,
      holdMs,
      blendOutMs,
      curvePreset,
      totalMs: Math.max(durationMs, blendInMs + holdMs + blendOutMs),
    },
    reason: "",
  };
}
