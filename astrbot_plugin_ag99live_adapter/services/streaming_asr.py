"""Sherpa streaming recognizer shared by the adapter and inference server."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np


class StreamingASRError(RuntimeError):
    """Raised when the optional local recognizer cannot be initialized."""


class StreamingASR:
    """One online decode stream backed by a shared sherpa recognizer."""

    def __init__(
        self,
        *,
        model_dir: str,
        provider: str = "cpu",
        num_threads: int = 4,
    ) -> None:
        try:
            import sherpa_onnx
        except ImportError as exc:  # pragma: no cover - depends on local install
            raise StreamingASRError("sherpa_onnx_not_installed") from exc

        directory = Path(model_dir).expanduser()
        tokens = directory / "tokens.txt"
        candidates = (
            ("model.fp16.onnx", "model.onnx", "model.int8.onnx")
            if provider == "cuda"
            else ("model.int8.onnx", "model.onnx", "model.fp16.onnx")
        )
        model = next(
            (directory / name for name in candidates if (directory / name).is_file()),
            None,
        )
        if model is None or not tokens.is_file():
            raise StreamingASRError("streaming_asr_model_files_missing")

        try:
            self._recognizer = sherpa_onnx.OnlineRecognizer.from_zipformer2_ctc(
                tokens=str(tokens),
                model=str(model),
                num_threads=max(1, int(num_threads)),
                sample_rate=16000,
                feature_dim=80,
                enable_endpoint_detection=False,
                provider=provider,
            )
        except Exception as exc:
            raise StreamingASRError("streaming_asr_initialization_failed") from exc
        self.model_path = str(model)
        self.provider = provider
        self._stream = self._recognizer.create_stream()
        self._last_text = ""
        self._finished = False
        self._sample_rate = 16000

    def new_session(self) -> StreamingASR:
        session = object.__new__(StreamingASR)
        session._recognizer = self._recognizer
        session._stream = self._recognizer.create_stream()
        session.model_path = self.model_path
        session.provider = self.provider
        session._last_text = ""
        session._finished = False
        session._sample_rate = 16000
        return session

    def reset(self) -> None:
        self._stream = self._recognizer.create_stream()
        self._last_text = ""
        self._finished = False
        self._sample_rate = 16000

    def accept(self, samples: Any, sample_rate: int) -> str:
        waveform = np.asarray(samples, dtype=np.float32).reshape(-1)
        if waveform.size == 0:
            return self._last_text
        self._sample_rate = sample_rate
        self._stream.accept_waveform(sample_rate, waveform)
        self._decode_ready()
        self._last_text = self._recognizer.get_result(self._stream).strip()
        return self._last_text

    def finish(self) -> str:
        if self._finished:
            return self._last_text
        # CTC readiness still requires a complete model chunk after input_finished.
        # Flush the right context without adding synthetic audio to the review PCM.
        self._stream.accept_waveform(
            self._sample_rate, np.zeros(self._sample_rate, dtype=np.float32)
        )
        self._stream.input_finished()
        self._decode_ready()
        self._last_text = self._recognizer.get_result(self._stream).strip()
        self._finished = True
        return self._last_text

    def _decode_ready(self) -> None:
        while self._recognizer.is_ready(self._stream):
            self._recognizer.decode_stream(self._stream)
