from __future__ import annotations

import re
from typing import Any

from ..prompts.semantic_axis_prompt import profile_prompt_axes
from .performance_curve import normalize_performance_curve_hint

from ..protocol.schema_versions import (
    MOTION_INTENT_V4_SCHEMA_VERSION,
    SEMANTIC_AXIS_PROFILE_SCHEMA_VERSION,
)

MOTION_INTENT_SCHEMA_VERSION = MOTION_INTENT_V4_SCHEMA_VERSION
DEFAULT_MOTION_INTENT_DURATION_MS = 1000


def resolve_selected_semantic_axis_profile(
    *,
    runtime_state: Any,
    require_prompt_axes: bool = True,
) -> dict[str, Any]:
    model_info = getattr(runtime_state, "model_info", {})
    if not isinstance(model_info, dict):
        raise RuntimeError("SemanticAxisProfile unavailable: runtime_state.model_info is not an object.")

    selected_model_name = str(model_info.get("selected_model") or "").strip()
    models = model_info.get("models")
    if not selected_model_name or not isinstance(models, list):
        raise RuntimeError("SemanticAxisProfile unavailable: selected model is not synchronized.")

    for model in models:
        if not isinstance(model, dict):
            continue
        if str(model.get("name") or "").strip() != selected_model_name:
            continue
        profile = model.get("semantic_axis_profile")
        if not isinstance(profile, dict):
            raise RuntimeError(
                f"SemanticAxisProfile unavailable for selected model `{selected_model_name}`."
            )
        schema_version = str(profile.get("schema_version") or "").strip()
        profile_id = str(profile.get("profile_id") or "").strip()
        model_id = str(profile.get("model_id") or "").strip()
        status = str(profile.get("status") or "").strip()
        revision = profile.get("revision")
        if schema_version != SEMANTIC_AXIS_PROFILE_SCHEMA_VERSION:
            raise RuntimeError("SemanticAxisProfile invalid: unsupported schema_version.")
        if not profile_id or not model_id:
            raise RuntimeError("SemanticAxisProfile invalid: profile_id/model_id is empty.")
        if not isinstance(revision, int) or revision <= 0:
            raise RuntimeError("SemanticAxisProfile invalid: revision must be a positive integer.")
        if status == "stale":
            raise RuntimeError("SemanticAxisProfile is stale; rescan or save the profile before motion generation.")
        if require_prompt_axes:
            profile_prompt_axes(profile)
        return profile

    raise RuntimeError(
        f"SemanticAxisProfile unavailable: selected model `{selected_model_name}` is missing."
    )


def normalize_motion_intent_payload(intent: Any) -> dict[str, Any]:
    if not isinstance(intent, dict):
        raise ValueError("intent_not_object")

    schema_version = str(intent.get("schema_version") or "").strip()
    if schema_version == MOTION_INTENT_V4_SCHEMA_VERSION:
        return normalize_motion_intent_v4_payload(intent)
    raise ValueError("invalid_schema_version")


def normalize_motion_intent_v4_payload(intent: Any) -> dict[str, Any]:
    if not isinstance(intent, dict):
        raise ValueError("intent_not_object")
    if str(intent.get("schema_version") or "").strip() != MOTION_INTENT_V4_SCHEMA_VERSION:
        raise ValueError("invalid_schema_version")

    profile_id = str(intent.get("profile_id") or "").strip()
    model_id = str(intent.get("model_id") or "").strip()
    if not profile_id:
        raise ValueError("profile_id_empty")
    if not model_id:
        raise ValueError("model_id_empty")
    profile_revision = intent.get("profile_revision")
    if not isinstance(profile_revision, int) or profile_revision <= 0:
        raise ValueError("profile_revision_invalid")
    mode = str(intent.get("mode") or "expressive").strip().lower()
    if mode not in {"expressive", "idle"}:
        raise ValueError("invalid_mode")

    intent_tags = normalize_motion_intent_tags(intent.get("intent_tags"))
    if not intent_tags:
        raise ValueError("intent_tags_empty")
    has_axis_levels = "axis_levels" in intent
    has_motion_steps = "motion_steps" in intent
    has_motion_resource = "motion_resource_id" in intent
    if sum((has_axis_levels, has_motion_steps, has_motion_resource)) != 1:
        raise ValueError("motion_execution_shape_invalid")
    normalized_levels = (
        _normalize_axis_levels(intent.get("axis_levels"))
        if has_axis_levels
        else None
    )
    normalized_steps = (
        _normalize_motion_steps(intent.get("motion_steps"))
        if has_motion_steps
        else None
    )
    if "axes" in intent:
        raise ValueError("axis_levels_axes_mutually_exclusive")
    if "resource_id" in intent:
        raise ValueError("resource_id_forbidden_use_typed_resource_fields")

    expression_resource_id = normalize_motion_resource_id(
        intent.get("expression_resource_id")
    )
    motion_resource_id = normalize_motion_resource_id(intent.get("motion_resource_id"))
    if has_motion_resource and not motion_resource_id:
        raise ValueError("motion_resource_id_empty")
    if expression_resource_id and motion_resource_id:
        raise ValueError("multiple_resource_layers_forbidden")

    if motion_resource_id and (
        "duration_hint_ms" in intent or "performance_curve_hint" in intent
    ):
        raise ValueError("motion_resource_timing_fields_forbidden")
    duration_hint_ms = (
        None
        if motion_resource_id
        else _normalize_duration_hint_ms(intent.get("duration_hint_ms"))
    )
    performance_curve_hint = None
    if "performance_curve_hint" in intent:
        try:
            performance_curve_hint = normalize_performance_curve_hint(
                intent.get("performance_curve_hint")
            )
        except ValueError as exc:
            raise ValueError(f"performance_curve_hint_invalid:{exc}") from exc
    normalized_intent = {
        "schema_version": MOTION_INTENT_V4_SCHEMA_VERSION,
        "profile_id": profile_id,
        "profile_revision": profile_revision,
        "model_id": model_id,
        "mode": mode,
        "intent_tags": intent_tags,
        "emotion_label": derive_motion_emotion_label(intent_tags),
        "summary": {
            "axis_count": len(normalized_levels or normalized_steps[0]["axis_levels"])
            if normalized_levels or normalized_steps
            else 0,
            "intent_tag_count": len(intent_tags),
            "motion_step_count": len(normalized_steps or []),
        },
    }
    if duration_hint_ms is not None:
        normalized_intent["duration_hint_ms"] = duration_hint_ms
    if expression_resource_id:
        normalized_intent["expression_resource_id"] = expression_resource_id
    if motion_resource_id:
        normalized_intent["motion_resource_id"] = motion_resource_id
    if normalized_levels:
        normalized_intent["axis_levels"] = normalized_levels
    if normalized_steps:
        normalized_intent["motion_steps"] = normalized_steps
    if performance_curve_hint is not None:
        normalized_intent["performance_curve_hint"] = performance_curve_hint
    return normalized_intent


