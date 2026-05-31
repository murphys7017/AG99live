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
            "input": (
                "场景：用户确认收到信息，助手只做短确认。参考旧动作：默认待机/平和。"
                "抽象方式：剔除呼吸、物理、头发和附件曲线，只保留接近中性的头部轻点与嘴角轻微友好；"
                "不要把 idle 误做成完全静止。"
            ),
            "output": {
                "emotion": "neutral",
                "mode": "idle",
                "duration_ms": 1100,
                "axes": build_example_axes(
                    axis_names,
                    head_pitch=52,
                    gaze_y=51,
                    mouth_smile=52,
                ),
            },
        },
        {
            "input": (
                "场景：助手认真说明一件事，语气稳定但不是无动作。参考旧动作：认真说明/温和点头。"
                "抽象方式：保留头部朝向、轻微点头、上身随头部同向的可读骨架；剔除手、头发、物理和口型运行时曲线。"
                "说明类动作应像进入解释状态，而不是随便给几个接近 50 的表情数。"
            ),
            "output": {
                "emotion": "explain",
                "mode": "idle",
                "duration_ms": 1250,
                "axes": build_example_axes(
                    axis_names,
                    head_yaw=58,
                    head_pitch=55,
                    body_yaw=56,
                    body_pitch=53,
                    gaze_x=55,
                ),
            },
        },
        {
            "input": (
                "场景：助手安抚用户或表示理解。参考旧动作：温和点头/感到舒适/温和摇晃。"
                "抽象方式：保留下沉的头部、柔和侧倾和身体跟随，嘴角只作为温和细节；"
                "不要混入强开心、惊讶后缩或生气前倾这类互斥动作。"
            ),
            "output": {
                "emotion": "soothe",
                "mode": "expressive",
                "duration_ms": 1400,
                "axes": build_example_axes(
                    axis_names,
                    head_pitch=42,
                    head_roll=44,
                    body_roll=43,
                    body_pitch=42,
                    gaze_y=40,
                    mouth_smile=58,
                ),
            },
        },
        {
            "input": (
                "场景：助手没听懂、怀疑前提或追问。参考旧动作：困惑歪头/左右晃动/怀疑眯眼。"
                "抽象方式：保留歪头、躯体侧倾、侧向视线和眉眼审视；"
                "不要把疑惑简化成单个 brow 数值，也不要复用开心轻晃的节奏。"
            ),
            "output": {
                "emotion": "confused",
                "mode": "expressive",
                "duration_ms": 1050,
                "axes": build_example_axes(
                    axis_names,
                    head_roll=64,
                    body_roll=61,
                    gaze_x=42,
                    brow_bias=58,
                ),
            },
        },
        {
            "input": (
                "场景：助手给出正向反馈、满意或轻松调侃。参考旧动作：微笑/开心轻晃/微笑左偏头/歪头坏笑。"
                "抽象方式：保留抬头、身体轻晃或偏头、笑眼和嘴角；调侃时可加一点非对称头身倾斜。"
                "开心不是只提高 mouth_smile，头身也要承担动作骨架。"
            ),
            "output": {
                "emotion": "happy",
                "mode": "expressive",
                "duration_ms": 1200,
                "axes": build_example_axes(
                    axis_names,
                    head_pitch=62,
                    head_roll=58,
                    body_roll=59,
                    body_pitch=61,
                    eye_smile_left=78,
                    eye_smile_right=78,
                    mouth_smile=84,
                ),
            },
        },
        {
            "input": (
                "场景：助手被意外消息打断、突然反应或强调结果很出乎意料。参考旧动作：惊讶/惊讶后缩。"
                "抽象方式：保留抬头、睁眼、视线上扬和身体后缩/挺起；"
                "不要同时混入温和点头或舒适放松，因为它们和惊讶后缩在语义上互斥。"
            ),
            "output": {
                "emotion": "surprised",
                "mode": "expressive",
                "duration_ms": 1150,
                "axes": build_example_axes(
                    axis_names,
                    head_pitch=63,
                    body_pitch=64,
                    body_roll=58,
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
