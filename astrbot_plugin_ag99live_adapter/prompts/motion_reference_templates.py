from __future__ import annotations

from collections import defaultdict
from typing import Any

from .semantic_axis_prompt import profile_prompt_axes


_NON_EMOTIVE_EXPRESSION_TOKENS = {
    "controller",
    "mouseclick",
    "outfit",
    "jaketoff",
    "jacketoff",
    "pen",
    "tablet",
    "tracking",
}


def resolve_motion_reference_templates(
    *,
    runtime_state: Any,
    semantic_profile: dict[str, Any],
    limit: int | None = None,
) -> list[dict[str, Any]]:
    model_payload = _resolve_selected_model_payload(runtime_state)
    if model_payload is None:
        return []
    return build_motion_reference_templates(
        model_payload=model_payload,
        semantic_profile=semantic_profile,
        limit=limit,
    )


def build_motion_reference_templates(
    *,
    model_payload: dict[str, Any],
    semantic_profile: dict[str, Any],
    limit: int | None = None,
) -> list[dict[str, Any]]:
    parameter_axis_map = _build_parameter_axis_map(semantic_profile)

    templates = _build_motion_curve_templates(
        model_payload=model_payload,
        parameter_axis_map=parameter_axis_map,
    )
    templates.extend(
        _build_expression_templates(
            model_payload=model_payload,
            parameter_axis_map=parameter_axis_map,
        )
    )

    templates.sort(
        key=lambda item: (
            _source_sort_rank(str(item.get("source_type") or "")),
            -float(item.get("score") or 0.0),
            str(item.get("label") or item.get("motion_name") or item.get("expression_name") or ""),
        )
    )
    if limit is None:
        return templates
    return templates[: max(0, limit)]


def format_motion_reference_templates(
    templates: list[dict[str, Any]],
    *,
    truncate_text: Any,
    limit: int | None = None,
) -> str:
    normalized = [item for item in templates if isinstance(item, dict)]
    if not normalized:
        return ""

    lines = [
        "旧动作/表情参考模板（已过滤为语义轴，仅作动作原型，不是固定答案）：",
        "- 来源是模型内旧 motion 曲线和 exp3 表情；这里优先保留能映射到 prompt 语义轴的参数。",
        "- 物理演算、头发、手臂、附件、marker、服装/控制器开关、未映射参数和纯运行时轴已经过滤，不要把它们写进输出。",
        "- 纯表情开关如果有语义价值，会作为 emotion_label/意图参考保留；它们不是可输出轴，不能伪造成参数。",
        "- 使用这些模板学习动作结构：先选头身/视线/眼部骨架，再少量补嘴角和眉毛；不要照抄整组轴和值。",
    ]
    selected = normalized if limit is None else normalized[: max(0, limit)]
    for template in selected:
        source_type = str(template.get("source_type") or "motion").strip()
        label = truncate_text(str(template.get("label") or template.get("motion_name") or "").strip(), 32)
        name = truncate_text(
            str(template.get("motion_name") or template.get("expression_name") or "").strip(),
            32,
        )
        name_suffix = f"/{name}" if name and name != label else ""
        source_label = "表情" if source_type == "expression" else "动作"
        intensity = str(template.get("intensity") or "").strip()
        tags = ", ".join(_text_list(template.get("tags"), limit=4))
        emotion_bias = ", ".join(_text_list(template.get("emotion_bias"), limit=4))
        scenarios = ", ".join(_text_list(template.get("scenarios"), limit=3))
        exclusive_with = ", ".join(_text_list(template.get("exclusive_with"), limit=3))
        description = truncate_text(str(template.get("description") or "").strip(), 80)
        context_parts = []
        if tags:
            context_parts.append(f"标签={tags}")
        if emotion_bias:
            context_parts.append(f"情绪={emotion_bias}")
        if intensity:
            context_parts.append(f"强度={intensity}")
        if scenarios:
            context_parts.append(f"适用={scenarios}")
        if exclusive_with:
            context_parts.append(f"互斥={exclusive_with}")
        if description:
            context_parts.append(f"说明={description}")
        context_text = f"；{'；'.join(context_parts)}" if context_parts else ""
        axis_text = _format_template_axis_summary(template.get("axes"), truncate_text=truncate_text)
        intent_text = truncate_text(str(template.get("intent") or "").strip(), 80)
        intent_suffix = f"；表情意图={intent_text}" if intent_text else ""
        if axis_text:
            lines.append(f"- [{source_label}] {label}{name_suffix}{context_text}{intent_suffix}；保留语义轴={axis_text}")
            continue
        if source_type == "expression" and intent_text:
            lines.append(f"- [{source_label}] {label}{name_suffix}{context_text}{intent_suffix}；无可输出语义轴，仅用于 emotion_label 和语气判断")
    return "\n".join(lines)


