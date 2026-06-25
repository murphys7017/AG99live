from __future__ import annotations

from dataclasses import dataclass
from typing import Any


_FALLBACK_HEAD_BODY_CONSTRAINTS = (
    {
        "source_axis_id": "head_yaw",
        "target_axis_id": "body_yaw",
        "scale": 0.5,
        "deadzone": 2.0,
        "max_delta": 12.0,
    },
    {
        "source_axis_id": "head_roll",
        "target_axis_id": "body_roll",
        "scale": 0.45,
        "deadzone": 2.0,
        "max_delta": 10.0,
    },
    {
        "source_axis_id": "head_pitch",
        "target_axis_id": "body_pitch",
        "scale": 0.4,
        "deadzone": 2.0,
        "max_delta": 10.0,
    },
)


@dataclass(frozen=True, slots=True)
class MotionAxisConstraintResult:
    axes: dict[str, float]
    adjusted_axes: list[str]
    notes: list[str]


def apply_motion_axis_constraints(
    *,
    axes: dict[str, Any],
    semantic_profile: dict[str, Any] | None = None,
) -> MotionAxisConstraintResult:
    if not isinstance(axes, dict) or not axes:
        return MotionAxisConstraintResult(axes={}, adjusted_axes=[], notes=[])

    axis_by_id = _build_axis_lookup(semantic_profile)
    constrained = {
        str(axis_id): round(float(value), 4)
        for axis_id, value in axes.items()
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    }
    if not constrained:
        return MotionAxisConstraintResult(axes={}, adjusted_axes=[], notes=[])

    adjusted_axes: list[str] = []
    notes: list[str] = []
    for constraint in _iter_head_body_constraints(semantic_profile):
        source_axis_id = str(constraint["source_axis_id"])
        target_axis_id = str(constraint["target_axis_id"])
        if target_axis_id not in constrained:
            continue

        target_axis = axis_by_id.get(target_axis_id)
        target_value = constrained[target_axis_id]
        target_neutral = _resolve_axis_neutral_value(target_axis)
        target_delta = target_value - target_neutral

        source_present = source_axis_id in constrained
        source_delta = 0.0
        if source_present:
            source_axis = axis_by_id.get(source_axis_id)
            source_delta = constrained[source_axis_id] - _resolve_axis_neutral_value(source_axis)

        hard_cap = _resolve_target_hard_cap(
            axis=target_axis,
            deadzone=float(constraint["deadzone"]),
            max_delta=float(constraint["max_delta"]),
        )
        if source_present:
            if _is_opposite_direction(source_delta, target_delta):
                limit = _resolve_opposite_direction_cap(
                    source_delta=source_delta,
                    deadzone=float(constraint["deadzone"]),
                    scale=float(constraint["scale"]),
                    hard_cap=hard_cap,
                )
                note_kind = "opposite_limit"
            else:
                limit = _resolve_aligned_direction_cap(
                    source_delta=source_delta,
                    deadzone=float(constraint["deadzone"]),
                    scale=float(constraint["scale"]),
                    hard_cap=hard_cap,
                )
                note_kind = "follow_limit"
        else:
            limit = hard_cap
            note_kind = "absolute_limit"

        constrained_delta = max(-limit, min(limit, target_delta))
        constrained_value = round(
            _clamp_to_axis_range(
                target_neutral + constrained_delta,
                axis=target_axis,
            ),
            4,
        )
        if abs(constrained_value - target_value) < 0.0001:
            continue

        constrained[target_axis_id] = constrained_value
        adjusted_axes.append(target_axis_id)
        notes.append(
            f"{source_axis_id}->{target_axis_id}:{note_kind}:{target_value:g}->{constrained_value:g}"
        )

    return MotionAxisConstraintResult(
        axes=constrained,
        adjusted_axes=adjusted_axes,
        notes=notes,
    )


def apply_motion_constraints_to_intent_payload(
    *,
    payload: dict[str, Any],
    semantic_profile: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], MotionAxisConstraintResult]:
    if not isinstance(payload, dict):
        return {}, MotionAxisConstraintResult(axes={}, adjusted_axes=[], notes=[])

    axes = payload.get("axes")
    if not isinstance(axes, dict) or not axes:
        return dict(payload), MotionAxisConstraintResult(axes={}, adjusted_axes=[], notes=[])

    constraint_result = apply_motion_axis_constraints(
        axes=axes,
        semantic_profile=semantic_profile,
    )
    if not constraint_result.adjusted_axes:
        return dict(payload), constraint_result

    updated = dict(payload)
    updated["axes"] = dict(constraint_result.axes)
    summary = dict(updated.get("summary") or {})
    summary["axis_count"] = len(constraint_result.axes)
    summary["axis_constraint_adjusted_axes"] = list(constraint_result.adjusted_axes)
    summary["axis_constraint_notes"] = list(constraint_result.notes[:8])
    updated["summary"] = summary
    return updated, constraint_result


