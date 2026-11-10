/** Decode every PCM16LE sample without trimming silence or segment boundaries. */
export function decodePcmSamples(pcm: Uint8Array): Float32Array {
  if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > 65536) {
    throw new Error("pcm_output_invalid_chunk_or_offset");
  }
  const samples = new Float32Array(pcm.byteLength / 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }
  return samples;
}
