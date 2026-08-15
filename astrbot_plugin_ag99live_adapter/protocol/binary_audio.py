"""Binary audio frame parser for the AG99live websocket transport."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any

from .constants import TYPE_INPUT_AUDIO_STREAM_CHUNK

MAGIC = b"AG99"
VERSION = 1
FRAME_TYPE_AUDIO_CHUNK = 1
HEADER_SIZE = 12
MAX_METADATA_BYTES = 64 * 1024


@dataclass(frozen=True)
class BinaryAudioChunkFrame:
    stream_id: str
    turn_id: str | None
    seq: int
    encoding: str
    sample_rate: int
    channels: int
    payload: bytes
    metadata: dict[str, Any]
    raw_type: str = TYPE_INPUT_AUDIO_STREAM_CHUNK


class BinaryAudioFrameError(ValueError):
    pass


def parse_binary_audio_frame(data: bytes) -> BinaryAudioChunkFrame:
    if len(data) < HEADER_SIZE:
        raise BinaryAudioFrameError("Binary audio frame is too short.")
    if data[:4] != MAGIC:
        raise BinaryAudioFrameError("Binary audio frame has invalid magic.")

    version = data[4]
    if version != VERSION:
        raise BinaryAudioFrameError(f"Unsupported binary audio frame version: {version}")

    frame_type = data[5]
    if frame_type != FRAME_TYPE_AUDIO_CHUNK:
        raise BinaryAudioFrameError(f"Unsupported binary audio frame type: {frame_type}")

    flags = int.from_bytes(data[6:8], byteorder="little", signed=False)
    if flags != 0:
        raise BinaryAudioFrameError(f"Unsupported binary audio frame flags: {flags}")

    meta_len = int.from_bytes(data[8:12], byteorder="little", signed=False)
    if meta_len <= 0:
        raise BinaryAudioFrameError("Binary audio frame metadata is empty.")
    if meta_len > MAX_METADATA_BYTES:
        raise BinaryAudioFrameError("Binary audio frame metadata is too large.")

    meta_start = HEADER_SIZE
    meta_end = meta_start + meta_len
    if meta_end > len(data):
        raise BinaryAudioFrameError("Binary audio frame metadata exceeds frame size.")

    try:
        metadata_raw = data[meta_start:meta_end].decode("utf-8")
        metadata = json.loads(metadata_raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BinaryAudioFrameError(f"Invalid binary audio metadata: {exc}") from exc

    if not isinstance(metadata, dict):
        raise BinaryAudioFrameError("Binary audio metadata must be an object.")

    payload = data[meta_end:]
    if not payload:
        raise BinaryAudioFrameError("Binary audio payload is empty.")

    stream_id = _require_string(metadata.get("stream_id"), "stream_id")
    turn_id = _optional_string(metadata.get("turn_id"))
    encoding = _require_string(metadata.get("encoding"), "encoding").lower()
    if encoding != "pcm16le":
        raise BinaryAudioFrameError(f"Unsupported binary audio encoding: {encoding}")

    seq = _require_non_negative_int(metadata.get("seq"), "seq")
    sample_rate = _require_positive_int(metadata.get("sample_rate"), "sample_rate")
    channels = _require_positive_int(metadata.get("channels"), "channels")

    return BinaryAudioChunkFrame(
        stream_id=stream_id,
        turn_id=turn_id,
        seq=seq,
        encoding=encoding,
        sample_rate=sample_rate,
        channels=channels,
        payload=payload,
        metadata=metadata,
    )


def _require_string(value: Any, name: str) -> str:
    normalized = _optional_string(value)
    if not normalized:
        raise BinaryAudioFrameError(f"Binary audio metadata requires `{name}`.")
    return normalized


def _optional_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _require_positive_int(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise BinaryAudioFrameError(f"Binary audio metadata `{name}` must be a positive integer.")
    return value


def _require_non_negative_int(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise BinaryAudioFrameError(f"Binary audio metadata `{name}` must be a non-negative integer.")
    return value
