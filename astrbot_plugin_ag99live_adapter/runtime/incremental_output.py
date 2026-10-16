"""Connection-bound incremental output, owned by OutputSegmentCoordinator."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import uuid4

from ..protocol.binary_audio import MAX_OUTPUT_AUDIO_BYTES, build_output_audio_frame
from ..protocol.constants import SOURCE_ADAPTER
from ..protocol.parser import build_message_envelope

Resource = Literal["text", "audio", "motion"]
Status = Literal["completed", "failed", "cancelled"]
SendPayload = Callable[[dict[str, Any] | bytes], Awaitable[bool]]


def _identity(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 256:
        raise ValueError("incremental_output_identity_invalid")
    return value


@dataclass(slots=True)
class _Stream:
    stream_id: str = field(default_factory=lambda: uuid4().hex)
    seq: int = 0
    status: str = "open"
    samples: int = 0


@dataclass(slots=True)
class _Segment:
    message_id: str
    streams: dict[str, _Stream] = field(default_factory=dict)
    text: str = ""
    text_units: int = 0


class IncrementalOutputSession:
    """One admitted Persona result; no socket reader, TTS or Turn lifecycle.

    The owner supplies its Turn lock, current-owner guard and a connection-bound
    sender. Each awaited send applies transport backpressure. Motion updates are
    intentionally not exposed until their desktop consumer is implemented.
    """

    def __init__(
        self,
        *,
        turn_id: str,
        core_turn_id: str,
        persona_result_id: str,
        lock: asyncio.Lock,
        send_payload: SendPayload,
        require_open: Callable[[], None],
        require_current: Callable[[], None],
        on_text_complete: Callable[[str], None],
    ) -> None:
        self.turn_id = _identity(turn_id)
        self.core_turn_id = _identity(core_turn_id)
        self.persona_result_id = _identity(persona_result_id)
        self._lock = lock
        self._send_payload = send_payload
        self._guard_open = require_open
        self._require_current = require_current
        self._on_text_complete = on_text_complete
        self._segments: dict[int, _Segment] = {}
        self._text_units = 0
        self.has_output = False
        self.failure_reason: str | None = None
        self._broken = False

    def _require_open(self) -> None:
        if self._broken:
            raise RuntimeError("incremental_output_failed_no_retry")
        self._guard_open()

    async def _send_once(self, payload: dict[str, Any] | bytes) -> None:
        try:
            self._require_open()
            if not await self._send_payload(payload):
                raise RuntimeError("incremental_output_send_failed")
            self._require_open()
        except BaseException:
            # A cancelled/failed write may already have reached the client.
            # Never retry the same sequence or replay its accepted samples.
            self._broken = True
            raise
        self.has_output = True

    def require_complete(self) -> None:
        self._require_open()
        if not self._segments or any(
            set(segment.streams) != {"text", "audio", "motion"}
            or any(stream.status == "open" for stream in segment.streams.values())
            for segment in self._segments.values()
        ):
            raise RuntimeError("incremental_output_production_unclosed")

    async def send_final_control(self, payload: dict[str, Any]) -> bool:
        """Owner-only closure send; closing is allowed, stale owners are not."""
        try:
            if self._broken:
                raise RuntimeError("incremental_output_failed_no_retry")
            self._require_current()
            sent = await self._send_payload(payload)
            self._require_current()
            if not sent:
                self._broken = True
            return sent
        except BaseException:
            self._broken = True
            raise

    def _stream(self, resource: Resource, index: int) -> tuple[_Segment, _Stream]:
        if type(index) is not int or index not in self._segments:
            raise ValueError("incremental_output_segment_missing")
        segment = self._segments[index]
        stream = segment.streams.get(resource)
        if stream is None or stream.status != "open":
            raise RuntimeError("incremental_output_stream_not_open")
        return segment, stream

    def _payload(
        self, index: int, segment: _Segment, stream: _Stream
    ) -> dict[str, Any]:
        return {
            "schema_version": "olv.incremental_output.v1",
            "core_turn_id": self.core_turn_id,
            "persona_result_id": self.persona_result_id,
            "segment_index": index,
            "segment_message_id": segment.message_id,
            "stream_id": stream.stream_id,
            "seq": stream.seq,
        }

    async def _send_event(
        self, resource: Resource, kind: str, payload: dict[str, Any]
    ) -> None:
        await self._send_once(
            build_message_envelope(
                f"output.{resource}_stream_{kind}",
                source=SOURCE_ADAPTER,
                turn_id=self.turn_id,
                payload=payload,
            )
        )

    async def start_stream(
        self, resource: Resource, *, segment_index: int, message_id: str
    ) -> None:
        async with self._lock:
            self._require_open()
            if resource not in {"text", "audio", "motion"}:
                raise ValueError("incremental_output_resource_invalid")
            _identity(message_id)
            if type(segment_index) is not int or not 0 <= segment_index < 256:
                raise ValueError("incremental_output_segment_order_invalid")
            segment = self._segments.get(segment_index)
            if segment is None:
                if segment_index != len(self._segments) or any(
                    prior.message_id == message_id for prior in self._segments.values()
                ):
                    raise ValueError("incremental_output_segment_order_invalid")
                segment = _Segment(message_id)
            if segment.message_id != message_id or resource in segment.streams:
                raise ValueError("incremental_output_duplicate_or_mismatched_start")
            stream = _Stream()
            payload = self._payload(segment_index, segment, stream)
            if resource == "audio":
                payload.update(encoding="pcm16le", sample_rate=32000, channels=1)
            await self._send_event(resource, "start", payload)
            stream.seq = 1
            segment.streams[resource] = stream
            self._segments[segment_index] = segment

    async def append_text(self, segment_index: int, text: str) -> None:
        async with self._lock:
            self._require_open()
            segment, stream = self._stream("text", segment_index)
            if not isinstance(text, str) or not text:
                raise ValueError("incremental_output_text_delta_invalid")
            if len(text) > 65536:
                raise ValueError("incremental_output_text_capacity_invalid")
            units = len(text.encode("utf-16-le")) // 2
            if segment.text_units + units > 65536 or self._text_units + units > 262144:
                raise ValueError("incremental_output_text_capacity_invalid")
            payload = self._payload(segment_index, segment, stream)
            payload["text"] = text
            await self._send_event("text", "delta", payload)
            segment.text += text
            segment.text_units += units
            self._text_units += units
            stream.seq += 1

    async def append_audio(
        self, segment_index: int, sample_offset: int, pcm: bytes
    ) -> None:
        async with self._lock:
            self._require_open()
            segment, stream = self._stream("audio", segment_index)
            if type(sample_offset) is not int or sample_offset != stream.samples:
                raise ValueError("incremental_output_audio_offset_invalid")
            if (
                not isinstance(pcm, bytes)
                or not pcm
                or len(pcm) % 2
                or len(pcm) > 1024 * 1024
            ):
                raise ValueError("incremental_output_audio_chunk_invalid")
            if any(
                (prior := self._segments[index].streams.get("audio")) is None
                or prior.status == "open"
                for index in range(segment_index)
            ):
                raise ValueError("incremental_output_audio_segment_order_invalid")
            for offset in range(0, len(pcm), MAX_OUTPUT_AUDIO_BYTES):
                payload = self._payload(segment_index, segment, stream)
                payload.update(
                    turn_id=self.turn_id,
                    sample_offset=stream.samples,
                    encoding="pcm16le",
                    sample_rate=32000,
                    channels=1,
                )
                block = pcm[offset : offset + MAX_OUTPUT_AUDIO_BYTES]
                await self._send_once(build_output_audio_frame(payload, block))
                stream.samples += len(block) // 2
                stream.seq += 1

    async def end_stream(
        self,
        resource: Resource,
        segment_index: int,
        *,
        status: Status = "completed",
        reason: str = "",
    ) -> None:
        async with self._lock:
            self._require_open()
            segment, stream = self._stream(resource, segment_index)
            if (
                status not in {"completed", "failed", "cancelled"}
                or not isinstance(reason, str)
                or len(reason.encode("utf-16-le")) // 2 > 4096
                or (status != "completed" and not reason.strip())
            ):
                raise ValueError("incremental_output_end_status_invalid")
            payload = self._payload(segment_index, segment, stream)
            payload.update(status=status, reason=reason)
            if resource == "text":
                payload["text_length"] = len(segment.text)
            elif resource == "audio":
                payload["total_samples"] = stream.samples
            await self._send_event(resource, "end", payload)
            stream.status = status
            stream.seq += 1
            if status != "completed" and resource != "motion":
                self.failure_reason = self.failure_reason or reason
            if resource == "text" and segment.text:
                self._on_text_complete(segment.text)
