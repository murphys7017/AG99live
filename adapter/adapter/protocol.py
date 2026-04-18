"""Minimal protocol definitions for the OLV desktop-pet mode."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

INBOUND_TEXT_INPUT = "text-input"
INBOUND_FRONTEND_PLAYBACK_COMPLETE = "frontend-playback-complete"

SUPPORTED_INBOUND_TYPES = {
    INBOUND_TEXT_INPUT,
    INBOUND_FRONTEND_PLAYBACK_COMPLETE,
}

OUTBOUND_SET_MODEL_AND_CONF = "set-model-and-conf"
OUTBOUND_CONTROL = "control"
OUTBOUND_FULL_TEXT = "full-text"
OUTBOUND_AUDIO = "audio"
OUTBOUND_BACKEND_SYNTH_COMPLETE = "backend-synth-complete"
OUTBOUND_FORCE_NEW_MESSAGE = "force-new-message"
OUTBOUND_ERROR = "error"


class ProtocolError(ValueError):
    """Raised when inbound data does not match the minimal protocol."""


@dataclass(frozen=True)
class TextInputPayload:
    """Normalized payload for a `text-input` message."""

    text: str
    images: list[Any]


@dataclass(frozen=True)
class PlaybackCompletePayload:
    """Normalized payload for a `frontend-playback-complete` message."""


@dataclass(frozen=True)
class InboundMessage:
    """A validated inbound message."""

    msg_type: str
    payload: TextInputPayload | PlaybackCompletePayload


def normalize_inbound_message(raw: Mapping[str, Any]) -> InboundMessage:
    """Validate and normalize inbound OLV desktop messages."""
    msg_type = raw.get("type")
    if msg_type not in SUPPORTED_INBOUND_TYPES:
        raise ProtocolError(f"Unsupported message type: {msg_type}")

    if msg_type == INBOUND_FRONTEND_PLAYBACK_COMPLETE:
        return InboundMessage(msg_type=msg_type, payload=PlaybackCompletePayload())

    text = raw.get("text")
    if not isinstance(text, str):
        raise ProtocolError("`text-input` requires `text` to be a string.")
    text = text.strip()
    if not text:
        raise ProtocolError("`text-input` requires non-empty `text`.")

    images_raw = raw.get("images", [])
    if images_raw is None:
        images_raw = []
    if not isinstance(images_raw, list):
        raise ProtocolError("`images` must be a list when provided.")

    return InboundMessage(
        msg_type=msg_type,
        payload=TextInputPayload(text=text, images=images_raw),
    )

