import { createTurnPlaybackSegment, isTerminalPhase } from "./session.js";
import type { TurnPlaybackSession, TurnPlaybackSegment } from "./session.js";
import type { MotionPayloadNormalizer } from "../types/motion.js";

export type IncrementalResource = "text" | "audio" | "motion";
export type IncrementalStatus = "completed" | "failed" | "cancelled";
export interface IncrementalIdentity {
  turnId: string;
  coreTurnId: string;
  personaResultId: string;
  segmentIndex: number;
  messageId: string;
  streamId: string;
  seq: number;
}
export interface IncrementalStreamState {
  id: string;
  nextSeq: number;
  status: "open" | IncrementalStatus;
  reason: string;
  samples: number;
}
export interface IncrementalSegmentState {
  coreTurnId: string;
  personaResultId: string;
  segmentIndex: number;
  streams: Record<IncrementalResource, IncrementalStreamState | null>;
}
const MAX_SEGMENTS = 256;
const MAX_SEGMENT_TEXT_UNITS = 65536;
const MAX_TURN_TEXT_UNITS = 262144;

export function cancelIncrementalProduction(session: TurnPlaybackSession, reason: string): void {
  for (const segment of session.segments.values()) {
    if (!segment.incremental) continue;
    for (const stream of Object.values(segment.incremental.streams)) {
      if (stream?.status === "open") {
        stream.status = "cancelled";
        stream.reason = reason;
      }
    }
    if (!segment.text.delivered) {
      segment.text.released = true;
      segment.text.delivered = true;
      segment.text.failed = true;
      segment.text.reason = reason;
    }
    if (!segment.motion.absent && !segment.motion.completed && !segment.motion.failed) {
      segment.motion.failed = true;
      segment.motion.reason = reason;
    }
  }
}

