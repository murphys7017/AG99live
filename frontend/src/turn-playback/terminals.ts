export type TurnTerminal = "completed" | "failed" | "interrupted";
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
