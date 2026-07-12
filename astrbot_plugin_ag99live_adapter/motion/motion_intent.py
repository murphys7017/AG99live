from __future__ import annotations

import re
from typing import Any

from ..prompts.semantic_axis_prompt import profile_prompt_axes
from .performance_curve import normalize_performance_curve_hint

MOTION_INTENT_SCHEMA_VERSION = "engine.motion_intent.v3"
MOTION_INTENT_V3_SCHEMA_VERSION = "engine.motion_intent.v3"
MOTION_INTENT_V4_SCHEMA_VERSION = "engine.motion_intent.v4"
PARAMETER_PLAN_V2_SCHEMA_VERSION = "engine.parameter_plan.v2"
DEFAULT_MOTION_INTENT_DURATION_MS = 1000
PARAMETER_PLAN_SOURCES = {
    "semantic_axis",
    "coupling",
    "speech_pose",
    "expression",
    "continuity",
    "manual",
}

def resolve_selected_semantic_axis_profile(*, runtime_state: Any) -> dict[str, Any]:
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
        if schema_version != "ag99.semantic_axis_profile.v1":
            raise RuntimeError("SemanticAxisProfile invalid: unsupported schema_version.")
        if not profile_id or not model_id:
            raise RuntimeError("SemanticAxisProfile invalid: profile_id/model_id is empty.")
        if not isinstance(revision, int) or revision <= 0:
            raise RuntimeError("SemanticAxisProfile invalid: revision must be a positive integer.")
        if status == "stale":
            raise RuntimeError("SemanticAxisProfile is stale; rescan or save the profile before motion generation.")
        profile_prompt_axes(profile)
        return profile

    raise RuntimeError(
        f"SemanticAxisProfile unavailable: selected model `{selected_model_name}` is missing."
    )


def normalize_motion_intent_payload(intent: Any) -> dict[str, Any]:
    if not isinstance(intent, dict):
        raise ValueError("intent_not_object")

    schema_version = str(intent.get("schema_version") or "").strip()
    if schema_version == MOTION_INTENT_V3_SCHEMA_VERSION:
        return normalize_motion_intent_v3_payload(intent)
    if schema_version == MOTION_INTENT_V4_SCHEMA_VERSION:
        return normalize_motion_intent_v4_payload(intent)
    raise ValueError("invalid_schema_version")


