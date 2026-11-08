"""Small provider-facing projections for the streaming motion contract.

The runtime wire payload remains strict v4.  These helpers only normalize the
outer record emitted by small streaming models: metadata may be omitted and a
single step may be returned as an object.  Legacy ``axis_levels`` shapes are
left untouched and are rejected by the v4 normalizer.
"""

from __future__ import annotations

import math
from typing import Any

from .motion_intent import normalize_motion_intent_tags


def normalize_provider_motion_record(
    value: Any,
    *,
    default_intent_tag: str,
    infer_emit_decision: bool = False,
) -> dict[str, Any]:
    """Project one streamed provider object into the current outer contract."""

    if not isinstance(value, dict):
        raise ValueError("provider_motion_record_not_object")
    if value == {"skip": True}:
        return value

    record = dict(value)
    steps = record.get("motion_steps")
    if isinstance(steps, dict):
        record["motion_steps"] = [steps]
    if "motion_steps" in record:
        record["motion_steps"] = _coerce_provider_duration_weights(
            record.get("motion_steps")
        )

    tags = normalize_motion_intent_tags(record.get("intent_tags"))
    record["intent_tags"] = tags or [default_intent_tag]
    if infer_emit_decision and "motion_steps" in record:
        record.setdefault("decision", "emit")
    return record


def _coerce_provider_duration_weights(value: Any) -> Any:
    """Keep provider-generated step sequences executable without changing shape."""

    if not isinstance(value, list):
        return value
    normalized: list[Any] = []
    for raw_step in value:
        if not isinstance(raw_step, dict) or "duration_weight" not in raw_step:
            normalized.append(raw_step)
            continue
        raw_weight = raw_step.get("duration_weight")
        if isinstance(raw_weight, bool):
            normalized.append(raw_step)
            continue
        try:
            number = float(raw_weight)
        except (TypeError, ValueError, OverflowError):
            normalized.append(raw_step)
            continue
        if not math.isfinite(number):
            normalized.append(raw_step)
            continue
        bounded = min(3.0, max(1.0, number))
        weight = int(math.floor(bounded + 0.5))
        if type(raw_weight) is int and raw_weight == weight:
            normalized.append(raw_step)
            continue
        normalized.append({**raw_step, "duration_weight": weight})
    return normalized


def describe_provider_motion_record(value: Any) -> str:
    """Return bounded structural diagnostics without recording model text."""

    if not isinstance(value, dict):
        return f"type={type(value).__name__}"
    steps = value.get("motion_steps")
    tags = value.get("intent_tags")
    if isinstance(steps, list):
        step_type = "list"
        step_count = len(steps)
    elif steps is None:
        step_type = "missing"
        step_count = 0
    else:
        step_type = type(steps).__name__
        step_count = -1
    if isinstance(tags, (list, tuple, set)):
        tag_type = type(tags).__name__
        tag_count = len(tags)
    elif tags is None:
        tag_type = "missing"
        tag_count = 0
    else:
        tag_type = type(tags).__name__
        tag_count = -1
    return (
        f"fields={','.join(sorted(str(key) for key in value))} "
        f"decision={value.get('decision', '<missing>')!r} "
        f"motion_steps_type={step_type} motion_steps_count={step_count} "
        f"intent_tags_type={tag_type} intent_tags_count={tag_count}"
    )


__all__ = [
    "describe_provider_motion_record",
    "normalize_provider_motion_record",
]
