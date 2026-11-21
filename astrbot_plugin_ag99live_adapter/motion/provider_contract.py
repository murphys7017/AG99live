"""Small provider-facing projections for the streaming motion contract.

The runtime wire payload remains strict v4.  These helpers only normalize the
outer record emitted by small streaming models: metadata may be omitted, a
single step may be returned as an object, and an omitted duration weight gets
the light default.  Legacy ``axis_levels`` shapes are left untouched and are
rejected by the v4 normalizer.
"""

from __future__ import annotations

import json
import math
from typing import Any

from .motion_intent import normalize_motion_intent_tags, normalize_motion_steps


def expression_record(value: Any) -> dict[str, Any]:
    """Expand the model's sparse timed poses into the runtime envelope."""
    if not isinstance(value, list):
        raise ValueError("expression_array_required")
    steps = []
    for point in value:
        if not isinstance(point, dict) or "ms" not in point:
            raise ValueError("expression_step_ms_required")
        steps.append({"ms": point["ms"], "axis_values": {
            axis: target for axis, target in point.items() if axis != "ms"
        }})
    normalized, reason = normalize_motion_steps(steps)
    if normalized is None:
        raise ValueError(reason)
    return {"motion_steps": normalized, "intent_tags": ["动作"]}


class ExpressionPrefixDecoder:
    """Consume complete array elements exactly once, retaining the final text for export."""

    def __init__(self) -> None:
        self.cursor = 0
        self.scanned = 0
        self.points: list[dict[str, Any]] = []
        self.closed = False
        self.decoder = json.JSONDecoder()

    def __call__(self, text: str) -> dict[str, Any] | None:
        if self.closed:
            return None
        previous_length = self.scanned
        self.scanned = len(text)
        if text.find("}", previous_length) < 0:
            return None
        cursor = self.cursor
        candidate = None
        while cursor < len(text):
            while cursor < len(text) and text[cursor].isspace():
                cursor += 1
            if cursor == len(text):
                break
            if self.points and text[cursor] == "]":
                self.closed = True
                break
            if text[cursor] != ("," if self.points else "["):
                self.closed = True
                break
            cursor += 1
            while cursor < len(text) and text[cursor].isspace():
                cursor += 1
            try:
                point, end = self.decoder.raw_decode(text, cursor)
            except json.JSONDecodeError:
                break
            try:
                record = expression_record([*self.points, point])
            except (TypeError, ValueError, OverflowError):
                self.closed = True
                break
            self.points.append(point)
            self.cursor = cursor = end
            candidate = record
        return candidate


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
        if not isinstance(raw_step, dict):
            normalized.append(raw_step)
            continue
        if "duration_weight" not in raw_step:
            # The Prompt requires this field, but the provider boundary is
            # intentionally tolerant of a minor omission.  A single omitted
            # weight has the same safe meaning as the default light reaction.
            normalized.append({**raw_step, "duration_weight": 1})
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
    "ExpressionPrefixDecoder",
    "expression_record",
    "describe_provider_motion_record",
    "normalize_provider_motion_record",
]
