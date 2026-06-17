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
    for axis in semantic_profile.get("axes", []):
        if not isinstance(axis, dict):
            continue
        role = str(axis.get("control_role") or "").strip()
        if role not in {"primary", "hint"}:
            continue
        axis_id = str(axis.get("id") or "").strip()
        if not axis_id:
            continue
        neutral = axis.get("neutral", 50)
        axes[axis_id] = float(neutral) if isinstance(neutral, (int, float)) else 50.0
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
        "summary": {
            "axis_count": len(axes),
        },
    }
