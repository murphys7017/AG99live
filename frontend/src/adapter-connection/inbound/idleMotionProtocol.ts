import type { MotionPayloadNormalizer, NormalizedMotionPayload } from "../../types/motion.js";
import type { ProtocolEnvelope } from "../../types/protocol.js";

export interface IdleMotionEvent {
  messageId: string;
  motion: NormalizedMotionPayload;
  expiresAt: number;
}

export function parseIdleMotion(
  envelope: ProtocolEnvelope<unknown>, normalize: MotionPayloadNormalizer,
): IdleMotionEvent {
  const payload = envelope.payload;
  if (envelope.turn_id !== null || !payload || typeof payload !== "object"
    || Array.isArray(payload)) throw new Error("idle_motion_envelope_invalid");
  const p = payload as Record<string, unknown>;
  if (Object.keys(p).sort().join() !== "expires_at_epoch_ms,motion"
    || typeof p.expires_at_epoch_ms !== "number" || !Number.isFinite(p.expires_at_epoch_ms)) {
    throw new Error("idle_motion_payload_invalid");
  }
  const motion = normalize(p.motion);
  if (!motion.ok) throw new Error(`idle_motion_invalid:${motion.reason}`);
  if (motion.payload.kind !== "semantic_intent"
    || motion.payload.intent.motion_resource_id || motion.payload.intent.expression_resource_id
    || motion.payload.intent.motion_steps) throw new Error("idle_motion_shape_invalid");
  return { messageId: envelope.message_id, motion: motion.payload, expiresAt: p.expires_at_epoch_ms };
}
