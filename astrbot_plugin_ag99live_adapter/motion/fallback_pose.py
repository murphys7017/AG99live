from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from ..motion.motion_intent import _incr_repair_stat
from ..prompts.semantic_axis_prompt import profile_prompt_axes

DEFAULT_FALLBACK_POSE_ID = "neutral"
_REPAIR_SKELETON_GROUPS = ("head", "body", "gaze")
_REPAIR_MAX_AXES_PER_GROUP = 2
_NON_EMOTIVE_EXPRESSION_TOKENS = {
    "controller",
    "jacketoff",
    "jaketoff",
    "mouseclick",
    "outfit",
    "pen",
    "tablet",
    "tracking",
}


@dataclass(frozen=True, slots=True)
class FallbackPoseResolution:
    id: str
    source: str
    axes: dict[str, float]

    @property
    def is_default_neutral(self) -> bool:
        return self.id == DEFAULT_FALLBACK_POSE_ID and self.source == "semantic_axis_profile"


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

    for candidate in _build_motion_catalog_semantic_candidates(
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
    resolution = resolve_fallback_pose(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
        fallback_pose_id=fallback_pose_id,
    )
    return dict(resolution.axes) if resolution is not None else None


def resolve_fallback_pose(
    *,
    runtime_state: Any,
    semantic_profile: dict[str, Any],
    fallback_pose_id: Any,
) -> FallbackPoseResolution | None:
    normalized_id = _normalize_pose_id(fallback_pose_id)
    if normalized_id:
        _incr_repair_stat("fallback_resolve_requested")
    if not normalized_id:
        return None
    for candidate in build_fallback_pose_candidates(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
        limit=None,
    ):
        if candidate.get("id") == normalized_id:
            axes = candidate.get("axes")
            if not isinstance(axes, dict) or not axes:
                return None
            return FallbackPoseResolution(
                id=normalized_id,
                source=str(candidate.get("source") or "").strip(),
                axes=dict(axes),
            )
    return None


def repair_motion_axes_with_fallback_pose(
    *,
    axes: dict[str, float],
    semantic_profile: dict[str, Any],
    fallback_axes: dict[str, float] | None,
) -> tuple[dict[str, float], list[str], list[str]]:
    """Fill missing semantic skeleton groups from a fallback pose.

    This repairs weak LLM outputs that only contain expression detail axes while
    preserving non-neutral axes the model already produced.
    """
    if not isinstance(axes, dict) or not axes:
        return axes, [], []
    if not isinstance(fallback_axes, dict) or not fallback_axes:
        return dict(axes), [], []

    axis_by_id = _prompt_axis_by_id(semantic_profile)
    if not axis_by_id:
        return dict(axes), [], []

    repaired = dict(axes)
    added: list[str] = []
    replaced: list[str] = []
    present_groups = _active_axis_groups(repaired, axis_by_id)
    missing_groups = [
        group
        for group in _REPAIR_SKELETON_GROUPS
        if group not in present_groups
    ]
    if not missing_groups and len(repaired) >= 3:
        return repaired, [], []

    for group in missing_groups:
        group_added = 0
        for axis_id, fallback_value in fallback_axes.items():
            if group_added >= _REPAIR_MAX_AXES_PER_GROUP:
                break
            axis = axis_by_id.get(str(axis_id or "").strip())
            if axis is None:
                continue
            if str(axis.get("semantic_group") or "").strip().lower() != group:
                continue
            if _is_axis_neutralish(fallback_value, axis):
                continue
            normalized_axis_id = str(axis_id)
            if normalized_axis_id in repaired:
                if not _is_axis_neutralish(repaired[normalized_axis_id], axis):
                    continue
                repaired[normalized_axis_id] = _coerce_axis_value(fallback_value, axis)
                replaced.append(normalized_axis_id)
                group_added += 1
                continue
            repaired[str(axis_id)] = _coerce_axis_value(fallback_value, axis)
            added.append(str(axis_id))
            group_added += 1

    return repaired, added, replaced


def build_default_neutral_pose_axes(semantic_profile: dict[str, Any]) -> dict[str, float]:
    _incr_repair_stat("fallback_used_neutral")
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
                "description": str(sample.get("description") or sample.get("scenario") or "").strip(),
                "tags": _text_list(sample.get("tags"), limit=6),
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
        if _is_non_emotive_expression(expression_name):
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
                "description": str(expression.get("description") or "").strip(),
                "intensity": str(expression.get("intensity") or "").strip(),
                "tags": _text_list([expression.get("category")], limit=3),
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
        if _is_non_emotive_expression(expression_name):
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
                "description": str(expression.get("description") or "").strip(),
                "intensity": str(expression.get("intensity") or "").strip(),
                "tags": _text_list([expression.get("category")], limit=3),
                "axes": axes,
            }
        )
    return candidates


