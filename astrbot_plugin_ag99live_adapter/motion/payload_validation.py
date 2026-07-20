from __future__ import annotations

from collections.abc import Mapping
import re
from typing import Any

from .motion_intent import (
    MOTION_INTENT_V4_SCHEMA_VERSION,
    normalize_motion_intent_v4_payload,
    normalize_motion_resource_id,
    resolve_selected_semantic_axis_profile,
)
from .resource_catalog import (
    build_motion_resource_candidates,
    validate_motion_resource_id,
)
from ..prompts.semantic_axis_prompt import (
    profile_prompt_axes,
    resolve_available_axis_levels,
)


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

    has_axis_levels = "axis_levels" in motion_hint
    has_motion_steps = "motion_steps" in motion_hint
    contract_payload = {
        "schema_version": MOTION_INTENT_V4_SCHEMA_VERSION,
        "profile_id": semantic_profile.get("profile_id"),
        "profile_revision": semantic_profile.get("revision"),
        "model_id": semantic_profile.get("model_id"),
        "mode": "expressive",
        "intent_tags": motion_hint.get("intent_tags"),
        "duration_hint_ms": motion_hint.get("duration_hint_ms"),
        "expression_resource_id": motion_hint.get("expression_resource_id"),
        "motion_resource_id": motion_hint.get("motion_resource_id"),
    }
    if has_axis_levels:
        contract_payload["axis_levels"] = motion_hint.get("axis_levels")
    if has_motion_steps:
        contract_payload["motion_steps"] = motion_hint.get("motion_steps")
    try:
        payload = normalize_motion_intent_v4_payload(contract_payload)
    except ValueError as exc:
        return None, append_resolution_reason(base_reason, str(exc))

    return validate_normalized_motion_intent_payload(
        payload,
        runtime_state,
        base_reason=base_reason,
        append_resolution_reason=append_resolution_reason,
        sanitize_reason_fragment=sanitize_reason_fragment,
        semantic_profile=semantic_profile,
    )


def validate_normalized_motion_intent_payload(
    payload: dict[str, Any],
    runtime_state: Any,
    *,
    base_reason: str,
    append_resolution_reason=None,
    sanitize_reason_fragment=None,
    semantic_profile: dict[str, Any] | None = None,
) -> tuple[dict[str, Any] | None, str]:
    append_resolution_reason = append_resolution_reason or _append_resolution_reason
    sanitize_reason_fragment = sanitize_reason_fragment or _sanitize_reason_fragment
    if semantic_profile is None:
        try:
            semantic_profile = resolve_selected_semantic_axis_profile(
                runtime_state=runtime_state
            )
        except Exception as exc:  # noqa: BLE001
            return None, f"semantic_profile_unresolved:{exc}"

    expected_identity = (
        str(semantic_profile.get("profile_id") or "").strip(),
        semantic_profile.get("revision"),
        str(semantic_profile.get("model_id") or "").strip(),
    )
    payload_identity = (
        str(payload.get("profile_id") or "").strip(),
        payload.get("profile_revision"),
        str(payload.get("model_id") or "").strip(),
    )
    if payload_identity != expected_identity:
        return None, append_resolution_reason(
            base_reason,
            "semantic_profile_identity_mismatch",
        )

    intent_tags = payload["intent_tags"]
    if len(intent_tags) > 6 or any(len(tag) > 48 for tag in intent_tags):
        return None, append_resolution_reason(base_reason, "intent_tags_invalid")
    requested_expression_resource_id = payload["expression_resource_id"]
    requested_motion_resource_id = payload["motion_resource_id"]
    validated_levels = payload.get("axis_levels")
    motion_steps = payload.get("motion_steps")
    reason = base_reason
    prompt_axes = profile_prompt_axes(semantic_profile)
    axis_by_id = {
        str(axis.get("id") or "").strip(): axis
        for axis in prompt_axes
        if str(axis.get("id") or "").strip()
    }
    allowed_axis_ids = set(axis_by_id)
    used_axis_ids = set(validated_levels or {})
    if motion_steps:
        used_axis_ids.update(motion_steps[0]["axis_levels"])
    unknown_axis_ids = sorted(used_axis_ids - allowed_axis_ids)
    if unknown_axis_ids:
        return None, append_resolution_reason(
            reason,
            "unknown_axis_levels:" + ",".join(unknown_axis_ids),
        )
    unavailable_levels = find_unavailable_axis_levels(
        validated_levels=validated_levels,
        motion_steps=motion_steps,
        axis_by_id=axis_by_id,
    )
    if unavailable_levels:
        return None, append_resolution_reason(
            reason,
            "unavailable_axis_levels:" + ",".join(unavailable_levels),
        )
    if len(used_axis_ids) > 6:
        return None, append_resolution_reason(reason, "axis_level_count_exceeded")
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

    payload["expression_resource_id"] = expression_resource_id
    payload["motion_resource_id"] = motion_resource_id
    return payload, reason


def _append_resolution_reason(base: str | None, suffix: str) -> str:
    normalized_base = str(base or "").strip()
    normalized_suffix = str(suffix or "").strip()
    if not normalized_base or normalized_base == "ok":
        return normalized_suffix or "ok"
    if not normalized_suffix or normalized_suffix == "ok":
        return normalized_base
    return f"{normalized_base}:{normalized_suffix}"


def _sanitize_reason_fragment(value: Any) -> str:
    fragment = re.sub(r"[^0-9A-Za-z_.:-]+", "_", str(value or "").strip())
    return fragment[:80] or "unknown"


def find_unavailable_axis_levels(
    *,
    validated_levels: dict[str, int] | None,
    motion_steps: list[dict[str, Any]] | None,
    axis_by_id: dict[str, dict[str, Any]],
) -> list[str]:
    level_maps = [validated_levels] if validated_levels is not None else []
    if motion_steps:
        level_maps.extend(step["axis_levels"] for step in motion_steps)
    unavailable: set[str] = set()
    for level_map in level_maps:
        for axis_id, level in level_map.items():
            axis = axis_by_id.get(axis_id)
            if axis is None:
                continue
            if level not in resolve_available_axis_levels(axis):
                unavailable.add(f"{axis_id}:{level}")
    return sorted(unavailable)


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