def normalize_motion_intent_v3_payload(intent: Any) -> dict[str, Any]:
    if not isinstance(intent, dict):
        raise ValueError("intent_not_object")

    schema_version = str(intent.get("schema_version") or "").strip()
    if schema_version != MOTION_INTENT_V3_SCHEMA_VERSION:
        raise ValueError("invalid_schema_version")
    if "axis_levels" in intent:
        raise ValueError("axis_levels_forbidden_for_v3")
    if "motion_steps" in intent:
        raise ValueError("motion_steps_forbidden_for_v3")

    profile_id = str(intent.get("profile_id") or "").strip()
    model_id = str(intent.get("model_id") or "").strip()
    if not profile_id:
        raise ValueError("profile_id_empty")
    if not model_id:
        raise ValueError("model_id_empty")
    profile_revision_raw = intent.get("profile_revision")
    if not isinstance(profile_revision_raw, int) or profile_revision_raw <= 0:
        raise ValueError("profile_revision_invalid")

    mode = str(intent.get("mode") or "expressive").strip().lower()
    if mode not in {"expressive", "idle"}:
        raise ValueError("invalid_mode")

    intent_tags = normalize_motion_intent_tags(intent.get("intent_tags"))
    if not intent_tags:
        raise ValueError("intent_tags_empty")
    emotion_label = derive_motion_emotion_label(intent_tags)
    resource_id = normalize_motion_resource_id(intent.get("resource_id"))

    axes = intent.get("axes")
    if not isinstance(axes, dict) or not axes:
        raise ValueError("axes_not_object")

    normalized_axes: dict[str, float] = {}
    for axis_id_raw, axis_value in axes.items():
        axis_id = str(axis_id_raw or "").strip()
        if not axis_id:
            raise ValueError("axis_id_empty")
        if axis_id in normalized_axes:
            raise ValueError(f"axis_id_duplicate:{axis_id}")
        if isinstance(axis_value, dict):
            raise ValueError(f"axis_payload_invalid:{axis_id}")
        value = _coerce_finite_number(axis_value)
        if value is None:
            raise ValueError(f"axis_{axis_id}_value_not_number")
        normalized_axes[axis_id] = round(value, 4)

    duration_hint_ms = _normalize_duration_hint_ms(intent.get("duration_hint_ms"))
    performance_curve_hint = None
    if "performance_curve_hint" in intent:
        try:
            performance_curve_hint = normalize_performance_curve_hint(
                intent.get("performance_curve_hint")
            )
        except ValueError as exc:
            raise ValueError(f"performance_curve_hint_invalid:{exc}") from exc

    normalized_intent = {
        "schema_version": MOTION_INTENT_V3_SCHEMA_VERSION,
        "profile_id": profile_id,
        "profile_revision": profile_revision_raw,
        "model_id": model_id,
        "mode": mode,
        "intent_tags": intent_tags,
        "emotion_label": emotion_label,
        "duration_hint_ms": duration_hint_ms,
        "resource_id": resource_id,
        "axes": normalized_axes,
        "summary": {
            "axis_count": len(normalized_axes),
            "intent_tag_count": len(intent_tags),
        },
    }
    if performance_curve_hint is not None:
        normalized_intent["performance_curve_hint"] = performance_curve_hint
    return normalized_intent


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
    if has_axis_levels == has_motion_steps:
        raise ValueError("axis_levels_motion_steps_exclusive")
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
    if expression_resource_id and motion_resource_id:
        raise ValueError("multiple_resource_layers_forbidden")
    if normalized_steps and motion_resource_id:
        raise ValueError("motion_steps_motion_resource_mutually_exclusive")

    duration_hint_ms = _normalize_duration_hint_ms(intent.get("duration_hint_ms"))
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
        "duration_hint_ms": duration_hint_ms,
        "expression_resource_id": expression_resource_id,
        "motion_resource_id": motion_resource_id,
        "summary": {
            "axis_count": len(
                normalized_levels or normalized_steps[0]["axis_levels"]
            ),
            "intent_tag_count": len(intent_tags),
            "motion_step_count": len(normalized_steps or []),
        },
    }
    if normalized_levels:
        normalized_intent["axis_levels"] = normalized_levels
    if normalized_steps:
        normalized_intent["motion_steps"] = normalized_steps
    if performance_curve_hint is not None:
        normalized_intent["performance_curve_hint"] = performance_curve_hint
    return normalized_intent


def _normalize_axis_levels(value: Any) -> dict[str, int]:
    if not isinstance(value, dict) or not value:
        raise ValueError("axis_levels_not_object")
    normalized_levels: dict[str, int] = {}
    for axis_id_raw, level in value.items():
        axis_id = str(axis_id_raw or "").strip()
        if not axis_id:
            raise ValueError("axis_id_empty")
        if axis_id in normalized_levels:
            raise ValueError(f"axis_id_duplicate:{axis_id}")
        if isinstance(level, bool) or not isinstance(level, int) or level < -4 or level > 4:
            raise ValueError(f"axis_{axis_id}_level_invalid")
        normalized_levels[axis_id] = level
    return normalized_levels


def _normalize_motion_steps(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) < 2 or len(value) > 4:
        raise ValueError("motion_steps_count_invalid")
    normalized_steps: list[dict[str, Any]] = []
    expected_axis_ids: set[str] | None = None
    for index, step in enumerate(value):
        if not isinstance(step, dict):
            raise ValueError(f"motion_step_not_object:{index}")
        if set(step) - {"axis_levels", "duration_weight"}:
            raise ValueError(f"motion_step_forbidden_fields:{index}")
        levels = _normalize_axis_levels(step.get("axis_levels"))
        axis_ids = set(levels)
        if expected_axis_ids is None:
            expected_axis_ids = axis_ids
        elif axis_ids != expected_axis_ids:
            raise ValueError(f"motion_step_axis_set_mismatch:{index}")
        duration_weight = step.get("duration_weight")
        if (
            isinstance(duration_weight, bool)
            or not isinstance(duration_weight, int)
            or duration_weight < 1
            or duration_weight > 3
        ):
            raise ValueError(f"motion_step_duration_weight_invalid:{index}")
        normalized_steps.append(
            {
                "axis_levels": levels,
                "duration_weight": duration_weight,
            }
        )
    return normalized_steps


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


