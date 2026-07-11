from __future__ import annotations

import re
from typing import Any

from ..prompts.semantic_axis_prompt import profile_prompt_axes
from .performance_curve import normalize_performance_curve_hint

MOTION_INTENT_SCHEMA_VERSION = "engine.motion_intent.v3"
MOTION_INTENT_V3_SCHEMA_VERSION = "engine.motion_intent.v3"
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
    raise ValueError("invalid_schema_version")


def normalize_motion_intent_v3_payload(intent: Any) -> dict[str, Any]:
    if not isinstance(intent, dict):
        raise ValueError("intent_not_object")

    schema_version = str(intent.get("schema_version") or "").strip()
    if schema_version != MOTION_INTENT_V3_SCHEMA_VERSION:
        raise ValueError("invalid_schema_version")

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
        except ValueError:
            performance_curve_hint = None

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
        "fallback_pose_id": "",
        "axes": normalized_axes,
        "summary": {
            "axis_count": len(normalized_axes),
            "intent_tag_count": len(intent_tags),
        },
    }
    if performance_curve_hint is not None:
        normalized_intent["performance_curve_hint"] = performance_curve_hint
    return normalized_intent


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


def derive_motion_emotion_label(intent_tags: Any, *, fallback: str = "motion") -> str:
    tags = normalize_motion_intent_tags(intent_tags)
    if tags:
        return "-".join(tags)
    fallback_value = str(fallback or "").strip()
    return fallback_value or "motion"


def _normalize_duration_hint_ms(value: Any) -> int:
    if value is None:
        return DEFAULT_MOTION_INTENT_DURATION_MS
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        try:
            number = float(value)
        except (TypeError, ValueError):
            return DEFAULT_MOTION_INTENT_DURATION_MS
    else:
        number = float(value)
    if not float("-inf") < number < float("inf"):
        return DEFAULT_MOTION_INTENT_DURATION_MS
    duration_hint_ms = int(round(number))
    clamped = max(320, min(15000, duration_hint_ms))
    return clamped


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
        for key in ("target_value", "weight"):
            value = item.get(key)
            if not isinstance(value, (int, float)):
                return False, f"parameter_{key}_not_number"
            if not float("-inf") < float(value) < float("inf"):
                return False, f"parameter_{key}_not_finite"
        weight = float(item.get("weight"))
        if weight < 0.0 or weight > 1.0:
            return False, "parameter_weight_out_of_range"
        source = item.get("source")
        if source is not None and source not in PARAMETER_PLAN_SOURCES:
            return False, f"parameter_source_invalid:{source}"

    return True, ""
