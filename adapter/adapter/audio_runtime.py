from __future__ import annotations

from typing import Any

import numpy as np


class SileroVADStreamEngine:
    def __init__(self, *, kwargs: dict[str, Any]) -> None:
        try:
            from silero_vad import VADIterator, load_silero_vad  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "silero_vad is not installed. Install it with `pip install silero-vad`."
            ) from exc

        self.sampling_rate = int(kwargs.get("target_sr", kwargs.get("orig_sr", 16000)) or 16000)
        self.threshold = float(kwargs.get("prob_threshold", 0.4) or 0.4)
        self.window_size_samples = int(kwargs.get("window_size_samples", 512) or 512)
        chunk_ms = max(int(1000 * self.window_size_samples / self.sampling_rate), 1)
        self.min_silence_duration_ms = max(
            int(kwargs.get("required_misses", 24) or 24) * chunk_ms,
            0,
        )
        self.speech_pad_ms = max(
            int(kwargs.get("required_hits", 3) or 3) * chunk_ms,
            0,
        )

        self._model = load_silero_vad()
        self._iterator = VADIterator(
            self._model,
            threshold=self.threshold,
            sampling_rate=self.sampling_rate,
            min_silence_duration_ms=self.min_silence_duration_ms,
            speech_pad_ms=self.speech_pad_ms,
        )
        self._pending_samples = np.array([], dtype=np.float32)
        self._speech_active = False
        self._speech_chunks: list[np.ndarray] = []

    def detect_speech(self, audio_data: list[float] | list[int]) -> list[bytes]:
        samples = np.asarray(audio_data, dtype=np.float32)
        if samples.size == 0:
            return []

        samples = np.clip(samples, -1.0, 1.0)
        if self._pending_samples.size > 0:
            samples = np.concatenate([self._pending_samples, samples])

        results: list[bytes] = []
        processable_size = (samples.size // self.window_size_samples) * self.window_size_samples
        if processable_size <= 0:
            self._pending_samples = samples
            return results

        processable = samples[:processable_size]
        self._pending_samples = samples[processable_size:]

        import torch

        for index in range(0, processable.size, self.window_size_samples):
            chunk = processable[index : index + self.window_size_samples]
            chunk_tensor = torch.from_numpy(chunk)
            speech_dict = self._iterator(chunk_tensor, return_seconds=False)

            if self._speech_active:
                self._speech_chunks.append(chunk.copy())

            if speech_dict and "start" in speech_dict and not self._speech_active:
                self._speech_active = True
                self._speech_chunks = [chunk.copy()]
                results.append(b"<|PAUSE|>")

            if speech_dict and "end" in speech_dict and self._speech_active:
                pcm_bytes = _float_audio_to_pcm16_bytes(
                    np.concatenate(self._speech_chunks, dtype=np.float32)
                    if self._speech_chunks
                    else chunk
                )
                self._speech_active = False
                self._speech_chunks = []
                if pcm_bytes:
                    results.append(pcm_bytes)

        return results


def create_vad_engine(
    olv_dir,
    engine_type: str,
    kwargs: dict[str, Any],
):
    del olv_dir

    if not engine_type:
        return None

    if engine_type == "silero_vad":
        return SileroVADStreamEngine(kwargs=kwargs)

    raise RuntimeError(
        f"Unsupported VAD engine `{engine_type}`. Supported values: '', 'silero_vad'."
    )


def _float_audio_to_pcm16_bytes(audio: np.ndarray) -> bytes:
    if audio.size == 0:
        return b""
    clipped = np.clip(audio.astype(np.float32, copy=False), -1.0, 1.0)
    pcm = (clipped * 32767).astype(np.int16)
    return pcm.tobytes()