def _build_motion_catalog_semantic_candidates(
    *,
    runtime_state: Any,
    semantic_profile: dict[str, Any],
) -> list[dict[str, Any]]:
    model = _resolve_selected_model_payload(runtime_state)
    constraints = model.get("constraints") if isinstance(model, dict) else None
    motions = constraints.get("motions") if isinstance(constraints, dict) else None
    if not isinstance(motions, list):
        return []

    components_by_file = _build_motion_component_axis_map(
        model.get("motion_resource_pool") if isinstance(model, dict) else None,
        semantic_profile,
    )
    if not components_by_file:
        return []

    candidates: list[dict[str, Any]] = []
    for motion in motions:
        if not isinstance(motion, dict):
            continue
        file_value = str(motion.get("file") or "").strip().replace("\\", "/")
        if not file_value:
            continue
        axes = components_by_file.get(file_value)
        if not axes:
            continue
        candidate_id = _normalize_pose_id(
            motion.get("catalog_id")
            or motion.get("catalog_label")
            or motion.get("name")
            or file_value
        )
        if not candidate_id:
            continue
        emotion_bias = _text_list(motion.get("catalog_emotion_bias"), limit=6)
        candidates.append(
            {
                "id": candidate_id,
                "label": str(
                    motion.get("catalog_label") or motion.get("name") or candidate_id
                ).strip(),
                "emotion_label": emotion_bias[0] if emotion_bias else candidate_id,
                "source": "motion_catalog_semantic_extract",
                "description": str(motion.get("catalog_description") or "").strip(),
                "tags": _text_list(motion.get("catalog_tags"), limit=6),
                "emotion_bias": emotion_bias,
                "intensity": str(motion.get("catalog_intensity") or "").strip(),
                "recommended_scenarios": _text_list(
                    motion.get("recommended_scenarios"),
                    limit=6,
                ),
                "axes": axes,
            }
        )
    return candidates


def _build_motion_component_axis_map(
    motion_resource_pool: Any,
    semantic_profile: dict[str, Any],
) -> dict[str, dict[str, float]]:
    if not isinstance(motion_resource_pool, dict):
        return {}
    components = motion_resource_pool.get("driver_components")
    if not isinstance(components, list):
        return {}

    axis_by_parameter = _build_axis_binding_map(semantic_profile)
    axes_by_file: dict[str, dict[str, float]] = {}
    score_by_file_axis: dict[tuple[str, str], float] = {}
    for component in components:
        if not isinstance(component, dict):
            continue
        if str(component.get("engine_role") or "").strip() != "driver":
            continue
        file_value = str(component.get("source_file") or "").strip().replace("\\", "/")
        parameter_id = str(component.get("parameter_id") or "").strip()
        binding_entry = axis_by_parameter.get(parameter_id)
        if not file_value or binding_entry is None:
            continue
        axis, binding = binding_entry
        axis_id = str(axis.get("id") or "").strip()
        if not axis_id:
            continue
        score = _coerce_finite_number(component.get("energy_score")) or 0.0
        score_key = (file_value, axis_id)
        if score_key in score_by_file_axis and score <= score_by_file_axis[score_key]:
            continue
        value = _motion_component_to_axis_value(
            component,
            axis=axis,
            binding=binding,
        )
        axes_by_file.setdefault(file_value, {})[axis_id] = value
        score_by_file_axis[score_key] = score
    return {
        file_value: axes
        for file_value, axes in axes_by_file.items()
        if axes
    }


