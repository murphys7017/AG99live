"""Binary audio frame parser for the AG99live websocket transport."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any

from .constants import TYPE_INPUT_AUDIO_STREAM_CHUNK

MAGIC = b"AG99"
VERSION = 1
FRAME_TYPE_AUDIO_CHUNK = 1
FRAME_TYPE_OUTPUT_AUDIO_CHUNK = 2
HEADER_SIZE = 12
MAX_METADATA_BYTES = 64 * 1024
MAX_OUTPUT_AUDIO_BYTES = 64 * 1024


def build_output_audio_frame(metadata: dict[str, Any], audio: bytes) -> bytes:
    """Encode a bounded, identity-tagged downlink PCM chunk (frame type 2)."""
    if not isinstance(audio, bytes) or not audio or len(audio) % 2:
        raise BinaryAudioFrameError("output_audio_pcm_invalid")
    if len(audio) > MAX_OUTPUT_AUDIO_BYTES:
        raise BinaryAudioFrameError("output_audio_chunk_too_large")
    for field in (
        "turn_id", "core_turn_id", "persona_result_id", "segment_message_id", "stream_id"
    ):
        value = metadata.get(field)
        if not isinstance(value, str) or not value.strip() or len(value) > 256:
            raise BinaryAudioFrameError(f"output_audio_identity_invalid:{field}")
    for field in ("segment_index", "seq", "sample_offset"):
        value = metadata.get(field)
        if type(value) is not int or not 0 <= value <= 9_007_199_254_740_991:
            raise BinaryAudioFrameError(f"output_audio_sequence_invalid:{field}")
    if metadata["seq"] < 1:
        raise BinaryAudioFrameError("output_audio_chunk_requires_start_sequence")
    if metadata["sample_offset"] + len(audio) // 2 > 9_007_199_254_740_991:
        raise BinaryAudioFrameError("output_audio_sample_range_invalid")
    if (
        metadata.get("schema_version") != "olv.incremental_output.v1"
        or metadata.get("encoding") != "pcm16le"
        or type(metadata.get("sample_rate")) is not int
        or metadata["sample_rate"] != 32000
        or type(metadata.get("channels")) is not int
        or metadata["channels"] != 1
    ):
        raise BinaryAudioFrameError("output_audio_format_invalid")
    encoded_metadata = json.dumps(
        metadata, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    if len(encoded_metadata) > MAX_METADATA_BYTES:
        raise BinaryAudioFrameError("output_audio_metadata_too_large")
    return (
        MAGIC
        + bytes((VERSION, FRAME_TYPE_OUTPUT_AUDIO_CHUNK, 0, 0))
        + len(encoded_metadata).to_bytes(4, "little")
        + encoded_metadata
        + audio
    )


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
    capture_mode = _optional_string(metadata.get("capture_mode"))
    if capture_mode is not None and capture_mode not in {"manual", "ptt", "auto"}:
        raise BinaryAudioFrameError(
            "Binary audio metadata `capture_mode` must be manual, ptt, or auto when provided."
        )

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
