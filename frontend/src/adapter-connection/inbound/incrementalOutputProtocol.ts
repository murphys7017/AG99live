import type { ProtocolEnvelope } from "../../types/protocol.js";
import type { IncrementalIdentity, IncrementalResource, IncrementalStatus } from "../../turn-playback/incrementalSegments.js";
import type { OutputAudioFrameMetadata } from "./outputAudioFrame.js";

export type IncrementalOutputEvent =
  | { kind: "start"; resource: IncrementalResource; identity: IncrementalIdentity }
  | { kind: "delta"; resource: "text"; identity: IncrementalIdentity; text: string }
  | { kind: "end"; resource: IncrementalResource; identity: IncrementalIdentity;
      status: IncrementalStatus; reason: string; length?: number };

export function incrementalIdentityString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > 256) {
    throw new Error(`incremental_output_identity_invalid:${field}`);
  }
  return value;
}
function sequence(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`incremental_output_sequence_invalid:${field}`);
  }
  return value;
}
function identity(value: Record<string, unknown>, turnId: unknown): IncrementalIdentity {
  if (value.schema_version !== "olv.incremental_output.v1") throw new Error("incremental_output_schema_invalid");
  if (value.turn_id !== undefined && value.turn_id !== turnId) throw new Error("incremental_output_turn_mismatch");
  return {
    turnId: incrementalIdentityString(turnId, "turn_id"),
    coreTurnId: incrementalIdentityString(value.core_turn_id, "core_turn_id"),
    personaResultId: incrementalIdentityString(value.persona_result_id, "persona_result_id"),
    messageId: incrementalIdentityString(value.segment_message_id, "segment_message_id"),
    streamId: incrementalIdentityString(value.stream_id, "stream_id"),
    segmentIndex: sequence(value.segment_index, "segment_index"),
    seq: sequence(value.seq, "seq"),
  };
}
export function identityFromAudioFrame(value: OutputAudioFrameMetadata): IncrementalIdentity {
  return identity({ ...value }, value.turn_id);
}

/** Returns null for ordinary envelopes; malformed incremental events throw. */
export function parseIncrementalOutputEvent(envelope: ProtocolEnvelope<unknown>): IncrementalOutputEvent | null {
  const match = /^output\.(text|audio|motion)_stream_(start|delta|end|update)$/.exec(envelope.type);
  if (!match) return null;
  const resource = match[1];
  if (resource !== "text" && resource !== "audio" && resource !== "motion") return null;
  const value = envelope.payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("incremental_output_payload_invalid");
  const payload = value as Record<string, unknown>;
  const id = identity(payload, envelope.turn_id);
  const kind = match[2];
  if (kind === "start") {
    if (id.seq !== 0) throw new Error("incremental_output_start_sequence_invalid");
    if (resource === "audio" && (payload.encoding !== "pcm16le" || payload.sample_rate !== 32000 || payload.channels !== 1)) {
      throw new Error("incremental_output_audio_format_invalid");
    }
    return { kind, resource, identity: id };
  }
  if (kind === "delta" && resource === "text") {
    if (typeof payload.text !== "string" || !payload.text || payload.text.length > 65536) {
      throw new Error("incremental_output_text_delta_invalid");
    }
    return { kind, resource, identity: id, text: payload.text };
  }
  if (kind !== "end") throw new Error("incremental_output_update_not_implemented");
  const status = payload.status;
  if (status !== "completed" && status !== "failed" && status !== "cancelled") throw new Error("incremental_output_end_status_invalid");
  const reason = payload.reason === undefined ? "" : payload.reason;
  if (typeof reason !== "string" || reason.length > 4096 || (status !== "completed" && !reason.trim())) {
    throw new Error("incremental_output_end_reason_invalid");
  }
  return { kind, resource, identity: id, status, reason,
    length: resource === "motion" ? undefined : sequence(
      resource === "text" ? payload.text_length : payload.total_samples,
      resource === "text" ? "text_length" : "total_samples",
    ),
  };
}
