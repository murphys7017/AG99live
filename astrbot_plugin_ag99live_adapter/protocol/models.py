"""V2 protocol data models for the AG99live desktop adapter."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


class ProtocolError(ValueError):
    """Raised when inbound data does not match the AG99live V2 protocol."""


@dataclass(frozen=True)
class ProtocolMessage:
    type: str
    version: str
    message_id: str
    timestamp: str
    session_id: str
    turn_id: str | None
    source: str
    payload: dict[str, Any]
    raw: dict[str, Any]

    @property
    def category(self) -> str:
        return self.type.split(".", 1)[0]


@dataclass(frozen=True)
class TextInputPayload:
    text: str
    images: list[Any]


@dataclass(frozen=True)
class InboundMessage:
    envelope: ProtocolMessage
    payload: TextInputPayload
