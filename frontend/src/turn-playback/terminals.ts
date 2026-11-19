export type TurnTerminal = "completed" | "failed" | "interrupted";
export const SPEECH_MOTION_HANDOFF_FAILED = "speech_motion_handoff_failed";
export type SinkTerminal =
  | "idle"
  | "started"
  | "completed"
  | "failed"
  | "absent"
  | "interrupted";

export function isTurnTerminal(value: string): value is TurnTerminal {
  return value === "completed" || value === "failed" || value === "interrupted";
}

export function isSinkTerminal(value: string): value is Exclude<SinkTerminal, "idle" | "started"> {
  return value === "completed"
    || value === "failed"
    || value === "absent"
    || value === "interrupted";
}

export function sinkTerminalToTurnTerminal(
  value: Exclude<SinkTerminal, "idle" | "started">,
): TurnTerminal {
  return value === "completed" || value === "absent" ? "completed" : value;
}

/** A replacement transfers presentation ownership rather than failing playback. */
export function resolveMotionTerminal(event: { status: string; reason?: string }): TurnTerminal {
  if (event.status === "completed" || (event.status === "stopped"
    && (event.reason === "direct_parameter_plan_replaced" || event.reason === "motion_replaced"))) {
    return "completed";
  }
  return event.status === "stopped" ? "interrupted" : "failed";
}
