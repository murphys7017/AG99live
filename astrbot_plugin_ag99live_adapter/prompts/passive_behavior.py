from __future__ import annotations

import json
from typing import Any

from ..motion.motion_intent import MAX_IDLE_MOTION_STEPS
from .semantic_axis_prompt import profile_prompt_axes


PASSIVE_BEHAVIOR_RESPONSE_SCHEMA = {
    "anyOf": [
        {
            "type": "object",
            "properties": {"decision": {"const": "none"}},
            "required": ["decision"],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "decision": {"const": "emit"},
                "motion_steps": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_IDLE_MOTION_STEPS,
                    "items": {
                        "type": "object",
                        "properties": {
                            "axis_values": {
                                "type": "object",
                                "minProperties": 1,
                                "additionalProperties": {"type": "number"},
                            },
                            "duration_weight": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 3,
                            },
                        },
                        "required": ["axis_values", "duration_weight"],
                        "additionalProperties": False,
                    },
                },
                "duration_hint_ms": {
                    "type": "integer",
                    "minimum": 3000,
                    "maximum": 10000,
                },
                "intent_tags": {
                    "type": "array",
                    "maxItems": 6,
                    "items": {"type": "string", "minLength": 1, "maxLength": 48},
                },
            },
            "required": ["decision", "motion_steps"],
            "additionalProperties": False,
        },
    ],
}


PASSIVE_BEHAVIOR_SYSTEM_PROMPT = (
    """你是 AG99live 桌宠的后台被动动作生成器。
根据当前状态和模型语义轴选择动作。若有 recent_interaction，结合上一段实际呈现的类型、结束方式和间隔，决定延续姿态或保持静止。

严格要求：
- 不读取、推断或提及用户对话、Persona 回复、语音内容、聊天历史或用户意图。
- 不生成文本回复，不调用工具，不输出 Live2D 原始参数、参数名、资源文件名或说明。
- 仅使用输入列出的语义轴 ID 和对应 value_range 内的具体数值，不得补充、改名或臆造轴。
- 流式输出一个完整的 JSON 对象，格式如下：
  {"decision":"none"}
  {"decision":"emit","intent_tags":["..."],"motion_steps":[{"axis_values":{"<语义轴 ID>":12.5},"duration_weight":1}],"duration_hint_ms":4000}
- 有值得补充的动作时输出 emit，否则输出 none。
- emit 的顶层包含 decision 和 motion_steps，可附加 duration_hint_ms 和 intent_tags。duration_hint_ms 表示整段动作时长，与 motion_steps 同级。
- 每个 motion_steps 元素只有 axis_values 和 duration_weight。duration_weight 是 1 到 3 的整数，表示该步的相对时长。
- intent_tags 最多 6 个。每个元素填写一个不超过 48 字符的短标签。
- motion_steps 只放当前动作需要变化的轴，数值必须位于该轴给出的 value_range。
- motion_steps 最多使用 """
    + str(MAX_IDLE_MOTION_STEPS)
    + """ 个步骤，后台动作优先保持短小、缓慢和低频。
- duration_hint_ms 使用 3000 到 10000 的整数，通常选择 4000 到 6000。动作应缓慢进入、平缓回位，克制、轻微、自然，避免突然转头、快速摆动或连续重复同一动作。
"""
)


def build_passive_behavior_prompt(
    *,
    neurobrain_state: dict[str, Any],
    semantic_profile: dict[str, Any],
    recent_interaction: dict[str, Any] | None = None,
) -> str:
    axes = []
    for axis in profile_prompt_axes(semantic_profile):
        value_range = axis.get("value_range")
        if not isinstance(value_range, list) or len(value_range) != 2:
            continue
        axes.append(
            {
                "id": str(axis.get("id") or "").strip(),
                "label": _short_text(axis.get("label"), 80),
                "control_role": str(axis.get("control_role") or "").strip(),
                "negative_semantics": _short_list(axis.get("negative_semantics")),
                "positive_semantics": _short_list(axis.get("positive_semantics")),
                "usage_notes": _short_text(axis.get("usage_notes"), 160),
                "description": _short_text(axis.get("description"), 160),
                "value_range": value_range,
                "neutral": axis.get("neutral"),
            }
        )
    if not axes:
        raise ValueError("passive_behavior_profile_has_no_available_axes")

    payload = {
        "neurobrain_state": neurobrain_state,
        "semantic_axes": axes[:24],
    }
    if recent_interaction is not None:
        payload["recent_interaction"] = recent_interaction
    return (
        "根据当前状态选择并流式输出后台补充动作。输入不包含任何对话信息：\n"
        f"{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}"
    )


def _short_text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _short_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip()[:48] for item in value if str(item).strip()][:8]
