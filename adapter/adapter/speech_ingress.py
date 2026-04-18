from __future__ import annotations

import base64
from collections import Counter
from dataclasses import dataclass, field
import os
import re
from typing import Any

import numpy as np

from astrbot.api import logger

from .payload_builder import build_control, build_error


@dataclass
class AudioStreamState:
    stream_id: str
    sample_rate: int = 16000
    channels: int = 1
    encoding: str = "pcm16le"
    chunks: list[bytes] = field(default_factory=list)
    last_seq: int = -1


class SpeechIngressService:
    def __init__(
        self,
        *,
        media_service,
        runtime_state,
        ensure_vad_engine,
        send_json,
        build_message_object,
    ) -> None:
        self.media_service = media_service
        self.runtime_state = runtime_state
        self._ensure_vad_engine = ensure_vad_engine
        self._send_json = send_json
        self._build_message_object = build_message_object
        self._audio_streams: dict[str, AudioStreamState] = {}

    async def handle_audio_stream_start(self, message: dict[str, Any]) -> None:
        stream_id = self._normalize_stream_id(message.get("stream_id"))
        if not stream_id:
            return

        self._audio_streams[stream_id] = AudioStreamState(
            stream_id=stream_id,
            sample_rate=max(int(message.get("sample_rate") or 16000), 1),
            channels=max(int(message.get("channels") or 1), 1),
            encoding=str(message.get("encoding") or "pcm16le"),
        )

    async def handle_audio_stream_chunk(self, message: dict[str, Any]) -> None:
        stream_id = self._normalize_stream_id(message.get("stream_id"))
        if not stream_id:
            return

        stream = self._audio_streams.get(stream_id)
        if stream is None:
            await self.handle_audio_stream_start(message)
            stream = self._audio_streams.get(stream_id)
            if stream is None:
                return

        if stream.encoding != "pcm16le":
            await self._send_json(build_error(f"Unsupported audio stream encoding: {stream.encoding}"))
            self._audio_streams.pop(stream_id, None)
            return

        seq = int(message.get("seq") or 0)
        if seq <= stream.last_seq:
            logger.warning(
                "Ignoring out-of-order audio stream chunk: stream_id=%s seq=%s last_seq=%s",
                stream_id,
                seq,
                stream.last_seq,
            )
            return

        audio_base64 = message.get("audio_base64")
        if not isinstance(audio_base64, str) or not audio_base64:
            return

        try:
            chunk_bytes = base64.b64decode(audio_base64)
        except Exception as exc:
            logger.warning("Failed to decode audio stream chunk for %s: %s", stream_id, exc)
            return

        stream.chunks.append(chunk_bytes)
        stream.last_seq = seq

    async def handle_audio_stream_end(self, message: dict[str, Any]):
        stream_id = self._normalize_stream_id(message.get("stream_id"))
        if not stream_id:
            return None

        stream = self._audio_streams.pop(stream_id, None)
        if stream is None or not stream.chunks:
            logger.debug("Ignoring `audio-stream-end` with empty or missing stream: %s", stream_id)
            return None

        audio_buffer = self._pcm16_bytes_to_float32(stream.chunks)
        return await self._build_message_from_audio_buffer(
            audio_buffer,
            raw_message=message,
            sample_rate=stream.sample_rate,
            stream_id=stream_id,
        )

    async def handle_audio_stream_interrupt(self, stream_id: str | None = None) -> None:
        normalized_stream_id = self._normalize_stream_id(stream_id)
        if normalized_stream_id:
            self._audio_streams.pop(normalized_stream_id, None)
            return

        self._audio_streams.clear()

    async def handle_audio_data(self, message: dict[str, Any]) -> None:
        audio_data = message.get("audio", [])
        if not isinstance(audio_data, list) or not audio_data:
            return

        chunk = np.array(audio_data, dtype=np.float32)
        await self.media_service.append_audio_chunk(chunk)

    async def handle_raw_audio_data(self, message: dict[str, Any]) -> None:
        audio_data = message.get("audio", [])
        if not isinstance(audio_data, list) or not audio_data:
            return

        try:
            vad_engine = self._ensure_vad_engine()
        except Exception as exc:
            logger.error("Failed to initialize VAD engine: %s", exc)
            await self._send_json(build_error(f"VAD unavailable: {exc}"))
            return

        for audio_bytes in vad_engine.detect_speech(audio_data):
            if audio_bytes == b"<|PAUSE|>":
                await self._send_json(build_control("interrupt"))
            elif audio_bytes == b"<|RESUME|>":
                continue
            elif len(audio_bytes) > 1024:
                chunk = (
                    np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                )
                await self.media_service.append_audio_chunk(chunk)
                await self._send_json(build_control("mic-audio-end"))

    async def handle_audio_end(self, message: dict[str, Any]):
        audio_buffer = await self.media_service.drain_audio_buffer()

        if audio_buffer.size == 0:
            logger.debug("Ignoring `mic-audio-end` with empty buffer.")
            return None

        return await self._build_message_from_audio_buffer(audio_buffer, raw_message=message)

    async def _build_message_from_audio_buffer(
        self,
        audio_buffer: np.ndarray,
        *,
        raw_message: dict[str, Any],
        sample_rate: int = 16000,
        stream_id: str | None = None,
    ):
        try:
            text = (await self._transcribe_audio(audio_buffer, sample_rate=sample_rate)).strip()
        except Exception as exc:
            logger.error("Audio transcription failed: %s", exc)
            await self._send_json(build_error(f"Audio transcription failed: {exc}"))
            return None

        if not text:
            await self._send_json(build_error("The LLM can't hear you."))
            return None

        should_drop, drop_reason = should_drop_transcription(text)
        if should_drop:
            logger.info("Dropped transcription `%s`: %s", text, drop_reason)
            return None

        await self._send_json({"type": "user-input-transcription", "text": text})

        raw_message = dict(raw_message)
        raw_message["transcription"] = text
        raw_message["audio_sample_count"] = int(audio_buffer.size)
        if stream_id:
            raw_message["stream_id"] = stream_id
        raw_message["audio_sample_rate"] = sample_rate
        return self._build_message_object(text=text, raw_message=raw_message)

    async def _transcribe_audio(self, audio_buffer: np.ndarray, *, sample_rate: int = 16000) -> str:
        if self.runtime_state.selected_stt_provider is None:
            raise RuntimeError(
                "No STT provider available. Please configure `stt_provider_id` in plugin config or set a default AstrBot STT provider."
            )

        temp_path = self.media_service.save_audio_buffer_to_temp_wav(
            audio_buffer,
            sample_rate=sample_rate,
        )
        try:
            return await self.runtime_state.selected_stt_provider.get_text(temp_path)
        finally:
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
            except Exception as exc:
                logger.warning("Failed to remove temp STT audio file %s: %s", temp_path, exc)

    @staticmethod
    def _normalize_stream_id(value: Any) -> str:
        if not isinstance(value, str):
            return ""
        return value.strip()

    @staticmethod
    def _pcm16_bytes_to_float32(chunks: list[bytes]) -> np.ndarray:
        if not chunks:
            return np.array([], dtype=np.float32)

        raw_bytes = b"".join(chunks)
        if not raw_bytes:
            return np.array([], dtype=np.float32)

        pcm16 = np.frombuffer(raw_bytes, dtype=np.int16)
        return pcm16.astype(np.float32) / 32768.0


