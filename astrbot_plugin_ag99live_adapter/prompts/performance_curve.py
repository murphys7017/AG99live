from __future__ import annotations

import json
from typing import Any

PERFORMANCE_CURVE_SYSTEM_PROMPT = """你是 AG99live 的 Live2D 表演节奏选择器。
你只根据助手回复文本、关键词和动作意图关键词，选择一个表演曲线提示。

严格要求：
- 只输出一个 JSON object，不要 Markdown，不要解释。
- 不要输出 Live2D 参数轴、毫秒、motion 文件、expression 文件或最终动作计划。
- 所有字段都必须从允许枚举中选择。
"""


def build_performance_curve_prompt(
    *,
    turn_id: str,
    message_id: str,
    assistant_text: str,
    assistant_reply_keywords: list[str],
    motion_intent_tags: list[str],
    motion_effect_summary: dict[str, Any] | None,
    chat_context: list[dict[str, str]],
) -> str:
    payload = {
        "turn_id": str(turn_id or "").strip(),
        "message_id": str(message_id or "").strip(),
        "assistant_text": str(assistant_text or "").strip(),
        "assistant_reply_keywords": assistant_reply_keywords[:8],
        "motion_intent_tags": motion_intent_tags[:8],
        "motion_effect_summary": motion_effect_summary or {},
        "chat_context": chat_context[-6:],
    }
    return (
        "请为下面这段回复选择一个 Live2D 表演曲线提示。\n"
        "允许输出 schema:\n"
        "{\n"
        '  "schema_version": "ag99.performance_curve_hint.v1",\n'
        '  "curve_family": "default | quick_in_hold_soft_out | slow_in_hold_quick_out | pulse_then_settle | soft_breathe",\n'
        '  "entry": "instant | quick | soft | slow",\n'
        '  "hold": "short | steady | long | breathing",\n'
        '  "exit": "quick | soft | slow",\n'
        '  "emphasis": "none | early | middle | late | punctuated",\n'
        '  "energy": "low | medium | high | teasing | calm"\n'
        "}\n\n"
        "输入上下文：\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}"
    )
