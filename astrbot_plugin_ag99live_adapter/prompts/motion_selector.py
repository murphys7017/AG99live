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
