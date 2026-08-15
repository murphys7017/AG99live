"""语音输入入口：麦克风流聚合 → STT → 转写产出。

只处理"前端 → 后端"方向的麦克风/语音路径；文本回复不在这里。
可转写的完整音频段会走到 _build_message_from_audio_buffer，产出
AstrBotMessage 并配套发 build_output_transcription（如果转写出了文字）。
空流、丢帧、VAD 不可用或被过滤的转写只报告输入错误或直接 return None，
不会为尚未提交到 TurnCoordinator 的输入发布 Turn 终态。
"""

from __future__ import annotations

import base64
from collections import Counter
from dataclasses import dataclass, field
import os
import re
from typing import Any

import numpy as np

from astrbot.api import logger

from ..protocol.binary_audio import BinaryAudioChunkFrame
from ..protocol.builder import (
    build_control_error,
    build_output_transcription,
)


@dataclass
class AudioStreamState:
    stream_id: str
    sample_rate: int = 16000
    channels: int = 1
    encoding: str = "pcm16le"
    capture_mode: str = "ptt"
    chunks: list[bytes] = field(default_factory=list)
    last_seq: int = -1


@dataclass
class PendingTempAudioFile:
    path: str
    available_after_turn: int
    failure_count: int = 0


@dataclass(frozen=True)
class _StreamVadMessage:
    turn_id: str | None
    raw_type: str
    stream_id: str
    sample_rate: int

    @property
    def payload(self) -> dict[str, Any]:
        return {
            "stream_id": self.stream_id,
            "sample_rate": self.sample_rate,
        }

    @property
    def raw(self) -> dict[str, Any]:
        return {
            "type": self.raw_type,
            "turn_id": self.turn_id,
            "payload": self.payload,
        }


TEMP_AUDIO_CLEANUP_DELAY_TURNS = 3
TEMP_AUDIO_CLEANUP_WARNING_THRESHOLD = 5


