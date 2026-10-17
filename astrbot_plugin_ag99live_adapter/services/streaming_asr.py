"""Optional sherpa-onnx online CTC recognizer. No dependency when disabled.

A single CPU recognizer is shared between capture sessions. Audio is incrementally
accepted and decoded as PCM frames arrive; only a small tail is processed on seal.
All public methods are synchronous and should be called via asyncio.to_thread().
"""
from __future__ import annotations

from pathlib import Path
import threading

import numpy as np


class StreamingASREngine:
    def __init__(self, model_dir: str, *, num_threads: int = 2) -> None:
        model_dir_path = Path(model_dir).expanduser().resolve()
        model = model_dir_path / "model.int8.onnx"
        if not model.is_file():
            model = model_dir_path / "model.onnx"
        tokens = model_dir_path / "tokens.txt"
        if not model.is_file() or not tokens.is_file():
            raise FileNotFoundError(
                f"Streaming ASR requires model.int8.onnx (or model.onnx) and tokens.txt in {model_dir_path}"
            )

        # Lazy optional dependency: existing STT remains usable without sherpa.
        import sherpa_onnx

        self._recognizer = sherpa_onnx.OnlineRecognizer.from_zipformer2_ctc(
            tokens=str(tokens),
            model=str(model),
            num_threads=max(1, min(int(num_threads), 8)),
            sample_rate=16000,
            feature_dim=80,
            decoding_method="greedy_search",
            provider="cpu",
        )
        # sherpa-onnx recognizer calls are serialized between concurrent streams.
        self._lock = threading.RLock()

    def create_session(self) -> "StreamingASRSession":
        with self._lock:
            return StreamingASRSession(self, self._recognizer.create_stream())


class StreamingASRSession:
    def __init__(self, engine: StreamingASREngine, stream) -> None:
        self._engine = engine
        self._stream = stream
        self._finished = False
        self._latest = ""

    def feed_pcm16(self, pcm: bytes, sample_rate: int) -> str:
        if self._finished or not pcm:
            return self._latest
        if len(pcm) % 2:
            raise ValueError("PCM16LE audio must contain complete 16-bit samples")
        if sample_rate <= 0:
            raise ValueError("Invalid audio sample rate")
        samples = (
            np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        )
        with self._engine._lock:
            self._stream.accept_waveform(sample_rate, samples)
            self._decode_available()
        return self._latest

    def finish(self, sample_rate: int) -> str:
        if self._finished:
            return self._latest
        if sample_rate <= 0:
            raise ValueError("Invalid audio sample rate")
        with self._engine._lock:
            # CTC online recognizers may need look-ahead samples to flush the
            # last characters. This is SILENCE appended to the existing stream,
            # not an additional 660ms of real-time waiting.
            self._stream.accept_waveform(
                sample_rate, np.zeros(round(sample_rate * 0.66), dtype=np.float32)
            )
            self._stream.input_finished()
            self._decode_available()
            self._finished = True
        return self._latest.strip()

    def _decode_available(self) -> None:
        recognizer = self._engine._recognizer
        while recognizer.is_ready(self._stream):
            recognizer.decode_stream(self._stream)
        self._latest = recognizer.get_result(self._stream)