def _build_axis_binding_map(
    semantic_profile: dict[str, Any],
) -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
    result: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
    for axis in profile_prompt_axes(semantic_profile):
        bindings = axis.get("parameter_bindings")
        if not isinstance(bindings, list):
            continue
        for binding in bindings:
            if not isinstance(binding, dict):
                continue
            parameter_id = str(binding.get("parameter_id") or "").strip()
            if parameter_id and parameter_id not in result:
                result[parameter_id] = (axis, binding)
    return result


def _motion_component_to_axis_value(
    component: dict[str, Any],
    *,
    axis: dict[str, Any],
    binding: dict[str, Any],
) -> float:
    value_profile = component.get("value_profile")
    if not isinstance(value_profile, dict):
        return _coerce_axis_value(axis.get("neutral", 50), axis)

    baseline = _coerce_finite_number(value_profile.get("baseline")) or 0.0
    observed_min = _coerce_finite_number(value_profile.get("min"))
    observed_max = _coerce_finite_number(value_profile.get("max"))
    candidates = [
        value
        for value in (observed_min, observed_max)
        if value is not None
    ]
    if not candidates:
        return _coerce_axis_value(axis.get("neutral", 50), axis)
    output_value = max(candidates, key=lambda value: abs(value - baseline))
    return _map_output_value_to_axis_value(output_value, axis=axis, binding=binding)


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
    axis_by_id = _prompt_axis_by_id(semantic_profile)
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


def _prompt_axis_by_id(semantic_profile: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(axis.get("id") or "").strip(): axis
        for axis in profile_prompt_axes(semantic_profile)
        if str(axis.get("id") or "").strip()
    }


def _active_axis_groups(
    axes: dict[str, float],
    axis_by_id: dict[str, dict[str, Any]],
) -> set[str]:
    groups: set[str] = set()
    for axis_id, value in axes.items():
        axis = axis_by_id.get(str(axis_id or "").strip())
        if not axis:
            continue
        if _is_axis_neutralish(value, axis):
            continue
        group = str(axis.get("semantic_group") or "").strip().lower()
        if group:
            groups.add(group)
    return groups


def _is_axis_neutralish(value: Any, axis: dict[str, Any]) -> bool:
    number = _coerce_finite_number(value)
    if number is None:
        return True
    neutral = _coerce_finite_number(axis.get("neutral"))
    if neutral is None:
        neutral = 50.0
    soft_range = _normalize_pair(axis.get("soft_range"), None)
    if soft_range is not None:
        return soft_range[0] <= number <= soft_range[1]
    value_range = _normalize_pair(axis.get("value_range"), [0.0, 100.0]) or [0.0, 100.0]
    tolerance = max((value_range[1] - value_range[0]) * 0.08, 1.0)
    return abs(number - neutral) <= tolerance


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


def _is_non_emotive_expression(value: Any) -> bool:
    normalized = _normalize_pose_id(value)
    if not normalized:
        return False
    compact = normalized.replace("_", "").replace("-", "")
    return any(token in compact for token in _NON_EMOTIVE_EXPRESSION_TOKENS)


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


def _text_list(value: Any, *, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        text = str(item or "").strip()
        if not text:
            continue
        result.append(text)
        if len(result) >= limit:
            break
    return result


def _normalize_pose_id(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized.endswith(".exp3.json"):
        normalized = normalized[: -len(".exp3.json")]
    normalized = normalized.replace("\\", "/").split("/")[-1]
    normalized = re.sub(r"[^a-z0-9_\-\u4e00-\u9fff]+", "_", normalized)
    normalized = re.sub(r"_+", "_", normalized).strip("_-")
    return normalized
