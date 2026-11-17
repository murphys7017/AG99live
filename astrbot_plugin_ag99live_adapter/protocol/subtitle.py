"""Playback subtitle facts reported by the active desktop client."""

from typing import Any

SUBTITLE_SCHEMA = "ag99.subtitle.v1"


def validate_subtitle_state(payload: dict[str, Any]) -> None:
    if payload.get("schema_version") != SUBTITLE_SCHEMA:
        raise ValueError("subtitle_schema_invalid")
    if payload.get("state") not in {"speaking", "text", "ended", "clear"}:
        raise ValueError("subtitle_state_invalid")
    if type(payload.get("sequence")) is not int or not 0 < payload["sequence"] <= 9007199254740991:
        raise ValueError("subtitle_sequence_invalid")
    for key, limit in (("segment_id", 256), ("text", 8192)):
        value = payload.get(key)
        if not isinstance(value, str) or len(value) > limit:
            raise ValueError(f"subtitle_{key}_invalid")
    if payload["state"] in {"speaking", "text"} and not payload["segment_id"]:
        raise ValueError("subtitle_segment_id_required")