def validate_parameter_plan_payload(plan: Any) -> tuple[bool, str]:
    return validate_parameter_plan_v2_payload(plan)


def validate_parameter_plan_v2_payload(plan: Any) -> tuple[bool, str]:
    if not isinstance(plan, dict):
        return False, "plan_not_object"

    schema_version = str(plan.get("schema_version") or "").strip()
    if schema_version != PARAMETER_PLAN_V2_SCHEMA_VERSION:
        return False, "invalid_schema_version"

    mode = str(plan.get("mode") or "").strip().lower()
    if mode not in {"expressive", "idle"}:
        return False, "invalid_mode"

    for key in ("profile_id", "model_id", "emotion_label"):
        value = str(plan.get(key) or "").strip()
        if not value:
            return False, f"{key}_empty"
    profile_revision = plan.get("profile_revision")
    if not isinstance(profile_revision, int) or profile_revision <= 0:
        return False, "profile_revision_invalid"

    timing = plan.get("timing")
    if not isinstance(timing, dict):
        return False, "timing_not_object"
    for key in ("duration_ms", "blend_in_ms", "hold_ms", "blend_out_ms"):
        value = timing.get(key)
        if not isinstance(value, (int, float)):
            return False, f"timing_{key}_not_number"
        if float(value) < 0:
            return False, f"timing_{key}_negative"

    parameters = plan.get("parameters")
    if not isinstance(parameters, list) or not parameters:
        return False, "parameters_not_list"
    seen_parameter_ids: set[str] = set()
    for item in parameters:
        if not isinstance(item, dict):
            return False, "parameter_item_not_object"
        axis_id = str(item.get("axis_id") or "").strip()
        parameter_id = str(item.get("parameter_id") or "").strip()
        if not axis_id:
            return False, "parameter_axis_id_empty"
        if not parameter_id:
            return False, "parameter_id_empty"
        if parameter_id in seen_parameter_ids:
            return False, f"duplicate_parameter_id:{parameter_id}"
        seen_parameter_ids.add(parameter_id)
        for key in ("target_value", "neutral_target_value", "weight"):
            value = item.get(key)
            if not isinstance(value, (int, float)):
                return False, f"parameter_{key}_not_number"
            if not float("-inf") < float(value) < float("inf"):
                return False, f"parameter_{key}_not_finite"
        weight = float(item.get("weight"))
        if weight < 0.0 or weight > 1.0:
            return False, "parameter_weight_out_of_range"
        source = item.get("source")
        if source not in PARAMETER_PLAN_SOURCES:
            return False, f"parameter_source_invalid:{source}"
        dynamics = item.get("dynamics")
        if not isinstance(dynamics, dict):
            return False, "parameter_dynamics_not_object"
        for key in (
            "max_velocity",
            "max_acceleration",
            "life_motion_scale",
            "max_speech_offset",
        ):
            value = dynamics.get(key)
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                return False, f"parameter_dynamics_{key}_not_number"
            if not float("-inf") < float(value) < float("inf"):
                return False, f"parameter_dynamics_{key}_not_finite"
        if float(dynamics["max_velocity"]) <= 0:
            return False, "parameter_dynamics_max_velocity_invalid"
        if float(dynamics["max_acceleration"]) <= 0:
            return False, "parameter_dynamics_max_acceleration_invalid"
        if not 0 <= float(dynamics["life_motion_scale"]) <= 1:
            return False, "parameter_dynamics_life_motion_scale_invalid"
        if float(dynamics["max_speech_offset"]) < 0:
            return False, "parameter_dynamics_max_speech_offset_invalid"

    return True, ""
