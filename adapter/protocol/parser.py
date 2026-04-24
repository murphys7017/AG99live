"""V2 protocol message parser and envelope builder."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping
from uuid import uuid4

from .constants import (
    INBOUND_ALLOWED_TYPES,
    KNOWN_MESSAGE_TYPES,
    PROTOCOL_VERSION,
    SOURCE_FRONTEND,
    TYPE_CONTROL_PLAYBACK_FINISHED,
    TYPE_INPUT_AUDIO_STREAM_CHUNK,
    TYPE_INPUT_TEXT,
    TYPE_SYSTEM_HISTORY_DELETE,
    TYPE_SYSTEM_HISTORY_LOAD,
)
from .models import (
    InboundMessage,
    ProtocolError,
    ProtocolMessage,
    TextInputPayload,
)


def parse_inbound_message(
    raw: Mapping[str, Any],
    *,
    default_session_id: str,
) -> ProtocolMessage:
    if not isinstance(raw, Mapping):
        raise ProtocolError("Protocol payload must be an object.")

    message_type = _require_message_type(raw.get("type"))
    if message_type not in KNOWN_MESSAGE_TYPES:
        raise ProtocolError(f"Unsupported message type: {message_type}")
    if message_type not in INBOUND_ALLOWED_TYPES:
        raise ProtocolError(f"Inbound message type is not allowed: {message_type}")

    payload_raw = raw.get("payload", {})
    if payload_raw is None:
        payload_raw = {}
    if not isinstance(payload_raw, Mapping):
        raise ProtocolError("`payload` must be an object.")

    payload = dict(payload_raw)
    session_id = _normalize_session_id(raw.get("session_id"), default_session_id)
    turn_id = _normalize_optional_string(raw.get("turn_id"))
    source = _normalize_source(raw.get("source"), SOURCE_FRONTEND)
    version = _normalize_optional_string(raw.get("version")) or PROTOCOL_VERSION
    message_id = _normalize_optional_string(raw.get("message_id")) or uuid4().hex
    timestamp = _normalize_optional_string(raw.get("timestamp")) or _utc_now_iso()

    _validate_payload(message_type, payload)

    normalized_raw = {
        "type": message_type,
        "version": version,
        "message_id": message_id,
        "timestamp": timestamp,
        "session_id": session_id,
        "turn_id": turn_id,
        "source": source,
        "payload": payload,
    }
    return ProtocolMessage(
        type=message_type,
        version=version,
        message_id=message_id,
        timestamp=timestamp,
        session_id=session_id,
        turn_id=turn_id,
        source=source,
        payload=payload,
        raw=normalized_raw,
    )


def normalize_inbound_message(
    raw: Mapping[str, Any],
    *,
    default_session_id: str,
) -> InboundMessage:
    envelope = parse_inbound_message(raw, default_session_id=default_session_id)
    if envelope.type != TYPE_INPUT_TEXT:
        raise ProtocolError(f"Expected `{TYPE_INPUT_TEXT}`, got `{envelope.type}`")

    text = str(envelope.payload.get("text") or "").strip()
    images = envelope.payload.get("images", [])
    if not isinstance(images, list):
        raise ProtocolError("`payload.images` must be a list when provided.")
    return InboundMessage(
        envelope=envelope,
        payload=TextInputPayload(text=text, images=images),
    )


def build_message_envelope(
    message_type: str,
    *,
    session_id: str,
    source: str,
    payload: Mapping[str, Any] | None = None,
    turn_id: str | None = None,
    version: str = PROTOCOL_VERSION,
    message_id: str | None = None,
    timestamp: str | None = None,
) -> dict[str, Any]:
    if message_type not in KNOWN_MESSAGE_TYPES:
        raise ProtocolError(f"Unsupported outbound message type: {message_type}")

    payload_dict = dict(payload or {})
    return {
        "type": message_type,
        "version": version,
        "message_id": message_id or uuid4().hex,
        "timestamp": timestamp or _utc_now_iso(),
        "session_id": session_id,
        "turn_id": turn_id,
        "source": source,
        "payload": payload_dict,
    }


def _validate_payload(message_type: str, payload: dict[str, Any]) -> None:
    if message_type == TYPE_INPUT_TEXT:
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ProtocolError("`input.text` requires `payload.text` to be a non-empty string.")
        images = payload.get("images", [])
        if images is None:
            payload["images"] = []
        elif not isinstance(images, list):
            raise ProtocolError("`input.text` requires `payload.images` to be a list when provided.")
        return

    if message_type == TYPE_CONTROL_PLAYBACK_FINISHED:
        success = payload.get("success", True)
        if not isinstance(success, bool):
            raise ProtocolError("`control.playback_finished` requires `payload.success` to be a boolean.")
        reason = payload.get("reason")
        if reason is not None and not isinstance(reason, str):
            raise ProtocolError("`control.playback_finished` requires `payload.reason` to be a string when provided.")
        return

    history_uid_types = {
        TYPE_SYSTEM_HISTORY_LOAD,
        TYPE_SYSTEM_HISTORY_DELETE,
    }
    if message_type in history_uid_types:
        history_uid = payload.get("history_uid")
        if not isinstance(history_uid, str) or not history_uid.strip():
            raise ProtocolError(f"`{message_type}` requires `payload.history_uid` to be a non-empty string.")
        return

    if message_type == TYPE_INPUT_AUDIO_STREAM_CHUNK:
        audio_base64 = payload.get("audio_base64")
        if not isinstance(audio_base64, str) or not audio_base64:
            raise ProtocolError("`input.audio_stream_chunk` requires `payload.audio_base64`.")
        return


def _require_message_type(value: Any) -> str:
    normalized = _normalize_optional_string(value)
    if not normalized:
        raise ProtocolError("`type` is required.")
    return normalized


def _normalize_session_id(value: Any, default: str) -> str:
    normalized = _normalize_optional_string(value)
    return normalized or default


def _normalize_source(value: Any, default: str) -> str:
    normalized = _normalize_optional_string(value)
    return normalized or default


def _normalize_optional_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