class SpeechIngressService:
    """语音输入服务：聚合 PCM chunk、做 VAD 切分、调 STT、产出 AstrBotMessage。

    内部维护三类状态：
      - _audio_streams: dict[stream_id, AudioStreamState]，存正在接收的流；
      - _pending_temp_audio_files: dict[path, PendingTempAudioFile]，延迟 N 轮后
        回收的 STT 临时 wav 文件；
      - _vad_turn_counters: dict[root_turn_id, int]，VAD 切分出来的子轮次自增计数。

    出站时通过构造注入的 send_json 发 control_error / output_transcription；
    检测到用户开口时通知 TurnCoordinator 选择要中断的正式轮次。能形成有效转写的路径
    才返回 AstrBotMessage 交给 TurnCoordinator commit。
    """

    def __init__(
        self,
        *,
        media_service,
        runtime_state,
        ensure_vad_engine,
        send_json,
        build_message_object,
        on_vad_speech_started,
    ) -> None:
        self.media_service = media_service
        self.runtime_state = runtime_state
        self._ensure_vad_engine = ensure_vad_engine
        self._send_json = send_json
        self._build_message_object = build_message_object
        self._on_vad_speech_started = on_vad_speech_started
        self._audio_streams: dict[str, AudioStreamState] = {}
        self._pending_temp_audio_files: dict[str, PendingTempAudioFile] = {}
        self._completed_transcription_turns = 0
        self._vad_turn_counters: dict[str, int] = {}

    async def handle_audio_stream_start(self, message) -> None:
        """处理 input.audio_stream_start：登记新流的状态。

        没拿到 stream_id 时静默 return；已有同名流会被覆盖（用最新一次 start 的参数）。
        """
        payload = message.payload
        stream_id = self._normalize_stream_id(payload.get("stream_id"))
        if not stream_id:
            return

        self._audio_streams[stream_id] = AudioStreamState(
            stream_id=stream_id,
            sample_rate=max(int(payload.get("sample_rate") or 16000), 1),
            channels=max(int(payload.get("channels") or 1), 1),
            encoding=str(payload.get("encoding") or "pcm16le"),
            capture_mode=self._normalize_capture_mode(payload.get("capture_mode"), default="ptt"),
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

    async def handle_audio_stream_binary_chunk(self, frame: BinaryAudioChunkFrame):
        stream_id = self._normalize_stream_id(frame.stream_id)
        if not stream_id:
            return

        stream = self._audio_streams.get(stream_id)
        if stream is None:
            stream = AudioStreamState(
                stream_id=stream_id,
                sample_rate=frame.sample_rate,
                channels=frame.channels,
                encoding=frame.encoding,
                capture_mode=self._normalize_capture_mode(frame.metadata.get("capture_mode"), default="ptt"),
            )
            self._audio_streams[stream_id] = stream

        if stream.encoding != "pcm16le" or frame.encoding != "pcm16le":
            await self._send_json(
                build_control_error(
                    turn_id=frame.turn_id,
                    message=f"Unsupported audio stream encoding: {stream.encoding or frame.encoding}",
                )
            )
            self._audio_streams.pop(stream_id, None)
            return

        if frame.seq <= stream.last_seq:
            logger.warning(
                "Ignoring out-of-order binary audio stream chunk: stream_id=%s seq=%s last_seq=%s",
                stream_id,
                frame.seq,
                stream.last_seq,
            )
            return

        if stream.sample_rate != frame.sample_rate or stream.channels != frame.channels:
            logger.warning(
                "Binary audio stream format changed: stream_id=%s existing=%s/%s next=%s/%s",
                stream_id,
                stream.sample_rate,
                stream.channels,
                frame.sample_rate,
                frame.channels,
            )
            self._audio_streams.pop(stream_id, None)
            await self._send_json(
                build_control_error(
                    turn_id=frame.turn_id,
                    message="Audio stream format changed during capture.",
                )
            )
            return

        stream.capture_mode = self._normalize_capture_mode(
            frame.metadata.get("capture_mode"),
            default=stream.capture_mode,
        )
        if stream.capture_mode in {"manual", "auto"}:
            built_message = await self._handle_vad_pcm16_chunk(
                frame.payload,
                turn_id=frame.turn_id,
                raw_type=frame.raw_type,
                stream_id=stream_id,
                sample_rate=stream.sample_rate,
            )
            stream.last_seq = frame.seq
            return built_message
        else:
            stream.chunks.append(frame.payload)
        stream.last_seq = frame.seq
        return None

    async def handle_audio_stream_end(self, message):
        """处理 input.audio_stream_end：取走流、组装一轮消息。

        行为分支：
          - dropped=True → 报告 microphone audio dropped 输入错误后 return；
          - capture_mode∈{manual, auto} 且流为 VAD 模式 → 转写前若一轮 VAD 子段都没
            收到，报告 microphone audio empty 输入错误；
          - 否则把所有 chunks 拼成 float32 缓冲，走 _build_message_from_audio_buffer。
        返回 None 或 AstrBotMessage；后者会被 turn_coordinator 进一步 commit。
        """
        payload = message.payload
        stream_id = self._normalize_stream_id(payload.get("stream_id"))
        if not stream_id:
            return None

        stream = self._audio_streams.pop(stream_id, None)
        dropped = bool(payload.get("dropped", False))
        capture_mode = self._normalize_capture_mode(
            payload.get("capture_mode"),
            default=stream.capture_mode if stream else "ptt",
        )
        if dropped:
            logger.warning("Dropping binary microphone audio stream because frontend reported chunk loss.")
            await self._emit_input_error(
                turn_id=message.turn_id,
                error_message="Microphone audio segment dropped before transcription.",
            )
            return None

        if capture_mode in {"manual", "auto"}:
            if stream is None:
                logger.debug("Ignoring VAD audio stream end with missing stream: %s", stream_id)
                return None
            if self._consume_vad_turn_counter(message.turn_id):
                logger.debug("Ignoring VAD audio stream end after child turns: %s", stream_id)
                return None
            await self._emit_input_error(
                turn_id=message.turn_id,
                error_message="Microphone audio segment was empty before transcription.",
            )
            return None

        if stream is None or not stream.chunks:
            logger.debug("Ignoring `input.audio_stream_end` with empty or missing stream: %s", stream_id)
            return None

        audio_buffer = self._pcm16_bytes_to_float32(stream.chunks)
        return await self._build_message_from_audio_buffer(
            audio_buffer,
            raw_message=message.raw,
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

    async def _handle_vad_pcm16_chunk(
        self,
        chunk_bytes: bytes,
        *,
        turn_id: str | None,
        raw_type: str,
        stream_id: str,
        sample_rate: int,
    ):
        audio_data = self._pcm16_bytes_to_float32([chunk_bytes])
        if audio_data.size == 0:
            return None
        message = _StreamVadMessage(
            turn_id=turn_id,
            raw_type=raw_type,
            stream_id=stream_id,
            sample_rate=sample_rate,
        )
        try:
            vad_engine = self._ensure_vad_engine()
        except Exception as exc:
            logger.error("Failed to initialize VAD engine: %s", exc)
            await self._emit_input_error(
                turn_id=turn_id,
                error_message=f"VAD unavailable: {exc}",
            )
            return None

        segment_id = self._resolve_audio_segment_id(message)
        for audio_bytes in vad_engine.detect_speech(audio_data.tolist()):
            if audio_bytes == b"<|PAUSE|>":
                await self._notify_vad_speech_started(message)
            elif audio_bytes == b"<|RESUME|>":
                continue
            elif len(audio_bytes) > 1024:
                chunk = (
                    np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                )
                await self.media_service.append_audio_chunk(chunk, segment_id=segment_id)
                built_message = await self._build_message_from_vad_segment(message)
                if built_message is not None:
                    return built_message
        return None

    async def _notify_vad_speech_started(self, message) -> None:
        capture_turn_id = str(getattr(message, "turn_id", "") or "").strip()
        if not capture_turn_id:
            raise ValueError("vad_speech_started_capture_turn_id_missing")
        await self._on_vad_speech_started(capture_turn_id)

    async def _build_message_from_audio_buffer(
        self,
        audio_buffer: np.ndarray,
        *,
        raw_message: dict[str, Any],
        turn_id: str | None,
        sample_rate: int = 16000,
        stream_id: str | None = None,
    ):
        try:
            text = (await self._transcribe_audio(audio_buffer, sample_rate=sample_rate)).strip()
        except Exception as exc:
            logger.error("Audio transcription failed: %s", exc)
            await self._emit_input_error(
                turn_id=turn_id,
                error_message=f"Audio transcription failed: {exc}",
            )
            return None

        if not text:
            await self._emit_input_error(
                turn_id=turn_id,
                error_message="The LLM can't hear you.",
            )
            return None

        should_drop, drop_reason = should_drop_transcription(text)
        if should_drop:
            logger.info("Dropped transcription `%s`: %s", text, drop_reason)
            await self._emit_input_error(
                turn_id=turn_id,
                error_message=f"Audio transcription dropped: {drop_reason}",
            )
            return None

        await self._send_json(
            build_output_transcription(
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

    async def _build_message_from_vad_segment(self, message):
        segment_id = self._resolve_audio_segment_id(message)
        audio_buffer = await self.media_service.drain_audio_buffer(segment_id=segment_id)
        vad_turn_id = self._next_vad_turn_id(message.turn_id)

        if audio_buffer.size == 0:
            logger.debug("Ignoring VAD segment with empty buffer.")
            await self._emit_input_error(
                turn_id=vad_turn_id,
                error_message="Microphone audio segment was empty before transcription.",
            )
            return None

        return await self._build_message_from_audio_buffer(
            audio_buffer,
            raw_message=self._clone_raw_message_with_turn_id(message.raw, vad_turn_id),
            turn_id=vad_turn_id,
        )

    def _resolve_audio_segment_id(self, message) -> str | None:
        segment_id = getattr(message, "turn_id", None)
        if isinstance(segment_id, str):
            normalized = segment_id.strip()
            if normalized:
                return normalized
        return None

    def _next_vad_turn_id(self, root_turn_id: str | None) -> str | None:
        normalized = str(root_turn_id or "").strip()
        if not normalized:
            return None
        next_index = self._vad_turn_counters.get(normalized, 0) + 1
        self._vad_turn_counters[normalized] = next_index
        return f"{normalized}:vad:{next_index}"

    def _consume_vad_turn_counter(self, root_turn_id: str | None) -> bool:
        normalized = str(root_turn_id or "").strip()
        if not normalized:
            return False
        return self._vad_turn_counters.pop(normalized, 0) > 0

    @staticmethod
    def _clone_raw_message_with_turn_id(
        raw_message: dict[str, Any],
        turn_id: str | None,
    ) -> dict[str, Any]:
        cloned = dict(raw_message)
        cloned["turn_id"] = turn_id
        return cloned

    async def _emit_input_error(
        self,
        *,
        turn_id: str | None,
        error_message: str,
    ) -> None:
        await self._send_json(
            build_control_error(
                turn_id=turn_id,
                message=error_message,
            )
        )

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
    def _normalize_capture_mode(value: Any, *, default: str = "manual") -> str:
        normalized = str(value or default).strip().lower()
        return normalized if normalized in {"manual", "ptt", "auto"} else default

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
    """判断一段 STT 转写是否值得继续送进 LLM。

    过滤规则（任一命中就丢）：
      - 去空白后空字符串；
      - 有效字符（中/英/数字）少于 2 个；
      - 字符串长度 ≥4 且非允许符号的字符占比 ≥0.45；
      - 有效字符长度 ≥4 且单字符出现次数 ≥0.8（明显重复刷屏）；
      - 整段是单字符重复 ≥4 次。
    返回 (should_drop, reason)；reason 描述具体命中哪条规则。
    """
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
