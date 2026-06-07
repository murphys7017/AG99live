from __future__ import annotations

import re
from typing import Any

from ..prompts.semantic_axis_prompt import profile_prompt_axes

DEFAULT_FALLBACK_POSE_ID = "neutral"


def build_fallback_pose_candidates(
    *,
    runtime_state: Any,
    semantic_profile: dict[str, Any],
    limit: int | None = 12,
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for candidate in _build_user_tuning_candidates(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
    ):
        _append_unique_candidate(candidates, seen_ids, candidate)

    for candidate in _build_expression_candidates(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
    ):
        _append_unique_candidate(candidates, seen_ids, candidate)

    for candidate in _build_profile_binding_expression_candidates(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
    ):
        _append_unique_candidate(candidates, seen_ids, candidate)

    for candidate in _build_neutral_fallback_candidates(semantic_profile):
        _append_unique_candidate(candidates, seen_ids, candidate)

    if limit is not None:
        return candidates[: max(0, int(limit))]
    return candidates


def resolve_fallback_pose_axes(
    *,
    runtime_state: Any,
    semantic_profile: dict[str, Any],
    fallback_pose_id: Any,
) -> dict[str, float] | None:
    normalized_id = _normalize_pose_id(fallback_pose_id)
    if not normalized_id:
        return None
    for candidate in build_fallback_pose_candidates(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
        limit=None,
    ):
        if candidate.get("id") == normalized_id:
            axes = candidate.get("axes")
            return dict(axes) if isinstance(axes, dict) and axes else None
    return None


def build_default_neutral_pose_axes(semantic_profile: dict[str, Any]) -> dict[str, float]:
    axes: dict[str, float] = {}
    for axis in profile_prompt_axes(semantic_profile):
        axis_id = str(axis.get("id") or "").strip()
        if not axis_id:
            continue
        axes[axis_id] = _coerce_axis_value(axis.get("neutral", 50), axis)
    return axes


def _build_user_tuning_candidates(
    *,
    runtime_state: Any,
    semantic_profile: dict[str, Any],
) -> list[dict[str, Any]]:
    list_samples = getattr(runtime_state, "list_motion_tuning_samples", None)
    samples = list_samples() if callable(list_samples) else getattr(runtime_state, "motion_tuning_samples", [])
    if not isinstance(samples, list):
        return []

    profile_id = str(semantic_profile.get("profile_id") or "").strip()
    try:
        profile_revision = int(semantic_profile.get("revision") or 0)
    except (TypeError, ValueError):
        profile_revision = 0
    model_id = str(semantic_profile.get("model_id") or "").strip()
    candidates: list[dict[str, Any]] = []
    for index, sample in enumerate(samples, start=1):
        if not isinstance(sample, dict):
            continue
        if not bool(sample.get("enabled_for_llm_reference")):
            continue
        if profile_id and str(sample.get("profile_id") or "").strip() != profile_id:
            continue
        try:
            sample_revision = int(sample.get("profile_revision") or 0)
        except (TypeError, ValueError):
            sample_revision = 0
        if profile_revision and sample_revision != profile_revision:
            continue
        if model_id and str(sample.get("model_name") or sample.get("model_id") or "").strip() != model_id:
            continue
        axes = _filter_axes(sample.get("adjusted_axes"), semantic_profile)
        if not axes:
            continue
        emotion = str(sample.get("emotion_label") or "manual_tuning").strip() or "manual_tuning"
        sample_id = str(sample.get("id") or index).strip()
        candidate_id = _normalize_pose_id(f"{emotion}_{sample_id}") or f"tuning_{index}"
        candidates.append(
            {
                "id": candidate_id,
                "label": emotion,
                "emotion_label": emotion,
                "source": "motion_tuning_sample",
                "axes": axes,
            }
        )
    return candidates


def _build_expression_candidates(
    *,
    runtime_state: Any,
    semantic_profile: dict[str, Any],
) -> list[dict[str, Any]]:
    model = _resolve_selected_model_payload(runtime_state)
    constraints = model.get("constraints") if isinstance(model, dict) else None
    expressions = constraints.get("expressions") if isinstance(constraints, dict) else None
    if not isinstance(expressions, list):
        return []

    candidates: list[dict[str, Any]] = []
    for expression in expressions:
        if not isinstance(expression, dict):
            continue
        expression_name = str(expression.get("name") or expression.get("file") or "").strip()
        if not expression_name:
            continue
        expression_values = _expression_parameter_values(expression)
        if not expression_values:
            continue
        axes = _map_expression_parameters_to_axes(expression_values, semantic_profile)
        if not axes:
            continue
        candidates.append(
            {
                "id": _normalize_pose_id(expression_name),
                "label": expression_name,
                "emotion_label": _normalize_pose_id(expression_name) or expression_name,
                "source": "expression_parameter_extract",
                "axes": axes,
            }
        )
    return candidates


def _build_profile_binding_expression_candidates(
    *,
    runtime_state: Any,
    semantic_profile: dict[str, Any],
) -> list[dict[str, Any]]:
    model = _resolve_selected_model_payload(runtime_state)
    constraints = model.get("constraints") if isinstance(model, dict) else None
    expressions = constraints.get("expressions") if isinstance(constraints, dict) else None
    if not isinstance(expressions, list):
        return []

    candidates: list[dict[str, Any]] = []
    for expression in expressions:
        if not isinstance(expression, dict):
            continue
        expression_name = str(expression.get("name") or expression.get("file") or "").strip()
        if not expression_name:
            continue
        parameter_ids = _expression_parameter_ids_without_values(expression)
        if not parameter_ids:
            continue
        axes = _map_expression_parameter_ids_to_neutral_axes(
            parameter_ids,
            semantic_profile,
        )
        if not axes:
            continue
        candidates.append(
            {
                "id": _normalize_pose_id(expression_name),
                "label": expression_name,
                "emotion_label": _normalize_pose_id(expression_name) or expression_name,
                "source": "profile_binding_parameter_extract",
                "axes": axes,
            }
        )
    return candidates


def _build_neutral_fallback_candidates(semantic_profile: dict[str, Any]) -> list[dict[str, Any]]:
    neutral_axes = build_default_neutral_pose_axes(semantic_profile)
    if not neutral_axes:
        return []
    return [
        {
            "id": DEFAULT_FALLBACK_POSE_ID,
            "label": "neutral",
            "emotion_label": "neutral",
            "source": "semantic_axis_profile",
            "axes": neutral_axes,
        }
    ]


def _append_unique_candidate(
    candidates: list[dict[str, Any]],
    seen_ids: set[str],
    candidate: dict[str, Any],
) -> None:
    candidate_id = _normalize_pose_id(candidate.get("id"))
    axes = candidate.get("axes")
    if not candidate_id or candidate_id in seen_ids or not isinstance(axes, dict) or not axes:
        return
    candidate["id"] = candidate_id
    seen_ids.add(candidate_id)
    candidates.append(candidate)


def _filter_axes(value: Any, semantic_profile: dict[str, Any]) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    axis_by_id = {
        str(axis.get("id") or "").strip(): axis
        for axis in profile_prompt_axes(semantic_profile)
        if str(axis.get("id") or "").strip()
    }
    result: dict[str, float] = {}
    for raw_axis_id, raw_axis_value in value.items():
        axis_id = str(raw_axis_id or "").strip()
        axis = axis_by_id.get(axis_id)
        if axis is None:
            continue
        number = _coerce_finite_number(raw_axis_value)
        if number is None:
            continue
        result[axis_id] = _coerce_axis_value(number, axis)
    return result


def _map_expression_parameters_to_axes(
    expression_values: dict[str, float],
    semantic_profile: dict[str, Any],
) -> dict[str, float]:
    axes: dict[str, float] = {}
    for axis in profile_prompt_axes(semantic_profile):
        axis_id = str(axis.get("id") or "").strip()
        bindings = axis.get("parameter_bindings")
        if not axis_id or not isinstance(bindings, list):
            continue
        for binding in bindings:
            if not isinstance(binding, dict):
                continue
            parameter_id = str(binding.get("parameter_id") or "").strip()
            if not parameter_id or parameter_id not in expression_values:
                continue
            axes[axis_id] = _map_output_value_to_axis_value(
                expression_values[parameter_id],
                axis=axis,
                binding=binding,
            )
            break
    return axes


def _map_expression_parameter_ids_to_neutral_axes(
    parameter_ids: set[str],
    semantic_profile: dict[str, Any],
) -> dict[str, float]:
    axes: dict[str, float] = {}
    for axis in profile_prompt_axes(semantic_profile):
        axis_id = str(axis.get("id") or "").strip()
        bindings = axis.get("parameter_bindings")
        if not axis_id or not isinstance(bindings, list):
            continue
        for binding in bindings:
            if not isinstance(binding, dict):
                continue
            parameter_id = str(binding.get("parameter_id") or "").strip()
            if not parameter_id or parameter_id not in parameter_ids:
                continue
            axes[axis_id] = _coerce_axis_value(axis.get("neutral", 50), axis)
            break
    return axes


def _map_output_value_to_axis_value(
    output_value: float,
    *,
    axis: dict[str, Any],
    binding: dict[str, Any],
) -> float:
    input_range = _normalize_pair(binding.get("input_range"), [0.0, 100.0])
    output_range = _normalize_pair(binding.get("output_range"), None)
    if output_range is None or output_range[0] == output_range[1]:
        return _coerce_axis_value(axis.get("neutral", 50), axis)

    ratio = (float(output_value) - output_range[0]) / (output_range[1] - output_range[0])
    ratio = max(0.0, min(1.0, ratio))
    if bool(binding.get("invert")):
        ratio = 1.0 - ratio
    value = input_range[0] + ratio * (input_range[1] - input_range[0])
    return _coerce_axis_value(value, axis)


def _expression_parameter_values(expression: dict[str, Any]) -> dict[str, float]:
    values: dict[str, float] = {}
    for key in ("parameters", "dominant_parameters"):
        items = expression.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            parameter_id = str(item.get("id") or item.get("parameter_id") or "").strip()
            value = _coerce_finite_number(item.get("value"))
            if parameter_id and value is not None and parameter_id not in values:
                values[parameter_id] = value
    return values


def _expression_parameter_ids_without_values(expression: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    valued_ids = set(_expression_parameter_values(expression))
    for key in ("dominant_parameters", "parameter_ids"):
        items = expression.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, dict):
                parameter_id = str(item.get("id") or item.get("parameter_id") or "").strip()
                if _coerce_finite_number(item.get("value")) is not None:
                    continue
            else:
                parameter_id = str(item or "").strip()
            if parameter_id and parameter_id not in valued_ids:
                ids.add(parameter_id)
    return ids


def _resolve_selected_model_payload(runtime_state: Any) -> dict[str, Any]:
    model_info = getattr(runtime_state, "model_info", {})
    if not isinstance(model_info, dict):
        return {}
    selected_model = str(model_info.get("selected_model") or "").strip()
    models = model_info.get("models")
    if not selected_model or not isinstance(models, list):
        return {}
    for model in models:
        if isinstance(model, dict) and str(model.get("name") or "").strip() == selected_model:
            return model
    return {}


def _coerce_axis_value(value: Any, axis: dict[str, Any]) -> float:
    number = _coerce_finite_number(value)
    if number is None:
        number = 50.0
    value_range = _normalize_pair(axis.get("value_range"), [0.0, 100.0]) or [0.0, 100.0]
    return round(max(value_range[0], min(value_range[1], number)), 4)


def _normalize_pair(value: Any, fallback: list[float] | None) -> list[float] | None:
    if (
        isinstance(value, list)
        and len(value) == 2
        and _coerce_finite_number(value[0]) is not None
        and _coerce_finite_number(value[1]) is not None
    ):
        first = float(value[0])
        second = float(value[1])
        if first != second:
            return [first, second]
    return fallback


def _coerce_finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and float("-inf") < float(value) < float("inf"):
        return float(value)
    return None


def _normalize_pose_id(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized.endswith(".exp3.json"):
        normalized = normalized[: -len(".exp3.json")]
    normalized = normalized.replace("\\", "/").split("/")[-1]
    normalized = re.sub(r"[^a-z0-9_\-\u4e00-\u9fff]+", "_", normalized)
    normalized = re.sub(r"_+", "_", normalized).strip("_-")
    return normalized