def _normalize_axis_levels(value: Any) -> dict[str, int]:
    normalized_levels, rejected_levels = normalize_motion_axis_levels(value)
    if rejected_levels:
        raise ValueError("rejected_axis_levels:" + ",".join(rejected_levels))
    if not normalized_levels:
        raise ValueError("axis_levels_not_object")
    return normalized_levels


def normalize_motion_axis_levels(
    value: Any,
) -> tuple[dict[str, int] | None, list[str]]:
    if not isinstance(value, dict) or not value:
        return None, []
    normalized_levels: dict[str, int] = {}
    rejected_levels: list[str] = []
    for axis_id_raw, level in value.items():
        axis_id = str(axis_id_raw or "").strip()
        if not axis_id:
            rejected_levels.append("empty_axis_id")
            continue
        if axis_id in normalized_levels:
            rejected_levels.append(f"duplicate_axis_id:{axis_id}")
            continue
        if isinstance(level, bool) or not isinstance(level, int) or level < -4 or level > 4:
            rejected_levels.append(axis_id)
            continue
        normalized_levels[axis_id] = level
    if not normalized_levels:
        return None, rejected_levels
    return normalized_levels, rejected_levels


def _normalize_motion_steps(value: Any) -> list[dict[str, Any]]:
    normalized_steps, error = normalize_motion_steps(value)
    if error:
        raise ValueError(error)
    if normalized_steps is None:
        raise ValueError("motion_steps_count_invalid")
    return normalized_steps


def normalize_motion_steps(
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
            return (
                None,
                f"motion_step_forbidden_fields:{index}:{','.join(unknown_fields)}",
            )
        levels, rejected = normalize_motion_axis_levels(step.get("axis_levels"))
        if rejected:
            return (
                None,
                f"motion_step_rejected_axis_levels:{index}:{','.join(rejected)}",
            )
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


def normalize_motion_intent_tags(value: Any) -> list[str]:
    if value is None:
        return []
    raw_items: list[Any]
    if isinstance(value, (list, tuple)):
        raw_items = list(value)
    elif isinstance(value, set):
        raw_items = list(value)
    else:
        raw_items = [value]

    normalized: list[str] = []
    seen: set[str] = set()
    for raw_item in raw_items:
        if isinstance(raw_item, str):
            pieces = [
                part.strip()
                for part in re.split(r"[-,，、/|]+", raw_item)
            ]
        else:
            pieces = [str(raw_item).strip()]
        for piece in pieces:
            tag = str(piece or "").strip()
            if not tag or tag in seen:
                continue
            seen.add(tag)
            normalized.append(tag)
    return normalized


def normalize_motion_resource_id(value: Any) -> str:
    return str(value or "").strip()


def derive_motion_emotion_label(intent_tags: Any) -> str:
    tags = normalize_motion_intent_tags(intent_tags)
    if not tags:
        raise ValueError("intent_tags_empty")
    return "-".join(tags)


def _normalize_duration_hint_ms(value: Any) -> int:
    if value is None:
        return DEFAULT_MOTION_INTENT_DURATION_MS
    if isinstance(value, bool):
        raise ValueError("duration_hint_ms_not_number")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError("duration_hint_ms_not_number") from None
    if not float("-inf") < number < float("inf"):
        raise ValueError("duration_hint_ms_not_finite")
    duration_hint_ms = int(round(number))
    if duration_hint_ms < 320 or duration_hint_ms > 15000:
        raise ValueError("duration_hint_ms_out_of_range")
    return duration_hint_ms


def _coerce_finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    if not float("-inf") < number < float("inf"):
        return None
    return number


def validate_motion_intent_payload(intent: Any) -> tuple[bool, str]:
    try:
        normalize_motion_intent_payload(intent)
    except ValueError as exc:
        return False, str(exc)
    return True, ""
