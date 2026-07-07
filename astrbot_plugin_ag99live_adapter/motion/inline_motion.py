from __future__ import annotations

import json
import re
from typing import Any

from .motion_intent import MOTION_INTENT_V3_SCHEMA_VERSION, normalize_motion_intent_payload


INLINE_ANIM_TAG_CAPTURE_PATTERN = re.compile(
    r"<@anim\s*(\{[\s\S]*?\})>\s*",
    re.IGNORECASE,
)


def extract_official_inline_anim_motion_intent(
    value: str,
) -> tuple[dict[str, Any] | None, str]:
    """Extract the official AstrBot inline <@anim> compatibility payload.

    This accepts only the current semantic intent contract inside the tag. The
    tag is a compatibility transport wrapper, not a fallback to legacy motion
    schemas.
    """
    text = str(value or "")
    match = INLINE_ANIM_TAG_CAPTURE_PATTERN.search(text)
    if match is None:
        return None, "inline_anim_missing"

    try:
        wrapper = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None, "inline_anim_json_invalid"

    if not isinstance(wrapper, dict):
        return None, "inline_anim_payload_not_object"

    raw_intent = _resolve_inline_motion_intent_object(wrapper)
    if not isinstance(raw_intent, dict):
        return None, "inline_anim_intent_missing"

    schema_version = str(raw_intent.get("schema_version") or "").strip()
    if schema_version != MOTION_INTENT_V3_SCHEMA_VERSION:
        return None, f"inline_anim_unsupported_schema:{schema_version or 'missing'}"

    try:
        return normalize_motion_intent_payload(raw_intent), "official_inline_anim"
    except ValueError as exc:
        return None, f"inline_anim_invalid:{exc}"


def _resolve_inline_motion_intent_object(wrapper: dict[str, Any]) -> Any:
    if str(wrapper.get("schema_version") or "").strip() == MOTION_INTENT_V3_SCHEMA_VERSION:
        return wrapper
    for key in ("motion_payload", "intent", "plan"):
        value = wrapper.get(key)
        if isinstance(value, dict):
            return value
    return None
