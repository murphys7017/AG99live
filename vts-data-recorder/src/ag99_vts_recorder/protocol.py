from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping
from uuid import uuid4


API_NAME = "VTubeStudioPublicAPI"
API_VERSION = "1.0"


class VTSProtocolError(RuntimeError):
    """Raised when an inbound VTube Studio message is structurally invalid."""


class VTSAPIError(VTSProtocolError):
    """Raised when VTube Studio returns an APIError response."""

    def __init__(self, error_id: int | None, message: str) -> None:
        self.error_id = error_id
        self.api_message = message
        suffix = f"{error_id}: {message}" if error_id is not None else message
        super().__init__(f"VTube Studio API error: {suffix}")


@dataclass(frozen=True)
class InboundMessage:
    request_id: str | None
    message_type: str
    data: Mapping[str, Any]
    timestamp_ms: int | None
    raw: Mapping[str, Any]


def build_request(
    message_type: str,
    data: Mapping[str, Any] | None = None,
    *,
    request_id: str | None = None,
) -> dict[str, Any]:
    normalized_type = str(message_type or "").strip()
    if not normalized_type:
        raise ValueError("message_type is required")
    return {
        "apiName": API_NAME,
        "apiVersion": API_VERSION,
        "requestID": request_id or str(uuid4()),
        "messageType": normalized_type,
        "data": dict(data or {}),
    }


def parse_inbound_message(raw: Any) -> InboundMessage:
    if not isinstance(raw, Mapping):
        raise VTSProtocolError("VTube Studio message must be a JSON object")

    message_type = str(raw.get("messageType") or "").strip()
    if not message_type:
        raise VTSProtocolError("VTube Studio message is missing messageType")

    data = raw.get("data")
    if not isinstance(data, Mapping):
        raise VTSProtocolError(f"VTube Studio {message_type} data must be a JSON object")

    raw_request_id = raw.get("requestID")
    request_id = str(raw_request_id).strip() if raw_request_id is not None else None
    return InboundMessage(
        request_id=request_id or None,
        message_type=message_type,
        data=data,
        timestamp_ms=_coerce_timestamp_ms(raw.get("timestamp")),
        raw=raw,
    )


def raise_for_api_error(message: InboundMessage) -> None:
    if message.message_type != "APIError":
        return
    raw_error_id = message.data.get("errorID")
    try:
        error_id = int(raw_error_id) if raw_error_id is not None else None
    except (TypeError, ValueError):
        error_id = None
    error_message = str(message.data.get("message") or "Unknown VTube Studio API error")
    raise VTSAPIError(error_id, error_message)


def _coerce_timestamp_ms(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None
