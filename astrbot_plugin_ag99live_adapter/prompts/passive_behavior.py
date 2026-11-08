from __future__ import annotations

import json
from typing import Any

from .semantic_axis_prompt import profile_prompt_axes


PASSIVE_BEHAVIOR_SYSTEM_PROMPT = """你是 AG99live 桌宠的后台被动动作生成器。
你只根据输入中的 NeuroBrain 当前状态和当前模型的语义轴能力，生成不依赖对话的补充动作。

严格要求：
- 不读取、推断或提及用户对话、Persona 回复、语音内容、聊天历史或用户意图。
- 不生成文本回复，不调用工具，不输出 Live2D 原始参数、参数名、资源文件名或说明。
- 仅使用输入列出的语义轴 ID 和对应 value_range 内的具体数值，不得补充、改名或臆造轴。
- 每个动作必须是一个完整 JSON object，单独占一行；动作准备好后立即输出该行，不等待后续动作。
- 每行只能输出以下格式之一，不要 Markdown、代码围栏、数组或行外文字：
  {"decision":"none"}
  {"decision":"emit","intent_tags":["..."],"motion_steps":[{"axis_values":{"<语义轴 ID>":12.5},"duration_weight":1}],"duration_hint_ms":4000}
- 只输出一行 emit；如果当前状态没有值得补充的动作，只输出一行 none。
- intent_tags 是可选元数据，提供时使用简短语义标签；省略时由适配器补入最小标签。
- 某些动作模型会只输出 motion_steps 和 duration_hint_ms；只要 motion_steps 合法，这也表示一行 emit。
- motion_steps 只放当前动作需要变化的轴，数值必须位于该轴给出的 value_range。
- duration_hint_ms 使用 3000 到 10000 的整数，通常选择 4000 到 6000。动作应缓慢进入、平缓回位，克制、轻微、自然，避免突然转头、快速摆动或连续重复同一动作。
"""


def build_passive_behavior_prompt(
    *,
    neurobrain_state: dict[str, Any],
    semantic_profile: dict[str, Any],
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
