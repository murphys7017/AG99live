from __future__ import annotations

import math
import re
from typing import Any

from ..prompts.semantic_axis_prompt import profile_prompt_axes
from ..protocol.schema_versions import (
    MOTION_INTENT_V4_SCHEMA_VERSION,
    SEMANTIC_AXIS_PROFILE_SCHEMA_VERSION,
)
from .performance_curve import normalize_performance_curve_hint
from .resource_catalog import ModelInfoRuntimeContext

DEFAULT_MOTION_INTENT_DURATION_MS = 1000


def resolve_selected_semantic_axis_profile(
    *,
    runtime_state: ModelInfoRuntimeContext,
    require_prompt_axes: bool = True,
) -> dict[str, Any]:
    model_info = runtime_state.model_info
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

    intent = _apply_execution_shape_priority(intent)

    profile_id = str(intent.get("profile_id") or "").strip()
    model_id = str(intent.get("model_id") or "").strip()
    if not profile_id:
        raise ValueError("profile_id_empty")
    if not model_id:
        raise ValueError("model_id_empty")
    profile_revision = intent.get("profile_revision")
    if type(profile_revision) is not int or profile_revision <= 0:
        raise ValueError("profile_revision_invalid")
    mode = str(intent.get("mode") or "expressive").strip().lower()
    if mode not in {"expressive", "idle"}:
        raise ValueError("invalid_mode")

    intent_tags = normalize_motion_intent_tags(intent.get("intent_tags"))
    if not intent_tags:
        raise ValueError("intent_tags_empty")
    has_axis_levels = "axis_levels" in intent
    has_axis_values = "axis_values" in intent
    has_motion_steps = "motion_steps" in intent
    has_motion_resource = "motion_resource_id" in intent
    if has_axis_levels:
        raise ValueError("axis_levels_removed_use_motion_steps_axis_values")
    if has_axis_values:
        raise ValueError("axis_values_root_removed_use_motion_steps")
    execution_shape_count = sum((has_motion_steps, has_motion_resource))
    if execution_shape_count == 0:
        raise ValueError("motion_execution_shape_missing")
    if execution_shape_count > 1:
        raise ValueError("motion_execution_shape_conflict")
    normalized_steps = (
        _normalize_motion_steps(intent.get("motion_steps"))
        if has_motion_steps
        else None
    )
    if "axes" in intent:
        raise ValueError("axes_motion_steps_mutually_exclusive")
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
    sequence_axis_ids = {
        axis_id
        for step in normalized_steps or []
        for axis_id in step["axis_values"]
    }
    normalized_intent = {
        "schema_version": MOTION_INTENT_V4_SCHEMA_VERSION,
        "profile_id": profile_id,
        "profile_revision": profile_revision,
        "model_id": model_id,
        "mode": mode,
        "intent_tags": intent_tags,
        "emotion_label": derive_motion_emotion_label(intent_tags),
        "summary": {
            "axis_count": len(
                sequence_axis_ids
            ),
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
    if normalized_steps:
        normalized_intent["motion_steps"] = normalized_steps
    if performance_curve_hint is not None:
        normalized_intent["performance_curve_hint"] = performance_curve_hint
    return normalized_intent


def _apply_execution_shape_priority(intent: dict[str, Any]) -> dict[str, Any]:
    """Keep the highest-priority executable shape from a mixed model output."""
    motion_resource_id = normalize_motion_resource_id(intent.get("motion_resource_id"))
    if motion_resource_id:
        prioritized = dict(intent)
        prioritized.pop("motion_steps", None)
        prioritized.pop("duration_hint_ms", None)
        prioritized.pop("performance_curve_hint", None)
        prioritized.pop("expression_resource_id", None)
        return prioritized

    if "motion_steps" in intent:
        prioritized = dict(intent)
        prioritized.pop("expression_resource_id", None)
        return prioritized

    return dict(intent)


def _normalize_axis_values(value: Any) -> dict[str, float]:
    normalized_values, rejected_values = normalize_motion_axis_values(value)
    if rejected_values:
        raise ValueError("rejected_axis_values:" + ",".join(rejected_values))
    if not normalized_values:
        raise ValueError("axis_values_not_object")
    return normalized_values


def normalize_motion_axis_values(
    value: Any,
) -> tuple[dict[str, float] | None, list[str]]:
    """Normalize a continuous semantic axis value map.

    Values are expressed in the semantic axis unit space, so this layer only
    proves the payload is a finite numeric map. Range enforcement needs the
    axis profile and happens in payload validation.
    """
    if not isinstance(value, dict) or not value:
        return None, []
    normalized_values: dict[str, float] = {}
    rejected_values: list[str] = []
    for axis_id_raw, raw_value in value.items():
        # Missing/null means this axis was not requested, never a neutral pose.
        if raw_value is None:
            continue
        axis_id = str(axis_id_raw or "").strip()
        if not axis_id:
            rejected_values.append("empty_axis_id")
            continue
        if axis_id in normalized_values:
            rejected_values.append(f"duplicate_axis_id:{axis_id}")
            continue
        if isinstance(raw_value, bool) or not isinstance(raw_value, (int, float)):
            rejected_values.append(axis_id)
            continue
        number = float(raw_value)
        if not math.isfinite(number):
            rejected_values.append(axis_id)
            continue
        normalized_values[axis_id] = number
    if not normalized_values:
        return None, rejected_values
    return normalized_values, rejected_values


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
    if not isinstance(value, list) or len(value) < 1 or len(value) > 4:
        return None, "motion_steps_count_invalid"
    normalized_steps: list[dict[str, Any]] = []
    for index, step in enumerate(value):
        if not isinstance(step, dict):
            return None, f"motion_step_not_object:{index}"
        unknown_fields = sorted(set(step) - {"axis_values", "duration_weight"})
        if unknown_fields:
            return (
                None,
                f"motion_step_forbidden_fields:{index}:{','.join(unknown_fields)}",
            )
        values, rejected = normalize_motion_axis_values(step.get("axis_values"))
        if rejected:
            return (
                None,
                f"motion_step_rejected_axis_values:{index}:{','.join(rejected)}",
            )
        if not values:
            return None, f"motion_step_axis_values_empty:{index}"
        duration_weight = step.get("duration_weight")
        # Duration weights saturate at the documented range. Fractional
        # in-range values remain invalid; do not invent a rounding policy.
        if isinstance(duration_weight, int) and not isinstance(duration_weight, bool):
            duration_weight = min(3, max(1, duration_weight))
        elif isinstance(duration_weight, float | str):
            try:
                number = float(duration_weight)
            except (ValueError, OverflowError):
                number = math.nan
            if math.isfinite(number):
                bounded = min(3.0, max(1.0, number))
                if bounded.is_integer():
                    duration_weight = int(bounded)
        if (
            isinstance(duration_weight, bool)
            or not isinstance(duration_weight, int)
            or duration_weight < 1
            or duration_weight > 3
        ):
            return None, f"motion_step_duration_weight_invalid:{index}"
        normalized_steps.append(
            {
                "axis_values": values,
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
