from __future__ import annotations

from collections import deque
from math import ceil
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
            int(kwargs.get("required_misses", 16) or 16) * chunk_ms,
            0,
        )
        self.speech_pad_ms = max(
            int(kwargs.get("required_hits", 3) or 3) * chunk_ms,
            0,
        )
        # VADIterator reports a delayed start while its speech_pad_ms points
        # back into already received audio. Retain those windows so the custom
        # stream assembler can include the same leading speech pad.
        self._pre_roll_chunks = max(
            0,
            ceil(
                (self.sampling_rate * self.speech_pad_ms / 1000)
                / self.window_size_samples
            ),
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
        self._recent_chunks: deque[np.ndarray] = deque(maxlen=self._pre_roll_chunks)

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
            chunk_copy = chunk.copy()
            chunk_tensor = torch.from_numpy(chunk)
            speech_dict = self._iterator(chunk_tensor, return_seconds=False)

            if self._speech_active:
                self._speech_chunks.append(chunk_copy)

            if speech_dict and "start" in speech_dict and not self._speech_active:
                self._speech_active = True
                self._speech_chunks = [*self._recent_chunks, chunk_copy]
                self._recent_chunks.clear()
                results.append(b"<|PAUSE|>")

            if speech_dict and "end" in speech_dict and self._speech_active:
                pcm_bytes = _float_audio_to_pcm16_bytes(
                    np.concatenate(self._speech_chunks, dtype=np.float32)
                    if self._speech_chunks
                    else chunk
                )
                self._speech_active = False
                self._speech_chunks = []
                self._recent_chunks.clear()
                if pcm_bytes:
                    results.append(pcm_bytes)

            if not self._speech_active and not (speech_dict and "end" in speech_dict):
                self._recent_chunks.append(chunk_copy)

        return results


def create_vad_engine(
    engine_type: str,
    kwargs: dict[str, Any],
):
    if engine_type == "silero_vad":
        return SileroVADStreamEngine(kwargs=kwargs)

    raise RuntimeError(
        f"Unsupported VAD engine `{engine_type}`. Supported value: 'silero_vad'."
    )


def _float_audio_to_pcm16_bytes(audio: np.ndarray) -> bytes:
    if audio.size == 0:
        return b""
    clipped = np.clip(audio.astype(np.float32, copy=False), -1.0, 1.0)
    pcm = (clipped * 32767).astype(np.int16)
    return pcm.tobytes()
