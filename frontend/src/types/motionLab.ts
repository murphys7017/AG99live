import type { DesktopMotionPlaybackRecord } from "./desktop.js";
import { SCHEMA_MOTION_INTENT_V4, SCHEMA_PARAMETER_PLAN_V3 } from "./protocol.js";

export type MotionLabPreview = {
  motion: Record<string, unknown>;
  semantic_motion?: Record<string, unknown>;
};

export function readMotionLabPreview(raw: Record<string, unknown>): MotionLabPreview | null {
  const record = asRecord(raw.record);
  const plan = asRecord(record?.plan ?? raw.plan);
  const semanticMotion = asRecord(record?.semanticMotion ?? raw.semanticMotion);
  if (plan?.schema_version === SCHEMA_PARAMETER_PLAN_V3 && semanticMotion) {
    return { motion: plan, semantic_motion: semanticMotion };
  }
  const intent = asRecord(raw.intent ?? raw.motion);
  return intent?.schema_version === SCHEMA_MOTION_INTENT_V4 ? { motion: intent } : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface MotionLabRawEvent {
  id: string;
  created_at: string;
  event_type: string;
  conversation_uid?: string | null;
  history_uid?: string | null;
  turn_id?: string | null;
  frontend_turn_id?: string | null;
  message_id?: string | null;
  source_route?: string | null;
  phase?: string | null;
  model_name?: string | null;
  profile_id?: string | null;
  profile_revision?: number | null;
  run_id?: string | null;
  user_text?: string | null;
  assistant_text?: string | null;
  payload_kind?: string | null;
  raw: Record<string, unknown>;
  transform_trace?: Record<string, unknown>;
  timeline_outcome?: Record<string, unknown>;
}

export interface MotionLabEventsResponse {
  platform_id: string;
  connected: boolean;
  events: MotionLabRawEvent[];
}

export function extractMotionPlaybackRecords(
  events: readonly MotionLabRawEvent[],
): DesktopMotionPlaybackRecord[] {
  const records = new Map<string, DesktopMotionPlaybackRecord>();
  for (const event of events) {
    if (event.event_type !== "motion.playback_started") continue;
    const rawRecord = event.raw?.record;
    if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) continue;
    const record = rawRecord as Partial<DesktopMotionPlaybackRecord>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || typeof record.payloadKind !== "string") continue;
    records.set(id, rawRecord as DesktopMotionPlaybackRecord);
  }
  return [...records.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt));
}