/** These mutations belong to SessionStore; no transport or playback is owned here. */
export function createIncrementalSegmentWriter(options: {
  requireSession(turnId: string): TurnPlaybackSession;
  markReady(turnId: string): void;
  normalizeMotionPayload: MotionPayloadNormalizer;
}) {
  function sessionFor(id: IncrementalIdentity): TurnPlaybackSession {
    const session = options.requireSession(id.turnId);
    if (!session.backend.turnStarted || session.backend.synthFinished
      || session.backend.turnFinished || session.interrupted || isTerminalPhase(session.phase)) {
      throw new Error("incremental_output_turn_not_open");
    }
    for (const value of [id.turnId, id.coreTurnId, id.personaResultId, id.messageId, id.streamId]) {
      if (typeof value !== "string" || !value.trim() || [...value].length > 256) {
        throw new Error("incremental_output_identity_invalid");
      }
    }
    if (!Number.isSafeInteger(id.segmentIndex) || id.segmentIndex < 0
      || !Number.isSafeInteger(id.seq) || id.seq < 0 || id.seq >= Number.MAX_SAFE_INTEGER) {
      throw new Error("incremental_output_sequence_invalid");
    }
    return session;
  }

  function segmentFor(session: TurnPlaybackSession, id: IncrementalIdentity): TurnPlaybackSegment {
    const segment = session.segments.get(id.messageId);
    const state = segment?.incremental;
    if (!segment || !state || state.coreTurnId !== id.coreTurnId
      || state.personaResultId !== id.personaResultId || state.segmentIndex !== id.segmentIndex) {
      throw new Error("incremental_output_segment_identity_mismatch");
    }
    return segment;
  }

  function streamFor(segment: TurnPlaybackSegment, resource: IncrementalResource, id: IncrementalIdentity) {
    const stream = segment.incremental!.streams[resource];
    if (!stream || stream.id !== id.streamId || stream.status !== "open" || stream.nextSeq !== id.seq) {
      throw new Error("incremental_output_stream_order_invalid");
    }
    return stream;
  }

  function startIncrementalStream(resource: IncrementalResource, id: IncrementalIdentity): void {
    const session = sessionFor(id);
    if (id.seq !== 0) throw new Error("incremental_output_start_sequence_invalid");
    let segment = session.segments.get(id.messageId);
    if (!segment) {
      if (id.segmentIndex !== session.segmentOrder.length || session.segmentOrder.length >= MAX_SEGMENTS) {
        throw new Error("incremental_output_segment_order_or_capacity_invalid");
      }
      for (const prior of session.segments.values()) {
        if (!prior.incremental || prior.incremental.coreTurnId !== id.coreTurnId
          || prior.incremental.personaResultId !== id.personaResultId) {
          throw new Error("incremental_output_mixed_delivery_or_result");
        }
      }
      segment = createTurnPlaybackSegment(id.messageId, id.turnId);
      segment.incremental = {
        coreTurnId: id.coreTurnId, personaResultId: id.personaResultId,
        segmentIndex: id.segmentIndex, streams: { text: null, audio: null, motion: null },
      };
    } else {
      segmentFor(session, id);
    }
    if (segment.incremental!.streams[resource]) throw new Error("incremental_output_duplicate_start");
    for (const prior of [...session.segments.values(), segment]) {
      if (Object.values(prior.incremental!.streams).some((stream) => stream?.id === id.streamId)) {
        throw new Error("incremental_output_duplicate_stream_id");
      }
    }
    segment.incremental!.streams[resource] = { id: id.streamId, nextSeq: 1, status: "open", reason: "", samples: 0 };
    if (resource === "text") {
      segment.text.content = "";
      segment.text.receiveMode = "append";
      segment.text.receivedAtMs = performance.now();
      segment.text.released = true;
    }
    if (resource === "audio") segment.audio.receivedAtMs = performance.now();
    if (!session.segments.has(id.messageId)) {
      session.segments.set(id.messageId, segment);
      session.segmentOrder.push(id.messageId);
    }
    if (session.phase === "collecting") options.markReady(id.turnId);
  }

  function appendIncrementalText(id: IncrementalIdentity, text: string): string {
    const session = sessionFor(id);
    const segment = segmentFor(session, id);
    const stream = streamFor(segment, "text", id);
    const current = segment.text.content ?? "";
    const turnUnits = [...session.segments.values()].reduce((sum, value) => sum + (value.text.content?.length ?? 0), 0);
    if (typeof text !== "string" || !text || current.length + text.length > MAX_SEGMENT_TEXT_UNITS
      || turnUnits + text.length > MAX_TURN_TEXT_UNITS) throw new Error("incremental_output_text_capacity_or_delta_invalid");
    segment.text.content = current + text;
    stream.nextSeq += 1;
    return segment.text.content;
  }

  function updateIncrementalMotion(id: IncrementalIdentity, payload: unknown): void {
    const session = sessionFor(id);
    const segment = segmentFor(session, id);
    const stream = streamFor(segment, "motion", id);
    const normalized = options.normalizeMotionPayload(payload);
    if (!normalized.ok) throw new Error(`incremental_output_motion_payload_invalid:${normalized.reason}`);
    stream.nextSeq += 1;
    // A late production result is acknowledged but cannot reopen a local
    // execution terminal or replace a payload already handed to the body.
    if (segment.motion.released || segment.motion.completed || segment.motion.failed || segment.motion.absent) return;
    segment.motion.payload = normalized.payload;
    segment.motion.source = "incremental_stream";
    segment.motion.receivedAtMs = performance.now();
    segment.motion.absent = false;
    segment.motion.failed = false;
    segment.motion.released = false;
  }

  function acceptIncrementalAudio(id: IncrementalIdentity, offset: number, byteLength: number): void {
    const session = sessionFor(id);
    const segment = segmentFor(session, id);
    const stream = streamFor(segment, "audio", id);
    for (const messageId of session.segmentOrder.slice(0, id.segmentIndex)) {
      const prior = session.segments.get(messageId)?.incremental?.streams.audio;
      if (!prior || prior.status === "open") throw new Error("incremental_output_audio_segment_order_invalid");
    }
    if (!Number.isSafeInteger(offset) || offset !== stream.samples || !Number.isSafeInteger(byteLength)
      || byteLength <= 0 || byteLength > 65536 || byteLength % 2
      || !Number.isSafeInteger(offset + byteLength / 2)) throw new Error("incremental_output_audio_offset_invalid");
    stream.samples += byteLength / 2;
    stream.nextSeq += 1;
  }

  function endIncrementalStream(resource: IncrementalResource, id: IncrementalIdentity,
    status: IncrementalStatus, reason: string, length?: number): void {
    const segment = segmentFor(sessionFor(id), id);
    const stream = streamFor(segment, resource, id);
    if (!["completed", "failed", "cancelled"].includes(status) || (status !== "completed" && !reason.trim())) {
      throw new Error("incremental_output_end_status_invalid");
    }
    const expected = resource === "text" ? [...(segment.text.content ?? "")].length : stream.samples;
    if (resource !== "motion" && (!Number.isSafeInteger(length) || length !== expected)) {
      throw new Error("incremental_output_end_length_mismatch");
    }
    stream.status = status;
    stream.reason = status === "completed" ? "" : reason;
    stream.nextSeq += 1;
    if (resource === "text") {
      segment.text.delivered = true;
      segment.text.failed = status !== "completed";
      segment.text.reason = status === "completed" ? "" : reason;
    } else if (resource === "audio" && stream.samples === 0) {
      segment.audio.released = true;
      segment.audio.terminal = status === "completed" ? "absent" : "failed";
      segment.audio.reason = status === "completed" ? "incremental_audio_empty" : reason;
    } else if (resource === "motion") {
      if (segment.motion.completed || segment.motion.failed || segment.motion.absent) return;
      if (segment.motion.payload !== null && status === "completed") {
        segment.motion.absent = false;
        segment.motion.failed = false;
        segment.motion.reason = "";
      } else {
        segment.motion.payload = null;
        segment.motion.source = null;
        segment.motion.receivedAtMs = null;
        segment.motion.absent = status === "completed";
        segment.motion.failed = status !== "completed";
        segment.motion.released = status !== "completed";
        segment.motion.reason = status === "completed" ? "incremental_motion_empty" : reason;
      }
    }
  }
  return { startIncrementalStream, appendIncrementalText, updateIncrementalMotion, acceptIncrementalAudio, endIncrementalStream };
}
