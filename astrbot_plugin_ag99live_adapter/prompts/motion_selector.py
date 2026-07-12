from __future__ import annotations

from typing import Any

from .motion_selector_examples import (
    create_default_motion_reference_examples,
    resolve_motion_reference_examples as _resolve_motion_reference_examples,
)


REFERENCE_AXIS_IDS = [
    "head_yaw",
    "head_roll",
    "head_pitch",
    "body_yaw",
    "body_roll",
    "body_pitch",
    "eye_open_left",
    "eye_open_right",
    "eye_smile_left",
    "eye_smile_right",
    "gaze_x",
    "gaze_y",
    "mouth_smile",
    "mouth_x",
    "brow_bias",
    "brow_left_detail",
    "brow_right_detail",
    "mouth_open",
    "breath",
]

DEFAULT_MOTION_PROMPT_INSTRUCTION = (
    "根据回复的真实语气选择直接动作意图。只输出有明确表演贡献的轴；"
    "头身跟随等派生关系由运行时关系图处理，不要为了凑完整而重复填写。"
    "Live2D 的小动作不易辨认，普通对话的主要姿态轴从 3 级开始，确保动作清晰可见。"
    "2 级只用于安静、犹豫、低落等克制表达，1 级只用于局部细节、缓入或恢复。"
    "4 级用于短暂而明显的夸张表演、强烈反应或舞台化强调，不要长时间保持。"
)

DEFAULT_MOTION_REFERENCE_EXAMPLES = create_default_motion_reference_examples(
    REFERENCE_AXIS_IDS
)


def resolve_motion_reference_examples(
    *,
    runtime_state: Any,
    update_runtime_state: bool = True,
) -> list[dict[str, Any]]:
    return _resolve_motion_reference_examples(
        runtime_state=runtime_state,
        default_examples=DEFAULT_MOTION_REFERENCE_EXAMPLES,
        normalize_emotion_key=_normalize_emotion_key,
        update_runtime_state=update_runtime_state,
    )


def resolve_motion_prompt_instruction(*, runtime_state: Any) -> str:
    raw_value = str(getattr(runtime_state, "motion_prompt_instruction", "") or "").strip()
    if not raw_value:
        return DEFAULT_MOTION_PROMPT_INSTRUCTION
    return truncate_prompt_text(raw_value, 800)


def _normalize_emotion_key(value: str) -> str:
    normalized = "".join(
        char.lower()
        for char in str(value or "").strip()
        if char.isalnum() or char == "_"
    )
    aliases = {
        "joy": "happy",
        "question": "confused",
        "playfulwink": "happy",
        "playful_wink": "happy",
        "extremelytired": "tired",
        "blush": "embarrassed",
    }
    return aliases.get(normalized, normalized)


def truncate_prompt_text(value: str, max_chars: int) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."
