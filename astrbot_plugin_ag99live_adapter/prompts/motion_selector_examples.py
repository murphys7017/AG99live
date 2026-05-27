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
            "input": "场景：用户确认收到信息，助手简短确认并继续。",
            "output": {
                "emotion": "neutral",
                "mode": "idle",
                "duration_ms": 1100,
                "axes": build_example_axes(axis_names, head_pitch=51, mouth_smile=52),
            },
        },
        {
            "input": "场景：助手在平静解释或说明，不需要明显情绪，只要有轻微朝向和关注感。",
            "output": {
                "emotion": "explain",
                "mode": "idle",
                "duration_ms": 1250,
                "axes": build_example_axes(
                    axis_names,
                    head_pitch=54,
                    gaze_y=53,
                    mouth_smile=54,
                ),
            },
        },
        {
            "input": "场景：助手温和安抚用户，语气柔和，动作应收敛但可见。",
            "output": {
                "emotion": "soothe",
                "mode": "expressive",
                "duration_ms": 1400,
                "axes": build_example_axes(
                    axis_names,
                    head_pitch=42,
                    body_pitch=44,
                    gaze_y=40,
                    mouth_smile=58,
                ),
            },
        },
        {
            "input": "场景：助手对当前说法略带疑惑或追问，应以头部和视线表达轻微困惑。",
            "output": {
                "emotion": "confused",
                "mode": "expressive",
                "duration_ms": 1050,
                "axes": build_example_axes(
                    axis_names,
                    head_roll=60,
                    gaze_x=42,
                    brow_bias=58,
                ),
            },
        },
        {
            "input": "场景：助手明确强调结果、表达开心反馈或明显惊讶时，动作可以更清晰。",
            "output": {
                "emotion": "happy",
                "mode": "expressive",
                "duration_ms": 1200,
                "axes": build_example_axes(
                    axis_names,
                    head_pitch=62,
                    body_pitch=58,
                    eye_smile_left=78,
                    eye_smile_right=78,
                    mouth_smile=84,
                ),
            },
        },
        {
            "input": "场景：助手对结果感到明显惊讶或强调“现在就可以”，动作应更开、更抬、更醒目。",
            "output": {
                "emotion": "surprised",
                "mode": "expressive",
                "duration_ms": 1150,
                "axes": build_example_axes(
                    axis_names,
                    head_pitch=63,
                    gaze_y=64,
                    eye_open_left=88,
                    eye_open_right=88,
                    brow_bias=76,
                ),
            },
        },
    ]


CORE_EXAMPLE_CATEGORY_GROUPS: list[tuple[str, ...]] = [
    ("neutral",),
    ("explain",),
    ("soothe",),
    ("confused",),
    ("happy",),
    ("surprised",),
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

    count = int(getattr(runtime_state, "realtime_motion_fewshot_count", 2))
    count = max(0, count)
    if count == 0:
        if update_runtime_state and hasattr(runtime_state, "motion_tuning_fewshot_diagnostics"):
            runtime_state.motion_tuning_fewshot_diagnostics = []
        if update_runtime_state and hasattr(runtime_state, "motion_tuning_effective_examples"):
            runtime_state.motion_tuning_effective_examples = []
        return []

    raw_user_examples = [
        item
        for item in getattr(runtime_state, "motion_tuning_reference_examples", [])
        if isinstance(item, dict)
    ]
    user_example_count = int(getattr(runtime_state, "realtime_motion_user_fewshot_count", 0))
    user_example_count = max(0, min(count, user_example_count))
    selected_user_examples = raw_user_examples[:user_example_count]

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
            f"requested={count}:user_available={len(raw_user_examples)}:"
            f"user_selected={len(selected_user_examples)}"
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
