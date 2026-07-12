from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..motion.motion_intent import (
    MOTION_INTENT_V4_SCHEMA_VERSION,
    derive_motion_emotion_label,
    normalize_motion_intent_tags,
    normalize_motion_resource_id,
    _normalize_duration_hint_ms,
    resolve_selected_semantic_axis_profile,
)
from ..motion.resource_catalog import (
    build_motion_resource_candidates,
    validate_motion_resource_id,
)
from ..prompts.semantic_axis_prompt import profile_prompt_axes


def normalize_motion_arguments_payload(
    raw_motion_arguments: dict[str, Any],
    runtime_state: Any,
    *,
    base_reason: str,
    append_resolution_reason,
    sanitize_reason_fragment,
) -> tuple[dict[str, Any] | None, str]:
    motion_hint = dict(raw_motion_arguments)
    forbidden_fields = [
        key
        for key in (
            "choice",
            "mode",
            "motion_id",
            "catalog_motion",
            "motion3",
            "exp3",
            "kind",
            "emotion",
            "emotion_label",
            "summary",
            "resource_id",
        )
        if key in motion_hint
    ]
    if forbidden_fields:
        return None, append_resolution_reason(
            base_reason,
            "forbidden_fields:" + ",".join(forbidden_fields),
        )
    if "axes" in motion_hint:
        return None, append_resolution_reason(
            base_reason,
            "axes_forbidden_use_axis_levels",
        )

    try:
        semantic_profile = resolve_selected_semantic_axis_profile(
            runtime_state=runtime_state
        )
    except Exception as exc:  # noqa: BLE001
        return None, f"semantic_profile_unresolved:{exc}"

    profile_id = str(semantic_profile.get("profile_id") or "").strip()
    if not profile_id:
        return None, "profile_id_empty"

    intent_tags = normalize_motion_intent_tags(motion_hint.get("intent_tags"))
    if not intent_tags:
        return None, append_resolution_reason(base_reason, "intent_tags_empty")
    emotion_label = derive_motion_emotion_label(intent_tags)
    requested_expression_resource_id = normalize_motion_resource_id(
        motion_hint.get("expression_resource_id")
    )
    requested_motion_resource_id = normalize_motion_resource_id(
        motion_hint.get("motion_resource_id")
    )
    if requested_expression_resource_id and requested_motion_resource_id:
        return None, append_resolution_reason(
            base_reason,
            "multiple_resource_layers_forbidden",
        )
    has_axis_levels = "axis_levels" in motion_hint
    has_motion_steps = "motion_steps" in motion_hint
    if has_axis_levels == has_motion_steps:
        return None, append_resolution_reason(
            base_reason,
            "axis_levels_motion_steps_exclusive",
        )
    validated_levels: dict[str, int] | None = None
    motion_steps: list[dict[str, Any]] | None = None
    rejected_levels: list[str] = []
    reason = base_reason
    if has_axis_levels:
        validated_levels, rejected_levels = normalize_effect_axis_levels(
            motion_hint.get("axis_levels"),
        )
    else:
        motion_steps, motion_steps_error = normalize_effect_motion_steps(
            motion_hint.get("motion_steps")
        )
        if motion_steps_error:
            return None, append_resolution_reason(reason, motion_steps_error)
    if rejected_levels:
        return None, append_resolution_reason(
            reason,
            "rejected_axis_levels:" + ",".join(rejected_levels),
        )
    if has_axis_levels and not validated_levels:
        reason = append_resolution_reason(reason, "axis_levels_empty_or_invalid")

    resource_candidates = build_motion_resource_candidates(
        runtime_state=runtime_state,
    )
    expression_resource_id, expression_resource_reason = validate_motion_resource_id_for_payload(
        requested_expression_resource_id,
        candidates=resource_candidates,
        resource_type="expression",
        sanitize_reason_fragment=sanitize_reason_fragment,
    )
    if expression_resource_reason:
        reason = append_resolution_reason(reason, expression_resource_reason)
        if requested_expression_resource_id and not expression_resource_id:
            return None, reason
    motion_resource_id, motion_resource_reason = validate_motion_resource_id_for_payload(
        requested_motion_resource_id,
        candidates=resource_candidates,
        resource_type="motion",
        sanitize_reason_fragment=sanitize_reason_fragment,
    )
    if motion_resource_reason:
        reason = append_resolution_reason(reason, motion_resource_reason)
        if requested_motion_resource_id and not motion_resource_id:
            return None, reason

    if motion_steps and motion_resource_id:
        return None, append_resolution_reason(
            reason,
            "motion_steps_motion_resource_mutually_exclusive",
        )

    if has_axis_levels and not validated_levels:
        return None, reason

    try:
        duration_hint_ms = _normalize_duration_hint_ms(motion_hint.get("duration_hint_ms"))
    except ValueError as exc:
        return None, append_resolution_reason(reason, str(exc))
    payload = {
        "schema_version": MOTION_INTENT_V4_SCHEMA_VERSION,
        "profile_id": profile_id,
        "profile_revision": int(semantic_profile.get("revision") or 0),
        "model_id": str(semantic_profile.get("model_id") or "").strip(),
        "mode": "expressive",
        "intent_tags": intent_tags,
        "emotion_label": emotion_label,
        "duration_hint_ms": duration_hint_ms,
        "expression_resource_id": expression_resource_id,
        "motion_resource_id": motion_resource_id,
        "summary": {
            "axis_count": len(validated_levels or motion_steps[0]["axis_levels"]),
            "intent_tag_count": len(intent_tags),
            "motion_step_count": len(motion_steps or []),
        },
    }
    if validated_levels:
        payload["axis_levels"] = validated_levels
    if motion_steps:
        payload["motion_steps"] = motion_steps
    return payload, reason


