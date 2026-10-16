import type { ProtocolEnvelope } from "../../types/protocol.js";
import { SCHEMA_OUTPUT_SEGMENT_V6 } from "../../types/protocolSchema.generated.js";
import type { MotionPayloadNormalizer } from "../../types/motion.js";
import type { useTurnPlaybackSessionStore } from "../../turn-playback/useTurnPlaybackSessionStore.js";
import { parseSegmentMotionSlot } from "./inboundPayloads.js";
import { asRecord, validateExactKeys } from "./payloadValidation.js";

export function applyDeferredMotion(
  envelope: ProtocolEnvelope<unknown>,
  store: ReturnType<typeof useTurnPlaybackSessionStore>,
  normalize: MotionPayloadNormalizer,
): void {
  const payload = asRecord(envelope.payload);
  const turnId = envelope.turn_id;
  const messageId = envelope.message_id;
  if (!payload || payload.schema_version !== SCHEMA_OUTPUT_SEGMENT_V6
    || typeof turnId !== "string" || !turnId.trim()
    || typeof messageId !== "string" || !messageId.trim()
    || !validateExactKeys(envelope.type, "payload", payload, ["schema_version", "motion"]).ok) {
    throw new Error("deferred_motion_envelope_invalid");
  }
  const result = parseSegmentMotionSlot(envelope.type, payload.motion);
  if (!result.ok || result.payload.state === "pending") {
    throw new Error("deferred_motion_result_invalid");
  }
  const motion = result.payload;
  if (motion.state !== "present") {
    store.resolveDeferredMotion(turnId, messageId, motion);
    return;
  }
  const normalized = normalize(motion.payload);
  store.resolveDeferredMotion(turnId, messageId, normalized.ok
    ? { state: "present", payload: normalized.payload, source: motion.source }
    : { state: "failed", reason: `deferred_motion_payload_invalid:${normalized.reason}` });
}
