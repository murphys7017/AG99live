from __future__ import annotations

from typing import Any

from ..protocol import TYPE_ENGINE_MOTION_INTENT
from .motion_intent import (
    MOTION_INTENT_V4_SCHEMA_VERSION,
    validate_motion_intent_payload,
)


def resolve_motion_payload_schema_version(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("schema_version") or "").strip()


def validate_motion_payload(payload: Any) -> tuple[bool, str]:
    schema_version = resolve_motion_payload_schema_version(payload)
    if schema_version == MOTION_INTENT_V4_SCHEMA_VERSION:
        return validate_motion_intent_payload(payload)
    return False, "unsupported_schema_version"


def resolve_engine_motion_message_type(payload: Any) -> str:
    schema_version = resolve_motion_payload_schema_version(payload)
    if schema_version == MOTION_INTENT_V4_SCHEMA_VERSION:
        return TYPE_ENGINE_MOTION_INTENT
    return ""
