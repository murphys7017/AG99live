import type {
  DirectParameterExecutionPlan,
  DirectParameterPlanInput,
} from "../../../types/direct-parameter-plan";

export type {
  DirectParameterCurvePreset,
  DirectParameterExecutionPlan,
  DirectParameterModulationInput,
  DirectParameterPlanEntryInput,
  DirectParameterPlanInput,
  DirectParameterPlanStartOptions,
  DirectParameterPlanTerminalEvent,
  DirectParameterPlanTerminalStatus,
  DirectParameterResponsePolicy,
  DirectParameterTrackPointInput,
} from "../../../types/direct-parameter-plan";

/** Projects an already validated ModelEngine plan into WebSDK execution timing. */
export function prepareDirectParameterExecution(
  plan: DirectParameterPlanInput,
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
      totalMs: durationMs,
    },
  };
}
