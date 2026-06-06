const AUDIO_FRAME_MAGIC = "AG99";
const AUDIO_FRAME_VERSION = 1;
const AUDIO_FRAME_TYPE_CHUNK = 1;
const AUDIO_FRAME_HEADER_BYTES = 12;

export interface AudioStreamFrameMetadata {
  stream_id: string;
  turn_id: string;
  seq: number;
  encoding: "pcm16le";
  sample_rate: number;
  channels: 1;
  capture_mode?: "manual" | "ptt" | "auto";
}

export function buildAudioStreamChunkFrame(
  metadata: AudioStreamFrameMetadata,
  payload: ArrayBuffer,
): ArrayBuffer {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const payloadBytes = new Uint8Array(payload);
  const frame = new ArrayBuffer(AUDIO_FRAME_HEADER_BYTES + metadataBytes.byteLength + payloadBytes.byteLength);
  const bytes = new Uint8Array(frame);
  const view = new DataView(frame);

  for (let index = 0; index < AUDIO_FRAME_MAGIC.length; index += 1) {
    bytes[index] = AUDIO_FRAME_MAGIC.charCodeAt(index);
  }
  view.setUint8(4, AUDIO_FRAME_VERSION);
  view.setUint8(5, AUDIO_FRAME_TYPE_CHUNK);
  view.setUint16(6, 0, true);
  view.setUint32(8, metadataBytes.byteLength, true);
  bytes.set(metadataBytes, AUDIO_FRAME_HEADER_BYTES);
  bytes.set(payloadBytes, AUDIO_FRAME_HEADER_BYTES + metadataBytes.byteLength);
  return frame;
}

export function float32ToPcm16le(input: Float32Array): ArrayBuffer {
  const output = new ArrayBuffer(input.length * Int16Array.BYTES_PER_ELEMENT);
  const view = new DataView(output);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
    const scaled = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(index * Int16Array.BYTES_PER_ELEMENT, Math.round(scaled), true);
  }
  return output;
}

export function cloneArrayBuffer(input: ArrayBuffer): ArrayBuffer {
  return input.slice(0);
}
