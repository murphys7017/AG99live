from __future__ import annotations

import base64
from collections import Counter
from dataclasses import dataclass, field
import os
import re
from typing import Any

import numpy as np

from astrbot.api import logger

from ..protocol.builder import build_control_error, build_control_interrupt, build_output_transcription


@dataclass
class AudioStreamState:
    stream_id: str
    sample_rate: int = 16000
    channels: int = 1
    encoding: str = "pcm16le"
    chunks: list[bytes] = field(default_factory=list)
    last_seq: int = -1


@dataclass
class PendingTempAudioFile:
    path: str
    available_after_turn: int
    failure_count: int = 0


TEMP_AUDIO_CLEANUP_DELAY_TURNS = 3
TEMP_AUDIO_CLEANUP_WARNING_THRESHOLD = 5


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
        self._pending_temp_audio_files: dict[str, PendingTempAudioFile] = {}
        self._completed_transcription_turns = 0

    async def handle_audio_stream_start(self, message) -> None:
        payload = message.payload
        stream_id = self._normalize_stream_id(payload.get("stream_id"))
        if not stream_id:
            return

        self._audio_streams[stream_id] = AudioStreamState(
            stream_id=stream_id,
            sample_rate=max(int(payload.get("sample_rate") or 16000), 1),
            channels=max(int(payload.get("channels") or 1), 1),
            encoding=str(payload.get("encoding") or "pcm16le"),
        )

    async def handle_audio_stream_chunk(self, message) -> None:
        payload = message.payload
        stream_id = self._normalize_stream_id(payload.get("stream_id"))
        if not stream_id:
            return

        stream = self._audio_streams.get(stream_id)
        if stream is None:
            await self.handle_audio_stream_start(message)
            stream = self._audio_streams.get(stream_id)
            if stream is None:
                return

        if stream.encoding != "pcm16le":
            await self._send_json(
                build_control_error(
                    session_id=message.session_id,
                    turn_id=message.turn_id,
                    message=f"Unsupported audio stream encoding: {stream.encoding}",
                )
            )
            self._audio_streams.pop(stream_id, None)
            return

        seq = int(payload.get("seq") or 0)
        if seq <= stream.last_seq:
            logger.warning(
                "Ignoring out-of-order audio stream chunk: stream_id=%s seq=%s last_seq=%s",
                stream_id,
                seq,
                stream.last_seq,
            )
            return

        audio_base64 = payload.get("audio_base64")
        if not isinstance(audio_base64, str) or not audio_base64:
            return

        try:
            chunk_bytes = base64.b64decode(audio_base64)
        except Exception as exc:
            logger.warning("Failed to decode audio stream chunk for %s: %s", stream_id, exc)
            return

        stream.chunks.append(chunk_bytes)
        stream.last_seq = seq

    async def handle_audio_stream_end(self, message):
        payload = message.payload
        stream_id = self._normalize_stream_id(payload.get("stream_id"))
        if not stream_id:
            return None

        stream = self._audio_streams.pop(stream_id, None)
        if stream is None or not stream.chunks:
            logger.debug("Ignoring `input.audio_stream_end` with empty or missing stream: %s", stream_id)
            return None

        audio_buffer = self._pcm16_bytes_to_float32(stream.chunks)
        return await self._build_message_from_audio_buffer(
            audio_buffer,
            raw_message=message.raw,
            session_id=message.session_id,
            turn_id=message.turn_id,
            sample_rate=stream.sample_rate,
            stream_id=stream_id,
        )

    async def handle_audio_stream_interrupt(self, stream_id: str | None = None) -> None:
        normalized_stream_id = self._normalize_stream_id(stream_id)
        if normalized_stream_id:
            self._audio_streams.pop(normalized_stream_id, None)
            return

        self._audio_streams.clear()

    async def handle_audio_data(self, message) -> None:
        audio_data = message.payload.get("audio", [])
        if not isinstance(audio_data, list) or not audio_data:
            return

        chunk = np.array(audio_data, dtype=np.float32)
        await self.media_service.append_audio_chunk(chunk)

    async def handle_raw_audio_data(self, message):
        audio_data = message.payload.get("audio", [])
        if not isinstance(audio_data, list) or not audio_data:
            return None

        try:
            vad_engine = self._ensure_vad_engine()
        except Exception as exc:
            logger.error("Failed to initialize VAD engine: %s", exc)
            await self._send_json(
                build_control_error(
                    session_id=message.session_id,
                    turn_id=message.turn_id,
                    message=f"VAD unavailable: {exc}",
                )
            )
            return None

        built_message = None
        for audio_bytes in vad_engine.detect_speech(audio_data):
            if audio_bytes == b"<|PAUSE|>":
                built_message = await self._build_interrupt_message(message)
            elif audio_bytes == b"<|RESUME|>":
                continue
            elif len(audio_bytes) > 1024:
                chunk = (
                    np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                )
                await self.media_service.append_audio_chunk(chunk)
                built_message = await self.handle_audio_end(message)

        return built_message

    async def handle_audio_end(self, message):
        audio_buffer = await self.media_service.drain_audio_buffer()

        if audio_buffer.size == 0:
            logger.debug("Ignoring `input.mic_audio_end` with empty buffer.")
            return None

        return await self._build_message_from_audio_buffer(
            audio_buffer,
            raw_message=message.raw,
            session_id=message.session_id,
            turn_id=message.turn_id,
        )

    async def _build_interrupt_message(self, message):
        await self._send_json(
            build_control_interrupt(
                session_id=message.session_id,
                turn_id=message.turn_id,
            )
        )
        return None

    async def _build_message_from_audio_buffer(
        self,
        audio_buffer: np.ndarray,
        *,
        raw_message: dict[str, Any],
        session_id: str,
        turn_id: str | None,
        sample_rate: int = 16000,
        stream_id: str | None = None,
    ):
        try:
            text = (await self._transcribe_audio(audio_buffer, sample_rate=sample_rate)).strip()
        except Exception as exc:
            logger.error("Audio transcription failed: %s", exc)
            await self._send_json(
                build_control_error(
                    session_id=session_id,
                    turn_id=turn_id,
                    message=f"Audio transcription failed: {exc}",
                )
            )
            return None

        if not text:
            await self._send_json(
                build_control_error(
                    session_id=session_id,
                    turn_id=turn_id,
                    message="The LLM can't hear you.",
                )
            )
            return None

        should_drop, drop_reason = should_drop_transcription(text)
        if should_drop:
            logger.info("Dropped transcription `%s`: %s", text, drop_reason)
            return None

        await self._send_json(
            build_output_transcription(
                session_id=session_id,
                turn_id=turn_id,
                text=text,
            )
        )

        normalized_raw_message = dict(raw_message)
        normalized_payload = dict(normalized_raw_message.get("payload") or {})
        normalized_payload["transcription"] = text
        normalized_payload["audio_sample_count"] = int(audio_buffer.size)
        normalized_payload["audio_sample_rate"] = sample_rate
        if stream_id:
            normalized_payload["stream_id"] = stream_id
        normalized_raw_message["payload"] = normalized_payload
        return self._build_message_object(text=text, raw_message=normalized_raw_message)

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
            self._schedule_temp_file_cleanup(temp_path)

    def _schedule_temp_file_cleanup(self, temp_path: str) -> None:
        if not temp_path:
            return

        self._completed_transcription_turns += 1
        self._pending_temp_audio_files[temp_path] = PendingTempAudioFile(
            path=temp_path,
            available_after_turn=self._completed_transcription_turns + TEMP_AUDIO_CLEANUP_DELAY_TURNS,
        )
        self._cleanup_pending_temp_audio_files()

    def _cleanup_pending_temp_audio_files(self) -> None:
        if not self._pending_temp_audio_files:
            return

        for temp_path, pending_file in list(self._pending_temp_audio_files.items()):
            if self._completed_transcription_turns < pending_file.available_after_turn:
                continue

            try:
                if not os.path.exists(temp_path):
                    self._pending_temp_audio_files.pop(temp_path, None)
                    continue
                os.remove(temp_path)
                self._pending_temp_audio_files.pop(temp_path, None)
            except FileNotFoundError:
                self._pending_temp_audio_files.pop(temp_path, None)
            except (PermissionError, OSError) as exc:
                pending_file.failure_count += 1
                pending_file.available_after_turn = self._completed_transcription_turns + TEMP_AUDIO_CLEANUP_DELAY_TURNS
                if pending_file.failure_count == TEMP_AUDIO_CLEANUP_WARNING_THRESHOLD:
                    logger.warning("Failed to remove temp STT audio file %s after deferred cleanup retries: %s", temp_path, exc)

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
