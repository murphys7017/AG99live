from __future__ import annotations

from typing import Any

from astrbot_plugin_ag99live_adapter.prompts.motion_selector_examples import (
    create_default_motion_reference_examples,
    resolve_motion_reference_examples,
)


class _RuntimeState:
    motion_tuning_fewshot_enabled = True
    motion_tuning_fewshot_count = 4
    motion_tuning_user_fewshot_count = 3

    def __init__(self, examples: list[dict[str, Any]] | None = None) -> None:
        self._examples = examples or []

    def list_motion_tuning_reference_examples(self) -> list[dict[str, Any]]:
        return list(self._examples)


def _normalize_category(value: str) -> str:
    return value.strip().lower()


def _categories(resolution: dict[str, Any]) -> list[str]:
    return [
        str(example.get("category") or "")
        for example in resolution["examples"]
        if isinstance(example, dict)
    ]


def test_default_references_do_not_force_sequence_examples() -> None:
    resolution = resolve_motion_reference_examples(
        runtime_state=_RuntimeState(),
        default_examples=create_default_motion_reference_examples(
            ["head_roll", "body_roll", "gaze_x", "mouth_smile"]
        ),
        normalize_emotion_key=_normalize_category,
        request_text="收到，谢谢。",
    )

    assert 1 <= len(resolution["examples"]) <= 2
    assert all(category not in {"explain", "surprised", "sequence"} for category in _categories(resolution))


def test_sequence_reference_requires_a_sequence_signal() -> None:
    resolution = resolve_motion_reference_examples(
        runtime_state=_RuntimeState(),
        default_examples=create_default_motion_reference_examples(
            ["head_roll", "body_roll", "gaze_x", "mouth_smile"]
        ),
        normalize_emotion_key=_normalize_category,
        request_text="我先回答，再向你确认接下来的安排。",
    )

    assert any(
        isinstance(example.get("output"), dict)
        and isinstance(example["output"].get("motion_steps"), list)
        for example in resolution["examples"]
    )


def test_relevant_user_references_remain_prioritized() -> None:
    user_example = {
        "sample_id": "user-1",
        "category": "calm_reply",
        "created_at": "2026-09-28T00:00:00+00:00",
        "tags": ["咖啡"],
        "user_text": "咖啡要怎么选？",
        "assistant_text": "先看烘焙度。",
        "output": {
            "intent_tags": ["解释"],
            "axis_levels": {"head_roll": 2},
        },
    }
    resolution = resolve_motion_reference_examples(
        runtime_state=_RuntimeState([user_example]),
        default_examples=create_default_motion_reference_examples(["head_roll"]),
        normalize_emotion_key=_normalize_category,
        request_text="咖啡豆适合怎么选？",
    )

    assert resolution["examples"][0]["sample_id"] == "user-1"


def test_ordinary_request_excludes_relevant_user_sequence_reference() -> None:
    user_sequence = {
        "sample_id": "user-sequence",
        "category": "calm_reply",
        "created_at": "2026-09-28T00:00:00+00:00",
        "tags": ["咖啡"],
        "user_text": "咖啡要怎么选？",
        "assistant_text": "先看烘焙度，再确认口味。",
        "output": {
            "intent_tags": ["解释", "转折"],
            "motion_steps": [
                {"axis_levels": {"head_roll": 2}, "duration_weight": 1},
                {"axis_levels": {"head_roll": 0}, "duration_weight": 1},
            ],
        },
    }
    resolution = resolve_motion_reference_examples(
        runtime_state=_RuntimeState([user_sequence]),
        default_examples=create_default_motion_reference_examples(["head_roll"]),
        normalize_emotion_key=_normalize_category,
        request_text="咖啡豆适合怎么选？",
    )

    assert all(
        not (
            isinstance(example.get("output"), dict)
            and isinstance(example["output"].get("motion_steps"), list)
        )
        for example in resolution["examples"]
    )
