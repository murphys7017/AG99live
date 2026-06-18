from __future__ import annotations

import json
from typing import Any


def build_inline_motion_contract(
    *,
    semantic_profile: dict[str, Any],
    motion_instruction: str,
) -> str:
    template_payload = {
        "mode": "inline",
        "intent": build_inline_motion_intent_template(semantic_profile),
    }
    template_tag = f"<@anim {json.dumps(template_payload, ensure_ascii=False, separators=(',', ':'))}>"
    selected_model = str(semantic_profile.get("model_id") or "").strip()
    prompt_axis_lines = build_inline_motion_axis_lines(semantic_profile)

    lines = [
        "AG99live 内联动作契约：",
        "先正常写出助手回复。",
        "然后在最后单独追加一行，这一行只能包含一个 <@anim ...> 标签。",
        "不要把标签放进代码块，也不要解释标签。",
        "标签内部的 JSON 必须是合法 JSON。",
        "顶层标签 payload 必须使用 `mode: \"inline\"`，并包含 `intent` 对象。",
        "`intent.schema_version` 必须是 `engine.motion_intent.v3`。",
        "intent 必须按模板原样包含 `profile_id`、`profile_revision` 和 `model_id`。",
        "不要输出 `intent.mode`；系统会在归一化后补充 expressive。",
        "`intent.intent_tags` 必须包含 2 到 6 个表演意图关键词，可以包含情绪、语气、姿态和场景词。",
        "`intent.resource_id` 是可选明确资源引用；没有候选或不确定时省略，不要编造。",
        "`intent.axes` 对象只能包含下方列出的可控制参数。",
        "`intent.axes` 的每个值必须是 flat number，不要写成 {\"value\": number}。",
        "不要编造参数名，也不要输出未列出的参数。",
        "`intent.duration_hint_ms` 缺失或不合理时会被系统默认成 1000ms。",
        "如果本轮语气平静或不确定，输出安全的轻量语义 intent，不要省略标签。",
    ]
    if motion_instruction:
        lines.append(f"补充动作指令：{motion_instruction}")
    if selected_model:
        lines.append(f"当前 Live2D 模型：{selected_model}。")
    lines.append("允许使用的可控制参数：")
    lines.extend(prompt_axis_lines)
    lines.append("使用下面的标签模板结构，并填入合适的数值：")
    lines.append(template_tag)
    return "\n".join(lines)


def build_inline_motion_axis_lines(semantic_profile: dict[str, Any]) -> list[str]:
    axes = semantic_profile.get("axes")
    if not isinstance(axes, list):
        return []
    lines: list[str] = []
    for axis in axes:
        if not isinstance(axis, dict):
            continue
        role = str(axis.get("control_role") or "").strip()
        if role not in {"primary", "hint"}:
            continue
        axis_id = str(axis.get("id") or "").strip()
        if not axis_id:
            continue
        label = str(axis.get("label") or axis_id).strip()
        role_label = _format_control_role_label(role)
        negative = ", ".join(
            str(item).strip()
            for item in axis.get("negative_semantics", [])
            if str(item).strip()
        )
        positive = ", ".join(
            str(item).strip()
            for item in axis.get("positive_semantics", [])
            if str(item).strip()
        )
        lines.append(
            f"- {axis_id}（{label}，{role_label}）："
            f"低值={negative or '负方向'}；高值={positive or '正方向'}"
        )
    return lines


def _format_control_role_label(role: str) -> str:
    if role == "primary":
        return "主要控制参数"
    if role == "hint":
        return "辅助细节参数"
    return "可控制参数"


def build_inline_motion_intent_template(semantic_profile: dict[str, Any]) -> dict[str, Any]:
    axes: dict[str, float] = {}
    for index, axis in enumerate(_select_template_axes(semantic_profile, limit=5)):
        if not isinstance(axis, dict):
            continue
        axis_id = str(axis.get("id") or "").strip()
        if not axis_id:
            continue
        axes[axis_id] = _resolve_axis_template_value(axis, index=index)
    if not axes:
        raise RuntimeError("SemanticAxisProfile 没有可用于内联动作契约的可控制参数。")
    return {
        "schema_version": "engine.motion_intent.v3",
        "profile_id": str(semantic_profile.get("profile_id") or "").strip(),
        "profile_revision": int(semantic_profile.get("revision") or 0),
        "model_id": str(semantic_profile.get("model_id") or "").strip(),
        "intent_tags": ["语气关键词", "姿态关键词", "场景关键词"],
        "duration_hint_ms": 1000,
        "axes": axes,
    }


def _select_template_axes(
    semantic_profile: dict[str, Any],
    *,
    limit: int,
) -> list[dict[str, Any]]:
    axes = [axis for axis in semantic_profile.get("axes", []) if isinstance(axis, dict)]
    preferred: list[dict[str, Any]] = []
    fallback: list[dict[str, Any]] = []
    preferred_groups = {"head", "body", "gaze", "eye", "mouth", "brow"}
    for axis in axes:
        role = str(axis.get("control_role") or "").strip()
        if role not in {"primary", "hint"}:
            continue
        group = str(axis.get("semantic_group") or "").strip().lower()
        if group in preferred_groups:
            preferred.append(axis)
        else:
            fallback.append(axis)
    return (preferred + fallback)[: max(0, limit)]


def _resolve_axis_template_value(axis: dict[str, Any], *, index: int) -> float:
    neutral = _coerce_axis_number(axis.get("neutral"), 50.0)
    value_range = axis.get("value_range")
    if (
        isinstance(value_range, list)
        and len(value_range) == 2
        and isinstance(value_range[0], (int, float))
        and isinstance(value_range[1], (int, float))
        and float(value_range[0]) < float(value_range[1])
    ):
        min_value = float(value_range[0])
        max_value = float(value_range[1])
    else:
        min_value = 0.0
        max_value = 100.0

    soft_range = axis.get("soft_range")
    if (
        isinstance(soft_range, list)
        and len(soft_range) == 2
        and isinstance(soft_range[0], (int, float))
        and isinstance(soft_range[1], (int, float))
    ):
        soft_min = float(soft_range[0])
        soft_max = float(soft_range[1])
    else:
        span = max((max_value - min_value) * 0.08, 1.0)
        soft_min = neutral - span
        soft_max = neutral + span

    if index % 2 == 0 and soft_max < max_value:
        span = max(soft_max - neutral, 1.0)
        value = soft_max + max(span * 0.35, 1.0)
    elif soft_min > min_value:
        span = max(neutral - soft_min, 1.0)
        value = soft_min - max(span * 0.35, 1.0)
    elif soft_max < max_value:
        span = max(soft_max - neutral, 1.0)
        value = soft_max + max(span * 0.35, 1.0)
    else:
        value = neutral
    return round(max(min_value, min(max_value, value)), 4)


def _coerce_axis_number(value: Any, fallback: float) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return fallback