def _resolve_selected_model_payload(runtime_state: Any) -> dict[str, Any] | None:
    model_info = getattr(runtime_state, "model_info", None)
    if not isinstance(model_info, dict):
        return None
    selected_model = str(model_info.get("selected_model") or "").strip()
    models = model_info.get("models")
    if not selected_model or not isinstance(models, list):
        return None
    for model in models:
        if not isinstance(model, dict):
            continue
        if str(model.get("name") or "").strip() == selected_model:
            return model
    return None


def _build_parameter_axis_map(semantic_profile: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    try:
        axes = profile_prompt_axes(semantic_profile)
    except ValueError:
        return result
    for axis in axes:
        axis_id = str(axis.get("id") or "").strip()
        if not axis_id:
            continue
        bindings = axis.get("parameter_bindings")
        if not isinstance(bindings, list):
            continue
        for binding in bindings:
            if not isinstance(binding, dict):
                continue
            parameter_id = str(binding.get("parameter_id") or "").strip()
            if parameter_id:
                result[parameter_id] = axis_id
    return result


def _build_motion_curve_templates(
    *,
    model_payload: dict[str, Any],
    parameter_axis_map: dict[str, str],
) -> list[dict[str, Any]]:
    motion_pool = model_payload.get("motion_resource_pool")
    if not isinstance(motion_pool, dict):
        return []

    raw_components = motion_pool.get("driver_components")
    if not isinstance(raw_components, list):
        raw_components = motion_pool.get("components")
    if not isinstance(raw_components, list):
        return []

    metadata_by_file = _build_motion_metadata_by_file(model_payload, motion_pool)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for component in raw_components:
        if not isinstance(component, dict):
            continue
        if str(component.get("engine_role") or "driver").strip() != "driver":
            continue
        parameter_id = str(component.get("parameter_id") or "").strip()
        axis_id = parameter_axis_map.get(parameter_id)
        if not axis_id:
            continue
        source_file = str(component.get("source_file") or "").strip()
        source_motion = str(component.get("source_motion") or "").strip()
        if not source_file and not source_motion:
            continue
        normalized = dict(component)
        normalized["axis_id"] = axis_id
        grouped[source_file or source_motion].append(normalized)

    templates: list[dict[str, Any]] = []
    for source_key, components in grouped.items():
        metadata = metadata_by_file.get(source_key, {})
        axes = _summarize_template_axes(components)
        if not axes:
            continue
        source_motion = str(components[0].get("source_motion") or "").strip()
        motion_name = str(metadata.get("motion_name") or source_motion or source_key).strip()
        label = str(metadata.get("label") or metadata.get("catalog_label") or motion_name).strip()
        templates.append(
            {
                "source_type": "motion",
                "motion_name": motion_name,
                "label": label,
                "file": str(metadata.get("file") or source_key).strip(),
                "intensity": str(metadata.get("intensity") or "").strip(),
                "description": str(metadata.get("description") or "").strip(),
                "tags": _text_list(metadata.get("tags") or metadata.get("catalog_tags"), limit=8),
                "emotion_bias": _text_list(metadata.get("emotion_bias"), limit=6),
                "scenarios": _text_list(metadata.get("recommended_scenarios"), limit=6),
                "exclusive_with": _text_list(metadata.get("exclusive_with"), limit=8),
                "axes": axes,
                "score": round(sum(float(item.get("energy_score") or 0.0) for item in components), 4),
            }
        )
    return templates


def _build_motion_metadata_by_file(
    model_payload: dict[str, Any],
    motion_pool: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    presets = motion_pool.get("motion_presets")
    if isinstance(presets, list):
        for preset in presets:
            if not isinstance(preset, dict):
                continue
            motion_file = str(preset.get("motion_file") or "").strip()
            if not motion_file:
                continue
            result[motion_file] = {
                "file": motion_file,
                "motion_name": str(preset.get("motion_name") or "").strip(),
                "intensity": str(preset.get("intensity") or "").strip(),
                "tags": _text_list(preset.get("catalog_tags"), limit=8),
            }

    constraints = model_payload.get("constraints")
    motions = constraints.get("motions") if isinstance(constraints, dict) else None
    if isinstance(motions, list):
        for motion in motions:
            if not isinstance(motion, dict):
                continue
            motion_file = str(motion.get("file") or "").strip()
            if not motion_file:
                continue
            current = result.setdefault(motion_file, {"file": motion_file})
            current.update(
                {
                    "motion_name": str(motion.get("name") or current.get("motion_name") or "").strip(),
                    "label": str(motion.get("catalog_label") or current.get("label") or "").strip(),
                    "description": str(motion.get("catalog_description") or current.get("description") or "").strip(),
                    "intensity": str(motion.get("catalog_intensity") or current.get("intensity") or "").strip(),
                    "tags": _text_list(motion.get("catalog_tags") or current.get("tags"), limit=8),
                    "emotion_bias": _text_list(motion.get("catalog_emotion_bias") or current.get("emotion_bias"), limit=6),
                    "recommended_scenarios": _text_list(motion.get("recommended_scenarios"), limit=6),
                    "exclusive_with": _text_list(motion.get("catalog_exclusive_with") or current.get("exclusive_with"), limit=8),
                }
            )
    return result


def _build_expression_templates(
    *,
    model_payload: dict[str, Any],
    parameter_axis_map: dict[str, str],
) -> list[dict[str, Any]]:
    constraints = model_payload.get("constraints")
    expressions = constraints.get("expressions") if isinstance(constraints, dict) else None
    if not isinstance(expressions, list):
        return []

    templates: list[dict[str, Any]] = []
    for expression in expressions:
        if not isinstance(expression, dict):
            continue
        expression_name = str(expression.get("name") or "").strip()
        expression_file = str(expression.get("file") or "").strip()
        if not expression_name and not expression_file:
            continue
        if _is_non_emotive_expression(expression_name, expression_file):
            continue
        axes = _summarize_expression_axes(
            expression.get("parameters"),
            parameter_axis_map=parameter_axis_map,
        )
        intent = _build_expression_intent_text(expression, axes=axes)
        if not axes and not intent:
            continue
        templates.append(
            {
                "source_type": "expression",
                "expression_name": expression_name or expression_file,
                "label": expression_name or expression_file,
                "file": expression_file,
                "intensity": str(expression.get("intensity") or "").strip(),
                "tags": [str(expression.get("category") or "").strip()] if str(expression.get("category") or "").strip() else [],
                "scenarios": [],
                "intent": intent,
                "axes": axes,
                "score": _expression_template_score(expression, axes),
            }
        )
    return templates


def _summarize_expression_axes(
    value: Any,
    *,
    parameter_axis_map: dict[str, str],
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    best_by_axis: dict[str, dict[str, Any]] = {}
    for parameter in value:
        if not isinstance(parameter, dict):
            continue
        parameter_id = str(parameter.get("id") or "").strip()
        axis_id = parameter_axis_map.get(parameter_id)
        if not axis_id:
            continue
        candidate = {
            "axis_id": axis_id,
            "trait": f"expression_{str(parameter.get('blend') or 'Add').strip().lower()}",
            "strength": str(parameter.get("intensity") or "").strip(),
            "direction": "high" if _coerce_float(parameter.get("value")) >= 0 else "low",
            "energy_score": round(abs(_coerce_float(parameter.get("value"))), 4),
        }
        current = best_by_axis.get(axis_id)
        if current is None or float(candidate["energy_score"]) > float(current.get("energy_score") or 0.0):
            best_by_axis[axis_id] = candidate
    axes = list(best_by_axis.values())
    axes.sort(
        key=lambda item: (
            -float(item.get("energy_score") or 0.0),
            str(item.get("axis_id") or ""),
        )
    )
    return axes


def _build_expression_intent_text(
    expression: dict[str, Any],
    *,
    axes: list[dict[str, Any]],
) -> str:
    name = str(expression.get("name") or "").strip()
    category = str(expression.get("category") or "").strip()
    axis_ids = [
        str(item.get("axis_id") or "").strip()
        for item in axes
        if isinstance(item, dict) and str(item.get("axis_id") or "").strip()
    ][:5]
    parts = []
    if name:
        parts.append(f"label={name}")
    if category:
        parts.append(f"category={category}")
    if axis_ids:
        parts.append(f"mapped_axes={','.join(axis_ids)}")
    return "; ".join(parts)


def _is_non_emotive_expression(name: str, file: str) -> bool:
    normalized_name = _normalize_token_text(name)
    normalized_file = _normalize_token_text(file.rsplit("/", 1)[-1].split(".", 1)[0])
    return normalized_name in _NON_EMOTIVE_EXPRESSION_TOKENS or normalized_file in _NON_EMOTIVE_EXPRESSION_TOKENS


def _expression_template_score(expression: dict[str, Any], axes: list[dict[str, Any]]) -> float:
    axis_score = sum(float(item.get("energy_score") or 0.0) for item in axes)
    if axis_score > 0:
        return round(axis_score, 4)
    intensity = str(expression.get("intensity") or "").strip()
    if intensity == "high":
        return 0.3
    if intensity == "medium":
        return 0.2
    if intensity == "low":
        return 0.1
    return 0.05


def _summarize_template_axes(components: list[dict[str, Any]]) -> list[dict[str, Any]]:
    best_by_axis: dict[str, dict[str, Any]] = {}
    for component in components:
        axis_id = str(component.get("axis_id") or "").strip()
        if not axis_id:
            continue
        current = best_by_axis.get(axis_id)
        if current is None or float(component.get("energy_score") or 0.0) > float(current.get("energy_score") or 0.0):
            best_by_axis[axis_id] = component

    axes: list[dict[str, Any]] = []
    for axis_id, component in best_by_axis.items():
        axes.append(
            {
                "axis_id": axis_id,
                "trait": str(component.get("trait") or "motion").strip(),
                "strength": str(component.get("strength") or "").strip(),
                "direction": _infer_component_direction(component),
                "peak_time_ratio": _round_optional(component.get("peak_time_ratio")),
                "energy_score": _round_optional(component.get("energy_score")),
            }
        )
    axes.sort(
        key=lambda item: (
            -float(item.get("energy_score") or 0.0),
            str(item.get("axis_id") or ""),
        )
    )
    return axes[:5]


def _infer_component_direction(component: dict[str, Any]) -> str:
    value_profile = component.get("value_profile")
    if not isinstance(value_profile, dict):
        return "curve"
    baseline = _coerce_float(value_profile.get("baseline"))
    min_value = _coerce_float(value_profile.get("min"))
    max_value = _coerce_float(value_profile.get("max"))
    high_delta = abs(max_value - baseline)
    low_delta = abs(baseline - min_value)
    if high_delta < 0.001 and low_delta < 0.001:
        return "near_neutral"
    if high_delta >= low_delta * 1.2:
        return "high"
    if low_delta >= high_delta * 1.2:
        return "low"
    return "bidirectional"


def _format_template_axis_summary(value: Any, *, truncate_text: Any) -> str:
    if not isinstance(value, list):
        return ""
    parts: list[str] = []
    for axis in value:
        if not isinstance(axis, dict):
            continue
        axis_id = str(axis.get("axis_id") or "").strip()
        if not axis_id:
            continue
        details = [
            str(axis.get("trait") or "motion").strip(),
            str(axis.get("strength") or "").strip(),
            _direction_label(str(axis.get("direction") or "")),
        ]
        detail_text = "/".join(item for item in details if item)
        peak = axis.get("peak_time_ratio")
        peak_text = f", peak={float(peak):.2f}" if isinstance(peak, (int, float)) else ""
        parts.append(f"{axis_id}({truncate_text(detail_text, 28)}{peak_text})")
    return ", ".join(parts)


def _direction_label(value: str) -> str:
    labels = {
        "high": "偏高方向",
        "low": "偏低方向",
        "bidirectional": "双向变化",
        "near_neutral": "近中性",
    }
    return labels.get(value, value)


def _source_sort_rank(value: str) -> int:
    if value == "motion":
        return 0
    if value == "expression":
        return 1
    return 2


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


def _round_optional(value: Any) -> float | None:
    if not isinstance(value, (int, float)):
        return None
    return round(float(value), 4)


def _coerce_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _normalize_token_text(value: str) -> str:
    return "".join(char.lower() for char in str(value or "") if char.isalnum())
