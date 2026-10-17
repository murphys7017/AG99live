import type { NormalizedMotionPayload, MotionPayloadNormalizer } from "../../types/motion.js";
import type { ProtocolEnvelope } from "../../types/protocol.js";
import { PRE_ACTION_SCHEMA_VERSION } from "../../types/protocolSchema.generated.js";

export type PreActionEvent =
  | { action: "input"; turnId: string }
  | { action: "cancel"; turnId: string | null }
  | { action: "ready"; turnId: string; requestId: string; motion: NormalizedMotionPayload; expiresAt: number };

export function parsePreAction(
  envelope: ProtocolEnvelope<unknown>, normalize: MotionPayloadNormalizer,
): PreActionEvent {
  const p = envelope.payload as Record<string, unknown>;
  if (!envelope.turn_id || p.schema_version !== PRE_ACTION_SCHEMA_VERSION
    || typeof p.request_id !== "string" || !p.request_id.trim()
    || Object.keys(p).sort().join() !== ["schema_version", "request_id", "action", "motion", "expires_at_epoch_ms"].sort().join()) {
    throw new Error("pre_action_identity_invalid");
  }
  if (p.action === "cancel" && p.motion === null && p.expires_at_epoch_ms === null) {
    return { action: "cancel", turnId: envelope.turn_id };
  }
  if (p.action !== "ready" || typeof p.expires_at_epoch_ms !== "number"
    || !Number.isFinite(p.expires_at_epoch_ms)) throw new Error("pre_action_payload_invalid");
  const motion = normalize(p.motion);
  if (!motion.ok) throw new Error(`pre_action_motion_invalid:${motion.reason}`);
  const intent = motion.payload.intent;
  const levels = intent.axis_levels;
  const tags = intent.intent_tags;
  if (!levels || Object.keys(levels).length < 1 || Object.keys(levels).length > 2
    || Object.values(levels).some((v) => !Number.isInteger(v) || Math.abs(v) > 2)
    || !tags || tags.length < 1 || tags.length > 2 || tags.some((tag) => tag.length > 16)
    || intent.motion_steps || intent.motion_resource_id || intent.expression_resource_id) {
    throw new Error("pre_action_execution_shape_invalid");
  }
  return { action: "ready", turnId: envelope.turn_id, requestId: p.request_id,
    motion: motion.payload, expiresAt: p.expires_at_epoch_ms };
}