def validate_motion_resource_id_for_payload(
    resource_id: Any,
    *,
    candidates: list[dict[str, Any]],
    resource_type: str | None = None,
    sanitize_reason_fragment,
) -> tuple[str, str]:
    normalized = normalize_motion_resource_id(resource_id)
    if not normalized:
        return "", ""
    if validate_motion_resource_id(
        normalized,
        candidates=candidates,
        resource_type=resource_type,
    ):
        return normalized, f"{resource_type or 'resource'}_id_validated"
    return "", (
        f"{resource_type or 'resource'}_id_rejected:"
        f"{sanitize_reason_fragment(normalized)}"
    )


def are_motion_axes_all_neutralish(
    axes: dict[str, float],
    semantic_profile: dict[str, Any],
) -> bool:
    """Describe neutrality for prompt diagnostics without changing the payload."""
    if not axes:
        return False
    axis_by_id = build_prompt_axis_lookup(semantic_profile)
    checked = 0
    for axis_id, value in axes.items():
        axis = axis_by_id.get(str(axis_id or "").strip())
        if axis is None:
            continue
        checked += 1
        if not is_axis_soft_range_neutral(float(value), axis):
            return False
    return checked > 0


def normalize_effect_axes(
    axes: Any,
) -> tuple[dict[str, float] | None, list[str]]:
    if not isinstance(axes, dict) or not axes:
        return None, []

    normalized_axes: dict[str, float] = {}
    rejected_axes: list[str] = []
    for axis_id_raw, axis_value in axes.items():
        axis_id = str(axis_id_raw or "").strip()
        if not axis_id:
            continue
        if isinstance(axis_value, dict):
            rejected_axes.append(axis_id)
            continue
        number = _coerce_effect_axis_number(axis_value)
        if number is None:
            rejected_axes.append(axis_id)
            continue

        normalized_axes[axis_id] = round(number, 4)

    if not normalized_axes:
        return None, rejected_axes

    return normalized_axes, rejected_axes


def normalize_motion_axis_levels(
    levels: Any,
) -> tuple[dict[str, int] | None, list[str]]:
    if not isinstance(levels, dict) or not levels:
        return None, []
    normalized_levels: dict[str, int] = {}
    rejected_levels: list[str] = []
    for axis_id_raw, level in levels.items():
        axis_id = str(axis_id_raw or "").strip()
        if not axis_id:
            rejected_levels.append("empty_axis_id")
            continue
        if axis_id in normalized_levels:
            rejected_levels.append(f"duplicate_axis_id:{axis_id}")
            continue
        if isinstance(level, bool) or not isinstance(level, int) or level < -3 or level > 3:
            rejected_levels.append(axis_id)
            continue
        normalized_levels[axis_id] = level
    if not normalized_levels:
        return None, rejected_levels
    return normalized_levels, rejected_levels


normalize_effect_axis_levels = normalize_motion_axis_levels


