import type { DesktopLatencyStage } from "../../types/latency.js";

/** Record event time in one renderer clock domain, without conversation content. */
export function reportLatencyStage(
  stage: DesktopLatencyStage,
  turnId: string | null,
  streamId: string | null = null,
  messageId: string | null = null,
): void {
  if (typeof window === "undefined") return;
  window.ag99desktop?.reportLatencyEvent?.({
    type: "pipeline_stage",
    stage,
    turnId,
    streamId,
    messageId,
    monotonicMs: performance.now(),
    timeOriginMs: performance.timeOrigin,
    timestampEpochMs: Date.now(),
  });
}
