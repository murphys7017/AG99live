from __future__ import annotations

from typing import Any

from ..protocol.schema_versions import CATALOG_MOTION_SCHEMA_VERSION


def normalize_catalog_motion_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("catalog_motion_not_object")

    schema_version = str(payload.get("schema_version") or "").strip()
    if schema_version != CATALOG_MOTION_SCHEMA_VERSION:
        raise ValueError("invalid_schema_version")

    model_id = str(payload.get("model_id") or "").strip()
    if not model_id:
        raise ValueError("model_id_empty")

    motion_id = str(payload.get("motion_id") or "").strip()
    if not motion_id:
        raise ValueError("motion_id_empty")

    group = str(payload.get("group") or "").strip()
    if not group:
        raise ValueError("group_empty")

    index_raw = payload.get("index")
    if not isinstance(index_raw, int) or index_raw < 0:
        raise ValueError("index_invalid")

    file_value = str(payload.get("file") or "").strip().replace("\\", "/")
    if not file_value:
        raise ValueError("file_empty")

    label = str(payload.get("label") or "").strip()
    emotion_label = str(payload.get("emotion_label") or "").strip()
    if not emotion_label:
        emotion_label = label or motion_id

    duration_raw = payload.get("duration_ms")
    duration_ms: int | None = None
    if duration_raw is not None:
        if not isinstance(duration_raw, (int, float)):
            raise ValueError("duration_ms_not_number")
        duration_ms = int(round(float(duration_raw)))
        if duration_ms < 320 or duration_ms > 15000:
            raise ValueError("duration_ms_out_of_range")

    priority_raw = payload.get("priority")
    priority = 3
    if priority_raw is not None:
        if not isinstance(priority_raw, int):
            raise ValueError("priority_invalid")
        priority = max(1, min(5, priority_raw))

    return {
        "schema_version": CATALOG_MOTION_SCHEMA_VERSION,
        "model_id": model_id,
        "motion_id": motion_id,
        "group": group,
        "index": index_raw,
        "file": file_value,
        "label": label,
        "emotion_label": emotion_label,
        "duration_ms": duration_ms,
        "priority": priority,
        "summary": {
            "source": "motion_catalog",
        },
    }


def validate_catalog_motion_payload(payload: Any) -> tuple[bool, str]:
    try:
        normalize_catalog_motion_payload(payload)
    except ValueError as exc:
        return False, str(exc)
    return True, ""


def summarize_catalog_motion_payload(payload: Any) -> tuple[str, str, str, str]:
    if not isinstance(payload, dict):
        return "", "", "", "catalog_motion_not_object"
    valid, failure_reason = validate_catalog_motion_payload(payload)
    return (
        str(payload.get("schema_version") or "").strip(),
        str(payload.get("motion_id") or "").strip(),
        str(payload.get("emotion_label") or "").strip(),
        "" if valid else failure_reason,
    )