def normalize_effect_motion_steps(
    value: Any,
) -> tuple[list[dict[str, Any]] | None, str]:
    if not isinstance(value, list) or len(value) < 2 or len(value) > 4:
        return None, "motion_steps_count_invalid"
    normalized_steps: list[dict[str, Any]] = []
    expected_axis_ids: set[str] | None = None
    for index, step in enumerate(value):
        if not isinstance(step, dict):
            return None, f"motion_step_not_object:{index}"
        unknown_fields = sorted(set(step) - {"axis_levels", "duration_weight"})
        if unknown_fields:
            return None, f"motion_step_forbidden_fields:{index}:{','.join(unknown_fields)}"
        levels, rejected = normalize_motion_axis_levels(step.get("axis_levels"))
        if rejected:
            return None, f"motion_step_rejected_axis_levels:{index}:{','.join(rejected)}"
        if not levels:
            return None, f"motion_step_axis_levels_empty:{index}"
        axis_ids = set(levels)
        if expected_axis_ids is None:
            expected_axis_ids = axis_ids
        elif axis_ids != expected_axis_ids:
            return None, f"motion_step_axis_set_mismatch:{index}"
        duration_weight = step.get("duration_weight")
        if (
            isinstance(duration_weight, bool)
            or not isinstance(duration_weight, int)
            or duration_weight < 1
            or duration_weight > 3
        ):
            return None, f"motion_step_duration_weight_invalid:{index}"
        normalized_steps.append(
            {
                "axis_levels": levels,
                "duration_weight": duration_weight,
            }
        )
    return normalized_steps, ""


def _coerce_effect_axis_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
    else:
        return None

    if not float("-inf") < number < float("inf"):
        return None
    return number


def build_motion_visibility_summary(
    *,
    axes: dict[str, float],
    semantic_profile: dict[str, Any],
    intent_tags: list[str] | None = None,
    resource_id: str = "",
) -> dict[str, Any]:
    axis_by_id = build_prompt_axis_lookup(semantic_profile)
    active_groups: set[str] = set()
    max_delta_from_neutral = 0.0
    neutralish_axes: list[str] = []
    expressive_axes: list[str] = []
    outside_soft_range_axes: list[str] = []

    for axis_id, raw_value in axes.items():
        axis = axis_by_id.get(str(axis_id))
        if axis is None:
            continue
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            continue
        delta = abs(resolve_axis_neutral_delta(value, axis))
        max_delta_from_neutral = max(max_delta_from_neutral, delta)
        group = str(axis.get("semantic_group") or "").strip().lower()
        if group:
            active_groups.add(group)
        if is_axis_soft_range_neutral(value, axis):
            neutralish_axes.append(str(axis_id))
        else:
            expressive_axes.append(str(axis_id))
            outside_soft_range_axes.append(str(axis_id))

    skeleton_groups = ("head", "body", "gaze")
    covered_skeleton_groups = [group for group in skeleton_groups if group in active_groups]
    missing_skeleton_groups = [group for group in skeleton_groups if group not in active_groups]

    return {
        "axis_count": len(axes),
        "intent_tags": list(intent_tags or []),
        "intent_tag_count": len(intent_tags or []),
        "resource_id": resource_id,
        "active_groups": sorted(active_groups),
        "skeleton_groups": covered_skeleton_groups,
        "skeleton_groups_present": covered_skeleton_groups,
        "missing_skeleton_groups": missing_skeleton_groups,
        "max_delta_from_neutral": round(max_delta_from_neutral, 4),
        "neutralish_axis_count": len(neutralish_axes),
        "expressive_axis_count": len(expressive_axes),
        "neutralish_axes": neutralish_axes[:12],
        "expressive_axes": expressive_axes[:12],
        "outside_soft_range_axes": outside_soft_range_axes[:12],
        "pose_descriptors": describe_axis_descriptors(axes, axis_by_id=axis_by_id)[:8],
    }


def is_axis_soft_range_neutral(value: float, axis: dict[str, Any]) -> bool:
    soft_range = axis.get("soft_range")
    if isinstance(soft_range, (list, tuple)) and len(soft_range) >= 2:
        try:
            return float(soft_range[0]) <= value <= float(soft_range[1])
        except (TypeError, ValueError):
            pass
    try:
        neutral = float(axis.get("neutral", 50))
    except (TypeError, ValueError):
        neutral = 50.0
    return abs(value - neutral) <= 2.0


def resolve_axis_value_range(axis: dict[str, Any]) -> tuple[float, float]:
    value_range = axis.get("value_range")
    if (
        isinstance(value_range, list)
        and len(value_range) == 2
        and isinstance(value_range[0], (int, float))
        and isinstance(value_range[1], (int, float))
        and float(value_range[0]) < float(value_range[1])
    ):
        return float(value_range[0]), float(value_range[1])
    return 0.0, 100.0


