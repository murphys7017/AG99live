from __future__ import annotations

from collections.abc import Callable
from typing import Any


def build_example_axes(axis_names: list[str], **overrides: int) -> dict[str, int]:
    axes: dict[str, int] = {}
    for key, value in overrides.items():
        if key not in axis_names:
            continue
        try:
            number = int(round(float(value)))
        except (TypeError, ValueError):
            number = 50
        axes[key] = max(0, min(100, number))
    return axes


def create_default_selector_few_shot_examples(axis_names: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "input": "用户：嗯，我知道了。\n助手：好的，我们继续下一步。",
            "output": {
                "emotion": "neutral",
                "mode": "idle",
                "duration_ms": 1100,
                "axes": build_example_axes(axis_names, head_pitch=51, mouth_smile=52),
            },
        },
        {
            "input": "用户：太好了！终于通过了！\n助手：真棒，我们成功了！",
            "output": {
                "emotion": "joy",
                "mode": "expressive",
                "duration_ms": 1350,
                "axes": build_example_axes(
                    axis_names,
                    head_pitch=60,
                    body_pitch=58,
                    gaze_y=58,
                    eye_smile_left=82,
                    eye_smile_right=82,
                    mouth_smile=86,
                    brow_bias=68,
                ),
            },
        },
        {
            "input": "用户：我有点难过，今天状态不太好。\n助手：没关系，我们慢慢来。",
            "output": {
                "emotion": "sad",
                "mode": "expressive",
                "duration_ms": 1500,
                "axes": build_example_axes(
                    axis_names,
                    head_pitch=38,
                    gaze_y=34,
                    eye_open_left=40,
                    eye_open_right=40,
                    body_pitch=40,
                    mouth_smile=22,
                    brow_bias=30,
                ),
            },
        },
        {
            "input": "用户：你能对我眨一下眼吗？\n助手：当然可以，给你一个小小的 wink。",
            "output": {
                "emotion": "playful_wink",
                "mode": "expressive",
                "duration_ms": 900,
                "axes": build_example_axes(
                    axis_names,
                    head_roll=62,
                    gaze_x=56,
                    eye_open_left=18,
                    eye_open_right=100,
                    eye_smile_right=72,
                    mouth_smile=78,
                    mouth_x=58,
                    brow_bias=58,
                ),
            },
        },
        {
            "input": "用户：啊？你说这个现在就能用了？\n助手：是的，现在已经可用了。",
            "output": {
                "emotion": "surprised",
                "mode": "expressive",
                "duration_ms": 1200,
                "axes": build_example_axes(
                    axis_names,
                    head_pitch=62,
                    body_pitch=60,
                    gaze_y=64,
                    eye_open_left=100,
                    eye_open_right=100,
                    eye_smile_left=18,
                    eye_smile_right=18,
                    brow_bias=84,
                ),
            },
        },
    ]


CORE_EXAMPLE_CATEGORY_GROUPS: list[tuple[str, ...]] = [
    ("neutral",),
    ("happy",),
    ("angry",),
    ("surprised",),
    ("confused", "embarrassed"),
]


def resolve_selector_few_shot_examples(
    *,
    runtime_state: Any,
    default_examples: list[dict[str, Any]],
    normalize_emotion_key: Callable[[str], str],
    update_runtime_state: bool = True,
) -> list[dict[str, Any]]:
    enabled = bool(getattr(runtime_state, "realtime_motion_fewshot_enabled", True))
    if not enabled:
        if update_runtime_state and hasattr(runtime_state, "motion_tuning_fewshot_diagnostics"):
            runtime_state.motion_tuning_fewshot_diagnostics = []
        if update_runtime_state and hasattr(runtime_state, "motion_tuning_effective_examples"):
            runtime_state.motion_tuning_effective_examples = []
        return []

    count = int(getattr(runtime_state, "realtime_motion_fewshot_count", 4))
    count = max(0, count)
    if count == 0:
        if update_runtime_state and hasattr(runtime_state, "motion_tuning_fewshot_diagnostics"):
            runtime_state.motion_tuning_fewshot_diagnostics = []
        if update_runtime_state and hasattr(runtime_state, "motion_tuning_effective_examples"):
            runtime_state.motion_tuning_effective_examples = []
        return []

    user_examples = [
        item
        for item in getattr(runtime_state, "motion_tuning_reference_examples", [])
        if isinstance(item, dict)
    ]
    selected_user_examples = user_examples[:count]

    resolved_examples = list(selected_user_examples)
    seen_categories = {
        normalize_example_category_key(item, normalize_emotion_key=normalize_emotion_key)
        for item in resolved_examples
        if normalize_example_category_key(item, normalize_emotion_key=normalize_emotion_key)
    }

    remaining = max(0, count - len(resolved_examples))
    default_backfill = select_category_backfill_examples(
        candidates=default_examples,
        count=remaining,
        seen_categories=seen_categories,
        normalize_emotion_key=normalize_emotion_key,
    )
    resolved_examples.extend(default_backfill)

    diagnostics: list[str] = []
    if len(selected_user_examples) < count:
        diagnostics.append(
            "motion_tuning_user_samples_insufficient:"
            f"requested={count}:user_available={len(selected_user_examples)}"
        )
    if default_backfill:
        diagnostics.append(
            "motion_tuning_default_backfill_applied:"
            f"count={len(default_backfill)}"
        )
    if len(resolved_examples) < count:
        diagnostics.append(
            "motion_tuning_fewshot_final_shortage:"
            f"requested={count}:final_count={len(resolved_examples)}"
        )
    if update_runtime_state and hasattr(runtime_state, "motion_tuning_fewshot_diagnostics"):
        runtime_state.motion_tuning_fewshot_diagnostics = diagnostics
    if update_runtime_state and hasattr(runtime_state, "motion_tuning_effective_examples"):
        runtime_state.motion_tuning_effective_examples = list(resolved_examples)
    return resolved_examples


def select_category_backfill_examples(
    *,
    candidates: list[dict[str, Any]],
    count: int,
    seen_categories: set[str],
    normalize_emotion_key: Callable[[str], str],
) -> list[dict[str, Any]]:
    if count <= 0:
        return []

    normalized_candidates = [item for item in candidates if isinstance(item, dict)]
    selected: list[dict[str, Any]] = []
    local_seen = set(seen_categories)
    used_indexes: set[int] = set()

    for group in CORE_EXAMPLE_CATEGORY_GROUPS:
        if len(selected) >= count:
            break
        if any(category in local_seen for category in group):
            continue
        for index, item in enumerate(normalized_candidates):
            if index in used_indexes:
                continue
            category = normalize_example_category_key(
                item,
                normalize_emotion_key=normalize_emotion_key,
            )
            if category in group:
                selected.append(item)
                used_indexes.add(index)
                if category:
                    local_seen.add(category)
                break

    if len(selected) >= count:
        return selected[:count]

    for index, item in enumerate(normalized_candidates):
        if index in used_indexes:
            continue
        category = normalize_example_category_key(
            item,
            normalize_emotion_key=normalize_emotion_key,
        )
        if category and category in local_seen:
            continue
        selected.append(item)
        used_indexes.add(index)
        if category:
            local_seen.add(category)
        if len(selected) >= count:
            break
    return selected[:count]


def normalize_example_category_key(
    example: dict[str, Any],
    *,
    normalize_emotion_key: Callable[[str], str],
) -> str:
    output = example.get("output")
    if not isinstance(output, dict):
        return ""
    return normalize_emotion_key(str(output.get("emotion") or "").strip())
