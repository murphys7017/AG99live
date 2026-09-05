from __future__ import annotations

from typing import Any

from ..protocol.constants import TYPE_ENGINE_MOTION_INTENT
from .motion_intent import MOTION_INTENT_V4_SCHEMA_VERSION


def resolve_motion_payload_schema_version(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("schema_version") or "").strip()


def resolve_engine_motion_message_type(payload: Any) -> str:
    schema_version = resolve_motion_payload_schema_version(payload)
    if schema_version == MOTION_INTENT_V4_SCHEMA_VERSION:
        return TYPE_ENGINE_MOTION_INTENT
    return ""
