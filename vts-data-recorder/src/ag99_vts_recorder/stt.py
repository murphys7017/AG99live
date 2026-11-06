from __future__ import annotations

from pathlib import Path
from typing import Any


class StreamingSTTError(RuntimeError):
    """Raised when the optional local streaming recognizer is unavailable."""


class StreamingSTT:
    """Small standalone sherpa-onnx streaming recognizer wrapper."""

    def __init__(
        self,
        *,
        model_dir: Path,
        provider: str = "cpu",
        num_threads: int = 4,
    ) -> None:
        try:
            import sherpa_onnx
        except ImportError as exc:  # pragma: no cover - depends on local install
            raise StreamingSTTError(
                "sherpa_onnx is required for live recording; install the stt extra"
            ) from exc

        directory = model_dir.expanduser()
        tokens = directory / "tokens.txt"
        candidates = (
            ("model.fp16.onnx", "model.onnx", "model.int8.onnx")
            if provider == "cuda"
            else ("model.int8.onnx", "model.onnx", "model.fp16.onnx")
        )
        model = next((directory / name for name in candidates if (directory / name).is_file()), None)
        if model is None or not tokens.is_file():
            raise StreamingSTTError(f"streaming STT model files missing in {directory}")
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
        except Exception as exc:  # pragma: no cover - depends on local model
            raise StreamingSTTError("streaming STT initialization failed") from exc
        self.model_path = str(model)
        self.provider = provider
        self._stream = self._recognizer.create_stream()
        self._last_text = ""
        self._finished = False

    def accept(self, samples: Any, sample_rate: int) -> str:
        import numpy as np

        waveform = np.asarray(samples, dtype=np.float32).reshape(-1)
        if waveform.size == 0 or self._finished:
            return self._last_text
        self._stream.accept_waveform(sample_rate, waveform)
        self._decode_ready()
        self._last_text = self._recognizer.get_result(self._stream).strip()
        return self._last_text

    def finish(self) -> str:
        import numpy as np

        if self._finished:
            return self._last_text
        self._stream.accept_waveform(16000, np.zeros(16000, dtype=np.float32))
        self._stream.input_finished()
        self._decode_ready()
        self._last_text = self._recognizer.get_result(self._stream).strip()
        self._finished = True
        return self._last_text

    def _decode_ready(self) -> None:
        while self._recognizer.is_ready(self._stream):
            self._recognizer.decode_stream(self._stream)
