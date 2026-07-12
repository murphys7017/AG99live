from __future__ import annotations

from collections.abc import Callable
from typing import Any


def build_example_axis_levels(axis_names: list[str], **overrides: int) -> dict[str, int]:
    levels: dict[str, int] = {}
    for key, value in overrides.items():
        if key not in axis_names:
            continue
        if not isinstance(value, int) or isinstance(value, bool) or not -4 <= value <= 4:
            raise ValueError(f"motion_reference_example_axis_level_invalid:{key}")
        levels[key] = value
    return levels


def create_default_motion_reference_examples(axis_names: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "category": "neutral",
            "input": (
                "场景：用户确认收到信息，助手只做短确认。参考旧动作：默认待机/平和。"
                "抽象方式：剔除呼吸、物理、头发和附件曲线，只保留接近中性的头部轻点与嘴角轻微友好；"
                "不要把 idle 误做成完全静止。"
            ),
            "output": {
                "intent_tags": ["平和", "简短确认"],
                "duration_hint_ms": 1100,
                "axis_levels": build_example_axis_levels(
                    axis_names,
                    head_pitch=-3,
                    mouth_smile=2,
                ),
            },
        },
        {
            "category": "explain",
            "input": (
                "场景：助手认真说明一件事，语气稳定但不是无动作。参考旧动作：认真说明/温和点头。"
                "抽象方式：保留头部朝向、轻微点头、上身随头部同向的可读骨架；剔除手、头发、物理和口型运行时曲线。"
                "说明类动作应像进入解释状态，而不是随便给几个接近 50 的表情数。"
            ),
            "output": {
                "intent_tags": ["认真说明", "稳定强调"],
                "duration_hint_ms": 1250,
                "axis_levels": build_example_axis_levels(
                    axis_names,
                    head_yaw=3,
                    head_pitch=3,
                    gaze_x=3,
                    brow_bias=2,
                ),
            },
        },
        {
            "category": "soothe",
            "input": (
                "场景：助手安抚用户或表示理解。参考旧动作：温和点头/感到舒适/温和摇晃。"
                "抽象方式：保留下沉的头部、柔和侧倾和身体跟随，嘴角只作为温和细节；"
                "不要混入强开心、惊讶后缩或生气前倾这类互斥动作。"
            ),
            "output": {
                "intent_tags": ["安抚", "理解", "柔和"],
                "duration_hint_ms": 1400,
                "axis_levels": build_example_axis_levels(
                    axis_names,
                    head_pitch=-3,
                    head_roll=-3,
                    gaze_y=-2,
                    mouth_smile=2,
                ),
            },
        },
        {
            "category": "confused",
            "input": (
                "场景：助手没听懂、怀疑前提或追问。参考旧动作：困惑歪头/左右晃动/怀疑眯眼。"
                "抽象方式：保留歪头、躯体侧倾、侧向视线和眉眼审视；"
                "不要把疑惑简化成单个 brow 数值，也不要复用开心轻晃的节奏。"
            ),
            "output": {
                "intent_tags": ["疑惑", "审视", "追问"],
                "duration_hint_ms": 1050,
                "axis_levels": build_example_axis_levels(
                    axis_names,
                    head_roll=3,
                    gaze_x=-3,
                    brow_bias=3,
                ),
            },
        },
        {
            "category": "happy",
            "input": (
                "场景：助手给出正向反馈、满意或轻松调侃。参考旧动作：微笑/开心轻晃/微笑左偏头/歪头坏笑。"
                "抽象方式：保留抬头、身体轻晃或偏头、笑眼和嘴角；调侃时可加一点非对称头身倾斜。"
                "开心不是只提高 mouth_smile，头身也要承担动作骨架。"
            ),
            "output": {
                "intent_tags": ["开心", "满意", "轻松调侃"],
                "duration_hint_ms": 1200,
                "axis_levels": build_example_axis_levels(
                    axis_names,
                    head_pitch=3,
                    head_roll=3,
                    eye_smile_left=4,
                    eye_smile_right=4,
                    mouth_smile=4,
                ),
            },
        },
        {
            "category": "surprised",
            "input": (
                "场景：助手被意外消息打断、突然反应或强调结果很出乎意料。参考旧动作：惊讶/惊讶后缩。"
                "抽象方式：保留抬头、睁眼、视线上扬和身体后缩/挺起；"
                "不要同时混入温和点头或舒适放松，因为它们和惊讶后缩在语义上互斥。"
            ),
            "output": {
                "intent_tags": ["惊讶", "意外", "明显后缩"],
                "duration_hint_ms": 1150,
                "axis_levels": build_example_axis_levels(
                    axis_names,
                    head_pitch=4,
                    body_pitch=4,
                    gaze_y=4,
                    brow_bias=4,
                ),
            },
        },
        {
            "category": "sequence",
            "input": (
                "场景：用户明确要求角色先看向左侧、再看向右侧，最后回到正面。"
                "这是连续动作，不要拆成多个 effect call；各步骤保持同一组轴并用 duration_weight 表达节奏。"
            ),
            "output": {
                "intent_tags": ["左右确认", "连续动作", "回到正面"],
                "duration_hint_ms": 1800,
                "motion_steps": [
                    {
                        "axis_levels": build_example_axis_levels(
                            axis_names,
                            head_yaw=-3,
                            gaze_x=-3,
                        ),
                        "duration_weight": 2,
                    },
                    {
                        "axis_levels": build_example_axis_levels(
                            axis_names,
                            head_yaw=3,
                            gaze_x=3,
                        ),
                        "duration_weight": 2,
                    },
                    {
                        "axis_levels": build_example_axis_levels(
                            axis_names,
                            head_yaw=0,
                            gaze_x=0,
                        ),
                        "duration_weight": 1,
                    },
                ],
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
    ("sequence",),
]

REQUIRED_STRUCTURE_EXAMPLE_CATEGORIES = (
    "explain",
    "surprised",
    "sequence",
)


def resolve_motion_reference_examples(
    *,
    runtime_state: Any,
    default_examples: list[dict[str, Any]],
    normalize_emotion_key: Callable[[str], str],
    update_runtime_state: bool = True,
) -> list[dict[str, Any]]:
    enabled = bool(getattr(runtime_state, "motion_tuning_fewshot_enabled", True))
    if not enabled:
        if update_runtime_state and hasattr(runtime_state, "motion_tuning_fewshot_diagnostics"):
            runtime_state.motion_tuning_fewshot_diagnostics = []
        if update_runtime_state and hasattr(runtime_state, "motion_tuning_effective_examples"):
            runtime_state.motion_tuning_effective_examples = []
        return []

    count = int(getattr(runtime_state, "motion_tuning_fewshot_count", 2))
    count = max(0, count)
    if count == 0:
        if update_runtime_state and hasattr(runtime_state, "motion_tuning_fewshot_diagnostics"):
            runtime_state.motion_tuning_fewshot_diagnostics = []
        if update_runtime_state and hasattr(runtime_state, "motion_tuning_effective_examples"):
            runtime_state.motion_tuning_effective_examples = []
        return []
    if count < len(REQUIRED_STRUCTURE_EXAMPLE_CATEGORIES):
        raise ValueError(
            "motion_reference_example_budget_below_required:"
            f"count={count}:required={len(REQUIRED_STRUCTURE_EXAMPLE_CATEGORIES)}"
        )

    raw_user_examples = [
        item
        for item in getattr(runtime_state, "motion_tuning_reference_examples", [])
        if isinstance(item, dict)
    ]
    required_examples = select_required_structure_examples(
        candidates=default_examples,
        count=count,
        normalize_emotion_key=normalize_emotion_key,
    )
    user_capacity = max(0, count - len(required_examples))
    user_example_count = int(getattr(runtime_state, "motion_tuning_user_fewshot_count", 0))
    user_example_count = max(0, min(user_capacity, user_example_count))
    selected_user_examples = raw_user_examples[:user_example_count]

    resolved_examples = list(selected_user_examples)
    seen_categories = {
        normalize_example_category_key(item, normalize_emotion_key=normalize_emotion_key)
        for item in resolved_examples
        if normalize_example_category_key(item, normalize_emotion_key=normalize_emotion_key)
    }

    for item in required_examples:
        category = normalize_example_category_key(
            item,
            normalize_emotion_key=normalize_emotion_key,
        )
        resolved_examples.append(item)
        if category:
            seen_categories.add(category)

    remaining = max(0, count - len(resolved_examples))
    default_backfill = select_category_backfill_examples(
        candidates=default_examples,
        count=remaining,
        seen_categories=seen_categories,
        normalize_emotion_key=normalize_emotion_key,
    )
    resolved_examples.extend(default_backfill)

    diagnostics: list[str] = []
    if len(selected_user_examples) < user_example_count:
        diagnostics.append(
            "motion_tuning_user_samples_insufficient:"
            f"requested={user_example_count}:user_available={len(raw_user_examples)}:"
            f"user_selected={len(selected_user_examples)}"
        )
    default_example_count = len(required_examples) + len(default_backfill)
    if default_example_count:
        diagnostics.append(
            "motion_tuning_default_backfill_applied:"
            f"count={default_example_count}"
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


def select_required_structure_examples(
    *,
    candidates: list[dict[str, Any]],
    count: int,
    normalize_emotion_key: Callable[[str], str],
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for required_category in REQUIRED_STRUCTURE_EXAMPLE_CATEGORIES:
        if len(selected) >= count:
            break
        match = next(
            (
                item
                for item in candidates
                if isinstance(item, dict)
                and normalize_example_category_key(
                    item,
                    normalize_emotion_key=normalize_emotion_key,
                )
                == required_category
            ),
            None,
        )
        if match is None:
            raise ValueError(
                "motion_reference_required_example_missing:"
                f"{required_category}"
            )
        selected.append(match)
    return selected


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
    category = str(example.get("category") or "").strip()
    if category:
        return normalize_emotion_key(category)
    output = example.get("output")
    if not isinstance(output, dict):
        return ""
    tags = output.get("intent_tags")
    if isinstance(tags, list) and tags:
        return normalize_emotion_key(str(tags[0] or "").strip())
    return normalize_emotion_key(str(output.get("emotion") or "").strip())
