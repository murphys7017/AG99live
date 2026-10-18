"""Bounded observation screenshot wire contract."""

import base64
from typing import Any

from .constants import (
    TYPE_SYSTEM_DESKTOP_OBSERVATION_REQUEST as REQUEST_TYPE,
    TYPE_SYSTEM_DESKTOP_OBSERVATION_RESULT as RESULT_TYPE,
)

SCHEMA = "ag99live.desktop_observation.v1"
MAX_FRAME_CHARS = 1_000_000


def validate_frame_result(payload: dict[str, Any]) -> None:
    if payload.get("schema_version") != SCHEMA:
        raise ValueError("desktop_observation_schema_invalid")
    request_id = payload.get("request_id")
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
        raise ValueError("desktop_observation_request_id_invalid")
    if type(payload.get("ok")) is not bool:
        raise ValueError("desktop_observation_ok_invalid")
    if payload["ok"]:
        data = payload.get("data")
        if (
            payload.get("mime_type") != "image/jpeg"
            or not isinstance(data, str)
            or not 1 <= len(data) <= MAX_FRAME_CHARS
        ):
            raise ValueError("desktop_observation_image_invalid")
        try:
            decoded = base64.b64decode(data, validate=True)
        except ValueError as exc:
            raise ValueError("desktop_observation_base64_invalid") from exc
        if not decoded.startswith(b"\xff\xd8\xff"):
            raise ValueError("desktop_observation_jpeg_invalid")
    elif not isinstance(payload.get("error"), str) or len(payload["error"]) > 128:
        raise ValueError("desktop_observation_error_invalid")


__all__ = ["SCHEMA", "REQUEST_TYPE", "RESULT_TYPE", "validate_frame_result"]
