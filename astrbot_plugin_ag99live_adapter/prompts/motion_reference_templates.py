from __future__ import annotations

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

    templates = _build_expression_templates(
        model_payload=model_payload,
        parameter_axis_map=parameter_axis_map,
    )

    templates.sort(
        key=lambda item: (
            -float(item.get("score") or 0.0),
            str(item.get("label") or item.get("expression_name") or ""),
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
        "旧表情参考模板（已过滤为语义轴，仅作表情姿态参考，不是固定答案）：",
        "- 来源是模型内 exp3 表情；这里优先保留能映射到 prompt 语义轴的参数。",
        "- 物理演算、头发、手臂、附件、marker、服装/控制器开关、未映射参数和纯运行时轴已经过滤，不要把它们写进输出。",
        "- 纯表情开关如果有语义价值，会作为 emotion_label/意图参考保留；它们不是可输出轴，不能伪造成参数。",
        "- 使用这些模板学习表情姿态：优先判断眼部、嘴角和眉毛的表情含义；不要照抄整组轴和值。",
    ]
    selected = normalized if limit is None else normalized[: max(0, limit)]
    for template in selected:
        label = truncate_text(str(template.get("label") or "").strip(), 32)
        name = truncate_text(
            str(template.get("expression_name") or "").strip(),
            32,
        )
        name_suffix = f"/{name}" if name and name != label else ""
        source_label = "表情"
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
        if intent_text:
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


def _coerce_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _normalize_token_text(value: str) -> str:
    return "".join(char.lower() for char in str(value or "") if char.isalnum())