def describe_axis_descriptors(
    value: Any,
    *,
    axis_by_id: Mapping[str, dict[str, Any]] | None = None,
) -> list[str]:
    if not isinstance(value, dict):
        return []
    descriptors: list[str] = []
    for axis_id, axis_value in sorted(value.items()):
        if not isinstance(axis_value, (int, float)) or isinstance(axis_value, bool):
            continue
        axis_name = str(axis_id or "").strip()
        if not axis_name:
            continue
        descriptor = describe_axis_descriptor(
            axis_name,
            float(axis_value),
            axis=axis_by_id.get(axis_name) if axis_by_id else None,
        )
        if descriptor and descriptor not in descriptors:
            descriptors.append(descriptor)
    return descriptors


def describe_axis_descriptor(
    axis_id: str,
    value: float,
    *,
    axis: dict[str, Any] | None = None,
) -> str:
    normalized_axis = axis_id.strip().lower()
    if not float("-inf") < value < float("inf"):
        return ""
    delta = resolve_axis_neutral_delta(value, axis)
    threshold = resolve_axis_descriptor_threshold(axis)
    if abs(delta) < threshold:
        return ""

    axis_descriptors = {
        "head_yaw": ("look_left", "look_right"),
        "body_yaw": ("body_turn_left", "body_turn_right"),
        "gaze_yaw": ("gaze_left", "gaze_right"),
        "eye_gaze_x": ("gaze_left", "gaze_right"),
        "head_pitch": ("look_down", "look_up"),
        "body_pitch": ("lean_forward", "lean_back"),
        "gaze_pitch": ("gaze_down", "gaze_up"),
        "eye_gaze_y": ("gaze_down", "gaze_up"),
        "head_roll": ("tilt_left", "tilt_right"),
        "body_roll": ("body_lean_left", "body_lean_right"),
        "eye_open_left": ("left_eye_narrow", "left_eye_open"),
        "eye_open_right": ("right_eye_narrow", "right_eye_open"),
        "eye_smile_left": ("left_eye_relaxed", "left_eye_smile"),
        "eye_smile_right": ("right_eye_relaxed", "right_eye_smile"),
        "mouth_smile": ("mouth_frown", "mouth_smile"),
        "brow_bias": ("brow_down", "brow_raise"),
        "mouth_open": ("mouth_closed", "mouth_open"),
    }
    negative, positive = axis_descriptors.get(
        normalized_axis,
        (f"{normalized_axis}_low", f"{normalized_axis}_high"),
    )
    return positive if delta > 0 else negative


def build_prompt_axis_lookup(
    semantic_profile: dict[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    if not isinstance(semantic_profile, dict):
        return {}
    return build_prompt_axis_lookup_from_axes(profile_prompt_axes(semantic_profile))


def build_prompt_axis_lookup_from_axes(
    prompt_axes: list[dict[str, Any]] | None,
) -> dict[str, dict[str, Any]]:
    if not isinstance(prompt_axes, list):
        return {}
    return {
        str(axis.get("id") or "").strip(): axis
        for axis in prompt_axes
        if isinstance(axis, dict) and str(axis.get("id") or "").strip()
    }


def resolve_axis_soft_range(axis: dict[str, Any] | None) -> tuple[float, float] | None:
    if not isinstance(axis, dict):
        return None
    soft_range = axis.get("soft_range")
    if (
        isinstance(soft_range, (list, tuple))
        and len(soft_range) >= 2
        and isinstance(soft_range[0], (int, float))
        and isinstance(soft_range[1], (int, float))
    ):
        return float(soft_range[0]), float(soft_range[1])
    return None


def resolve_axis_neutral_delta(value: float, axis: dict[str, Any] | None) -> float:
    neutral = resolve_axis_neutral_value(axis or {})
    return float(value) - neutral


def resolve_axis_descriptor_threshold(axis: dict[str, Any] | None) -> float:
    soft_range = resolve_axis_soft_range(axis)
    if soft_range is not None:
        soft_min, soft_max = soft_range
        neutral = resolve_axis_neutral_value(axis or {})
        soft_delta = max(abs(soft_max - neutral), abs(neutral - soft_min))
        if soft_delta > 0:
            return max(soft_delta * 0.6, 2.0)
    return 6.0


def resolve_axis_neutral_value(axis: dict[str, Any]) -> float:
    neutral = axis.get("neutral")
    if isinstance(neutral, (int, float)):
        min_value, max_value = resolve_axis_value_range(axis)
        return round(max(min_value, min(max_value, float(neutral))), 4)
    min_value, max_value = resolve_axis_value_range(axis)
    return round((min_value + max_value) / 2.0, 4)
