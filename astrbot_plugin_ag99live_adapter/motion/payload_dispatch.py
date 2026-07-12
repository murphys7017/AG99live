from __future__ import annotations

from typing import Any

from ..protocol import (
    TYPE_ENGINE_CATALOG_MOTION,
    TYPE_ENGINE_MOTION_INTENT,
)
from .catalog_motion import (
    normalize_catalog_motion_payload,
    summarize_catalog_motion_payload,
    validate_catalog_motion_payload,
)
from .motion_intent import (
    MOTION_INTENT_V3_SCHEMA_VERSION,
    MOTION_INTENT_V4_SCHEMA_VERSION,
    normalize_motion_intent_payload,
    validate_motion_intent_payload,
)


def resolve_motion_payload_schema_version(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("schema_version") or "").strip()


def validate_motion_payload(payload: Any) -> tuple[bool, str]:
    schema_version = resolve_motion_payload_schema_version(payload)
    if schema_version in {MOTION_INTENT_V3_SCHEMA_VERSION, MOTION_INTENT_V4_SCHEMA_VERSION}:
        return validate_motion_intent_payload(payload)
    if schema_version == "engine.catalog_motion.v1":
        return validate_catalog_motion_payload(payload)
    return False, "unsupported_schema_version"


def resolve_engine_motion_message_type(payload: Any) -> str:
    schema_version = resolve_motion_payload_schema_version(payload)
    if schema_version in {MOTION_INTENT_V3_SCHEMA_VERSION, MOTION_INTENT_V4_SCHEMA_VERSION}:
        return TYPE_ENGINE_MOTION_INTENT
    if schema_version == "engine.catalog_motion.v1":
        return TYPE_ENGINE_CATALOG_MOTION
    return ""


def summarize_motion_payload(plan: Any) -> tuple[str, str, int, int, str]:
    if not isinstance(plan, dict):
        return "", "", 0, 0, "plan_not_object"

    schema_version = str(plan.get("schema_version") or "").strip()
    if schema_version == "engine.catalog_motion.v1":
        catalog_schema, motion_id, emotion_label, failure_reason = summarize_catalog_motion_payload(plan)
        return catalog_schema, motion_id or emotion_label, 0, 0, failure_reason

    mode = str(plan.get("mode") or "").strip().lower()
    if schema_version in {MOTION_INTENT_V3_SCHEMA_VERSION, MOTION_INTENT_V4_SCHEMA_VERSION} and not mode:
        mode = "expressive"
    axes = plan.get("axes")
    if axes is None:
        axes = plan.get("axis_levels")
    motion_steps = plan.get("motion_steps")
    if not isinstance(axes, dict) and isinstance(motion_steps, list):
        sequence_axis_ids: set[str] = set()
        for step in motion_steps:
            step_axes = step.get("axis_levels") if isinstance(step, dict) else None
            if not isinstance(step_axes, dict):
                continue
            sequence_axis_ids.update(
                str(axis_id).strip()
                for axis_id in step_axes
                if str(axis_id).strip()
            )
        axes = {axis_id: 0 for axis_id in sequence_axis_ids}
    if axes is None:
        axes = plan.get("key_axes")
    supplementary = plan.get("supplementary_params")
    parameters = plan.get("parameters")
    axis_count = len(axes) if isinstance(axes, dict) else 0
    supplementary_count = len(supplementary) if isinstance(supplementary, list) else (
        len(parameters) if isinstance(parameters, list) else 0
    )
    valid, failure_reason = validate_motion_payload(plan)
    return schema_version, mode, axis_count, supplementary_count, "" if valid else failure_reason


def extract_message_motion_payload(
    message_type: str,
    payload: Any,
) -> tuple[dict[str, Any] | None, str]:
    if not isinstance(payload, dict):
        return None, "payload_not_object"

    if message_type == TYPE_ENGINE_MOTION_INTENT:
        motion_payload = payload.get("intent")
        if not isinstance(motion_payload, dict):
            return None, "missing_intent_object"
        try:
            motion_payload = normalize_motion_intent_payload(motion_payload)
        except ValueError as exc:
            return None, str(exc)
    elif message_type == TYPE_ENGINE_CATALOG_MOTION:
        motion_payload = payload.get("motion")
        if not isinstance(motion_payload, dict):
            return None, "missing_motion_object"
        try:
            motion_payload = normalize_catalog_motion_payload(motion_payload)
        except ValueError as exc:
            return None, str(exc)
    else:
        return None, "unsupported_message_type"

    resolved_message_type = resolve_engine_motion_message_type(motion_payload)
    if resolved_message_type != message_type:
        return None, "message_type_payload_schema_mismatch"

    return motion_payload, ""
