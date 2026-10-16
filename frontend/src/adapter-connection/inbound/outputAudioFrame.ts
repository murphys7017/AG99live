/** Bounded downlink PCM frame decoder; uplink microphone frames use type 1. */
export interface OutputAudioFrameMetadata {
  schema_version: "olv.incremental_output.v1";
  turn_id: string;
  core_turn_id: string;
  persona_result_id: string;
  segment_message_id: string;
  stream_id: string;
  segment_index: number;
  seq: number;
  sample_offset: number;
  encoding: "pcm16le";
  sample_rate: 32000;
  channels: 1;
}

export interface OutputAudioFrame {
  metadata: OutputAudioFrameMetadata;
  pcm: Uint8Array;
}

const HEADER_SIZE = 12;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_PCM_BYTES = 64 * 1024;

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new Error(`output_audio_identity_invalid:${field}`);
  }
  return value;
}

function sequence(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`output_audio_sequence_invalid:${field}`);
  }
  return value;
}

export function parseOutputAudioFrame(buffer: ArrayBuffer): OutputAudioFrame {
  if (buffer.byteLength < HEADER_SIZE
    || buffer.byteLength > HEADER_SIZE + MAX_METADATA_BYTES + MAX_PCM_BYTES) {
    throw new Error("output_audio_frame_size_invalid");
  }
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== 0x41473939
    || view.getUint8(4) !== 1 || view.getUint8(5) !== 2
    || view.getUint16(6, true) !== 0) {
    throw new Error("output_audio_frame_header_invalid");
  }
  const metadataLength = view.getUint32(8, true);
  if (metadataLength === 0 || metadataLength > MAX_METADATA_BYTES
    || HEADER_SIZE + metadataLength >= buffer.byteLength) {
    throw new Error("output_audio_metadata_size_invalid");
  }
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    new Uint8Array(buffer, HEADER_SIZE, metadataLength),
  ));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("output_audio_metadata_invalid");
  }
  const value = raw as Record<string, unknown>;
  if (value.schema_version !== "olv.incremental_output.v1"
    || value.encoding !== "pcm16le" || value.sample_rate !== 32000
    || value.channels !== 1) {
    throw new Error("output_audio_format_invalid");
  }
  const pcm = new Uint8Array(buffer, HEADER_SIZE + metadataLength);
  if (!pcm.length || pcm.length > MAX_PCM_BYTES || pcm.length % 2 !== 0) {
    throw new Error("output_audio_pcm_invalid");
  }
  const seq = sequence(value.seq, "seq");
  const sampleOffset = sequence(value.sample_offset, "sample_offset");
  if (seq === 0 || !Number.isSafeInteger(sampleOffset + pcm.length / 2)) {
    throw new Error("output_audio_sample_range_invalid");
  }
  return {
    metadata: {
      schema_version: "olv.incremental_output.v1",
      turn_id: identity(value.turn_id, "turn_id"),
      core_turn_id: identity(value.core_turn_id, "core_turn_id"),
      persona_result_id: identity(value.persona_result_id, "persona_result_id"),
      segment_message_id: identity(value.segment_message_id, "segment_message_id"),
      stream_id: identity(value.stream_id, "stream_id"),
      segment_index: sequence(value.segment_index, "segment_index"),
      seq,
      sample_offset: sampleOffset,
      encoding: "pcm16le",
      sample_rate: 32000,
      channels: 1,
    },
    pcm,
  };
}