def _iter_head_body_constraints(
    semantic_profile: dict[str, Any] | None,
):
    normalized: dict[tuple[str, str], dict[str, float | str]] = {}
    if isinstance(semantic_profile, dict):
        for raw_coupling in semantic_profile.get("couplings") or []:
            if not isinstance(raw_coupling, dict):
                continue
            source_axis_id = str(raw_coupling.get("source_axis_id") or "").strip()
            target_axis_id = str(raw_coupling.get("target_axis_id") or "").strip()
            if not source_axis_id.startswith("head_") or not target_axis_id.startswith("body_"):
                continue
            scale = _coerce_finite_number(raw_coupling.get("scale"))
            deadzone = _coerce_finite_number(raw_coupling.get("deadzone"))
            max_delta = _coerce_finite_number(raw_coupling.get("max_delta"))
            if scale is None or deadzone is None or max_delta is None:
                continue
            normalized[(source_axis_id, target_axis_id)] = {
                "source_axis_id": source_axis_id,
                "target_axis_id": target_axis_id,
                "scale": scale,
                "deadzone": deadzone,
                "max_delta": max_delta,
            }

    for fallback in _FALLBACK_HEAD_BODY_CONSTRAINTS:
        key = (fallback["source_axis_id"], fallback["target_axis_id"])
        if key not in normalized:
            normalized[key] = dict(fallback)

    return list(normalized.values())


def _resolve_target_hard_cap(
    *,
    axis: dict[str, Any] | None,
    deadzone: float,
    max_delta: float,
) -> float:
    strong_half_span = _resolve_axis_strong_half_span(axis)
    return max(max_delta, strong_half_span + min(deadzone, 6.0))


def _resolve_axis_strong_half_span(axis: dict[str, Any] | None) -> float:
    if not isinstance(axis, dict):
        return 0.0
    strong_range = axis.get("strong_range")
    if not (
        isinstance(strong_range, (list, tuple))
        and len(strong_range) >= 2
        and isinstance(strong_range[0], (int, float))
        and isinstance(strong_range[1], (int, float))
    ):
        return 0.0
    neutral = _resolve_axis_neutral_value(axis)
    return max(
        abs(float(strong_range[1]) - neutral),
        abs(neutral - float(strong_range[0])),
    )


def _resolve_aligned_direction_cap(
    *,
    source_delta: float,
    deadzone: float,
    scale: float,
    hard_cap: float,
) -> float:
    return min(hard_cap, max(deadzone, abs(source_delta) * scale + deadzone))


def _resolve_opposite_direction_cap(
    *,
    source_delta: float,
    deadzone: float,
    scale: float,
    hard_cap: float,
) -> float:
    opposite_cap = abs(source_delta) * (scale * 0.35) + (deadzone * 0.5)
    return min(hard_cap * 0.5, max(deadzone * 0.6, opposite_cap))


def _is_opposite_direction(source_delta: float, target_delta: float) -> bool:
    return source_delta != 0.0 and target_delta != 0.0 and source_delta * target_delta < 0.0


def _build_axis_lookup(
    semantic_profile: dict[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    if not isinstance(semantic_profile, dict):
        return {}
    return {
        str(axis.get("id") or "").strip(): axis
        for axis in semantic_profile.get("axes") or []
        if isinstance(axis, dict) and str(axis.get("id") or "").strip()
    }


def _resolve_axis_neutral_value(axis: dict[str, Any] | None) -> float:
    if isinstance(axis, dict):
        neutral = axis.get("neutral")
        if isinstance(neutral, (int, float)):
            return float(neutral)
    return 50.0


def _clamp_to_axis_range(value: float, *, axis: dict[str, Any] | None) -> float:
    if isinstance(axis, dict):
        value_range = axis.get("value_range")
        if (
            isinstance(value_range, (list, tuple))
            and len(value_range) >= 2
            and isinstance(value_range[0], (int, float))
            and isinstance(value_range[1], (int, float))
        ):
            return max(float(value_range[0]), min(float(value_range[1]), value))
    return max(0.0, min(100.0, value))


def _coerce_finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        return None
    if not float("-inf") < number < float("inf"):
        return None
    return number