def should_drop_transcription(text: str) -> tuple[bool, str]:
    normalized = (text or "").strip()
    if not normalized:
        return True, "empty transcription"

    compact = re.sub(r"\s+", "", normalized)
    if not compact:
        return True, "empty transcription after whitespace cleanup"

    meaningful_chars = re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", compact)
    if len(meaningful_chars) < 2:
        return True, "meaningful character count < 2"

    allowed_symbol_pattern = r"[\u4e00-\u9fffA-Za-z0-9，。！？；：、,.!?;:'\"“”‘’（）()《》【】\-_~ ]"
    noisy_chars = [
        ch for ch in compact
        if not re.match(allowed_symbol_pattern, ch)
    ]
    noisy_ratio = len(noisy_chars) / max(len(compact), 1)
    if len(compact) >= 4 and noisy_ratio >= 0.45:
        return True, f"noisy char ratio too high ({noisy_ratio:.2f})"

    alnum_or_cjk = "".join(meaningful_chars)
    if len(alnum_or_cjk) >= 4:
        char_counter = Counter(alnum_or_cjk)
        most_common_count = char_counter.most_common(1)[0][1]
        if most_common_count / len(alnum_or_cjk) >= 0.8:
            return True, "repeated character spam"

    if re.fullmatch(r"([A-Za-z0-9\u4e00-\u9fff])\1{3,}", alnum_or_cjk):
        return True, "single-character repetition"

    return False, ""
