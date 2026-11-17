import type { AdapterOutboundClient } from "../outbound/outboundClient.js";

/** Mirrors playback facts only; captions never gate or acknowledge playback. */
export function createSubtitleReporter(client: AdapterOutboundClient) {
  let sequence = 0;
  let active: { turnId: string; segmentId: string; text: string } | null = null;
  function send(state: "speaking" | "text" | "ended" | "clear", value: NonNullable<typeof active>): void {
    client.send("system.subtitle_state", {
      schema_version: "ag99.subtitle.v1", sequence: ++sequence,
      state, segment_id: value.segmentId, text: value.text.slice(0, 8192),
    }, value.turnId);
  }
  return {
    show(text: string, turnId: string | null, segmentId: string, speaking = true): void {
      if (!turnId || !text.trim()) return;
      active = { text, turnId, segmentId };
      send(speaking ? "speaking" : "text", active);
    },
    end(turnId?: string | null, segmentId?: string): void {
      if (active && (!turnId || active.turnId === turnId)
        && (!segmentId || active.segmentId === segmentId)) send("ended", active);
    },
    clear(turnId?: string | null, segmentId?: string): void {
      if (active && (!turnId || active.turnId === turnId)
        && (!segmentId || active.segmentId === segmentId)) {
        send("clear", active);
        active = null;
      }
    },
  };
}
