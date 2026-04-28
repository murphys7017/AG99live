from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AxisSpec:
    name: str
    channel: str
    low_label: str
    mid_label: str
    high_label: str


AXES: list[AxisSpec] = [
    AxisSpec("head_yaw", "head_yaw", "turn left", "center", "turn right"),
    AxisSpec("head_roll", "head_roll", "tilt left", "center", "tilt right"),
    AxisSpec("head_pitch", "head_pitch", "look down", "center", "look up"),
    AxisSpec("body_yaw", "body_yaw", "twist left", "center", "twist right"),
    AxisSpec("body_roll", "body_roll", "lean left", "center", "lean right"),
    AxisSpec("gaze_x", "gaze_x", "look left", "center", "look right"),
    AxisSpec("gaze_y", "gaze_y", "look down", "center", "look up"),
    AxisSpec("eye_open_left", "eye_open_left", "closed", "normal", "wide open"),
    AxisSpec("eye_open_right", "eye_open_right", "closed", "normal", "wide open"),
    AxisSpec("mouth_open", "mouth_open", "closed", "normal", "open"),
    AxisSpec("mouth_smile", "mouth_smile", "frown", "neutral", "smile"),
    AxisSpec("brow_bias", "brow_bias", "frown", "neutral", "raised"),
]
AXIS_NAMES = [axis.name for axis in AXES]

MOTION_SELECTOR_SYSTEM_PROMPT = (
    "You are a Live2D motion intent selector, not a chat assistant. "
    "Read the finished dialog turn and return one strict JSON object only. "
    "Do not answer the user, do not add Markdown, and do not explain."
)

DEFAULT_SELECTOR_PLATFORM_DESCRIPTION = (
    "Source platform: AstrBot through AG99live desktop adapter.\n"
    "Interaction pattern: one user sends short text/voice turns and expects immediate assistant replies.\n"
    "Avatar behavior goal: natural and readable facial/head cues that support the turn meaning.\n"
    "Execution constraint: downstream playback directly writes Live2D parameters frame-by-frame.\n"
    "Preference: when emotion is non-neutral, use clearly readable amplitudes instead of near-center no-op values."
)

DEFAULT_MOTION_PROMPT_INSTRUCTION = (
    "根据主回复的真实语气选择动作。中性、说明性回复可以使用 idle 或小幅动作；开心、惊讶、撒娇、调侃、道歉等明确情绪再使用 expressive。"
    "优先控制头部、视线、wink、嘴部笑意和眉毛；mouth_open 只作为可选的口型微调，不要替代运行时口型同步。"
)


def _build_example_axes(**overrides: int) -> dict[str, int]:
    axes: dict[str, int] = {}
    for key, value in overrides.items():
        if key not in AXIS_NAMES:
            continue
        try:
            number = int(round(float(value)))
        except (TypeError, ValueError):
            number = 50
        axes[key] = max(0, min(100, number))
    return axes


DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES: list[dict[str, Any]] = [
    {
        "input": "User: 嗯，我知道了。\nAssistant: 好的，我们继续下一步。",
        "output": {
            "emotion": "neutral",
            "mode": "idle",
            "duration_ms": 1100,
            "axes": _build_example_axes(head_pitch=51, mouth_smile=52),
        },
    },
    {
        "input": "User: 太好了！终于通过了！\nAssistant: 真棒，我们成功了！",
        "output": {
            "emotion": "joy",
            "mode": "expressive",
            "duration_ms": 1350,
            "axes": _build_example_axes(
                head_pitch=60,
                gaze_y=58,
                mouth_smile=86,
                brow_bias=68,
            ),
        },
    },
    {
        "input": "User: 我有点难过，今天状态不太好。\nAssistant: 没关系，我们慢慢来。",
        "output": {
            "emotion": "sad",
            "mode": "expressive",
            "duration_ms": 1500,
            "axes": _build_example_axes(
                head_pitch=38,
                gaze_y=34,
                eye_open_left=40,
                eye_open_right=40,
                mouth_smile=22,
                brow_bias=30,
            ),
        },
    },
    {
        "input": "User: 你能对我眨一下眼吗？\nAssistant: 当然可以，给你一个小小的 wink。",
        "output": {
            "emotion": "playful_wink",
            "mode": "expressive",
            "duration_ms": 900,
            "axes": _build_example_axes(
                head_roll=62,
                gaze_x=56,
                eye_open_left=18,
                eye_open_right=100,
                mouth_smile=78,
                brow_bias=58,
            ),
        },
    },
    {
        "input": "User: 啊？你说这个现在就能用了？\nAssistant: 是的，现在已经可用了。",
        "output": {
            "emotion": "surprised",
            "mode": "expressive",
            "duration_ms": 1200,
            "axes": _build_example_axes(
                head_pitch=62,
                gaze_y=64,
                eye_open_left=100,
                eye_open_right=100,
                mouth_smile=58,
                brow_bias=84,
            ),
        },
    },
]


def build_selector_platform_context(*, runtime_state: Any) -> str:
    enabled = bool(getattr(runtime_state, "realtime_motion_platform_context_enabled", True))
    if not enabled:
        return ""

    custom_description = str(
        getattr(runtime_state, "realtime_motion_platform_description", "") or ""
    ).strip()
    if custom_description:
        return truncate_prompt_text(custom_description, 720)

    platform_config = getattr(runtime_state, "platform_config", {})
    adapter_alias = "AG99live Desktop"
    if isinstance(platform_config, dict):
        configured_alias = str(platform_config.get("conf_name") or "").strip()
        if configured_alias:
            adapter_alias = configured_alias

    client_uid = str(getattr(runtime_state, "client_uid", "") or "").strip() or "desktop-client"
    return (
        f"{DEFAULT_SELECTOR_PLATFORM_DESCRIPTION}\n"
        f"Adapter alias: {adapter_alias}.\n"
        f"Session target: {client_uid}."
    )


def resolve_selector_few_shot_examples(*, runtime_state: Any) -> list[dict[str, Any]]:
    enabled = bool(getattr(runtime_state, "realtime_motion_fewshot_enabled", True))
    if not enabled:
        return []

    user_examples = [
        item
        for item in getattr(runtime_state, "motion_tuning_reference_examples", [])
        if isinstance(item, dict)
    ][:5]
    max_count = len(DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES)
    count_raw = getattr(runtime_state, "realtime_motion_fewshot_count", 4)
    try:
        count = int(round(float(count_raw)))
    except (TypeError, ValueError):
        count = 4
    count = max(0, min(count, max_count))
    default_examples = DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES[:count] if count else []
    return [*user_examples, *default_examples][: max(5, count)]


def resolve_motion_prompt_instruction(*, runtime_state: Any) -> str:
    raw_value = str(getattr(runtime_state, "motion_prompt_instruction", "") or "").strip()
    if not raw_value:
        return DEFAULT_MOTION_PROMPT_INSTRUCTION
    return truncate_prompt_text(raw_value, 800)


def profile_prompt_axes(semantic_profile: dict[str, Any]) -> list[dict[str, Any]]:
    axes = semantic_profile.get("axes")
    if not isinstance(axes, list):
        raise ValueError("semantic_profile_axes_not_list")

    result: list[dict[str, Any]] = []
    for axis in axes:
        if not isinstance(axis, dict):
            continue
        role = str(axis.get("control_role") or "").strip()
        if role not in {"primary", "hint"}:
            continue
        axis_id = str(axis.get("id") or "").strip()
        if not axis_id:
            continue
        result.append(axis)
    if not result:
        raise ValueError("semantic_profile_has_no_prompt_axes")
    return result


def build_selector_context(
    *,
    user_text: str,
    assistant_text: str,
    platform_context: str = "",
) -> str:
    user = (user_text or "").strip()
    assistant = (assistant_text or "").strip()
    normalized_platform_context = (platform_context or "").strip()
    prefix = ""
    if normalized_platform_context:
        prefix = (
            "Platform context:\n"
            f"{truncate_prompt_text(normalized_platform_context, 760)}\n\n"
        )

    if user and assistant:
        return prefix + (
            "Generate expression controls for this dialog turn.\n"
            f"User: {truncate_prompt_text(user, 260)}\n"
            f"Assistant: {truncate_prompt_text(assistant, 320)}"
        )
    if assistant:
        return prefix + truncate_prompt_text(assistant, 360)
    return prefix + truncate_prompt_text(user, 360)


def build_selector_user_prompt(
    text: str,
    *,
    few_shot_examples: list[dict[str, Any]] | None = None,
    motion_instruction: str = "",
    semantic_profile: dict[str, Any] | None = None,
) -> str:
    if semantic_profile is not None:
        return build_selector_user_prompt_v2(
            text,
            few_shot_examples=few_shot_examples,
            motion_instruction=motion_instruction,
            semantic_profile=semantic_profile,
        )

    lines: list[str] = []
    for axis in AXES:
        lines.append(
            f"- {axis.name}: 0={axis.low_label}, 50={axis.mid_label}, 100={axis.high_label}"
        )
    axis_block = "\n".join(lines)
    few_shot_block = _build_few_shot_block(
        few_shot_examples=few_shot_examples,
        input_limit=560,
        header="Few-shot examples (style reference, do not copy literally):",
        output_label="output JSON",
    )
    motion_instruction_block = _build_motion_instruction_block(motion_instruction)

    return (
        "Given text, choose axis values in [0,100] for an avatar.\n"
        "Platform and task:\n"
        "- AG99live drives a Live2D avatar during an AstrBot chat turn.\n"
        "- Your job is to select expression/control values that support the finished assistant reply.\n"
        "- Do not generate chat text; only generate the control JSON.\n\n"
        f"Available parameters:\n{axis_block}\n\n"
        "Return requirement:\n"
        "Return one JSON object only with this schema:\n"
        "{\n"
        '  "emotion": "short-label",\n'
        '  "mode": "idle or expressive",\n'
        '  "duration_ms": 1200,\n'
        '  "axes": {\n'
        '    "head_yaw": 50, "head_roll": 50, "head_pitch": 50,\n'
        '    "body_yaw": 50, "body_roll": 50,\n'
        '    "gaze_x": 50, "gaze_y": 50,\n'
        '    "eye_open_left": 50, "eye_open_right": 50,\n'
        '    "mouth_open": 50, "mouth_smile": 50, "brow_bias": 50\n'
        '  }\n'
        "}\n"
        "Generation rules:\n"
        "- Include all listed axes.\n"
        "- Use integers only.\n"
        "- Use mode=idle for neutral, explanatory, or low-affect replies; use mode=expressive for clear emotion or intentional gesture.\n"
        "- Choose values by semantic fit, not by matching a fixed action list.\n"
        "- Keep values stable and readable; avoid chaotic extremes.\n\n"
        f"{motion_instruction_block}"
        f"{few_shot_block}"
        f"Text: {text}"
    )


def build_selector_user_prompt_v2(
    text: str,
    *,
    few_shot_examples: list[dict[str, Any]] | None = None,
    motion_instruction: str = "",
    semantic_profile: dict[str, Any],
) -> str:
    prompt_axes = profile_prompt_axes(semantic_profile)
    axis_block = "\n".join(_format_profile_axis_prompt_line(axis) for axis in prompt_axes)
    allowed_axis_ids = [str(axis.get("id") or "").strip() for axis in prompt_axes]
    profile_id = str(semantic_profile.get("profile_id") or "").strip()
    model_id = str(semantic_profile.get("model_id") or "").strip()
    revision = semantic_profile.get("revision")

    few_shot_block = _build_few_shot_block(
        few_shot_examples=few_shot_examples,
        input_limit=420,
        header=(
            "Few-shot examples are style references only. Convert their idea to the current axes; "
            "do not copy unknown axis names."
        ),
        output_label="reference output",
        limit=3,
    )
    motion_instruction_block = _build_motion_instruction_block(motion_instruction)

    return (
        "Given text, choose semantic axis values for a Live2D avatar.\n"
        "Platform and task:\n"
        "- AG99live drives a Live2D avatar during an AstrBot chat turn.\n"
        "- The main LLM has already produced the assistant reply; your job is to translate the turn into semantic control parameters.\n"
        "- Do not generate chat text, explanations, Markdown, or extra fields.\n\n"
        f"Profile: profile_id={profile_id}, model_id={model_id}, revision={revision}.\n"
        "Available parameters:\n"
        "- Only output axes listed below.\n"
        "- Each parameter line includes id, label, role, numeric range, neutral value, direction semantics, and usage notes.\n"
        "- Use primary axes for core expression; use hint axes for details such as asymmetric eye openness, brow nuance, or small accents.\n"
        "- Never output derived/runtime/ambient/debug axes, and do not invent axis names.\n"
        f"{axis_block}\n\n"
        "Return requirement:\n"
        "Return one JSON object only with this schema:\n"
        "{\n"
        '  "emotion": "short-label",\n'
        '  "mode": "idle or expressive",\n'
        '  "duration_ms": 1200,\n'
        '  "axes": {\n'
        f'    "{allowed_axis_ids[0]}": 50\n'
        "  }\n"
        "}\n"
        "Generation rules:\n"
        "- Use mode=idle for neutral, explanatory, or low-affect replies; use mode=expressive only when the assistant text carries a clear emotion or intentional gesture.\n"
        "- Output 1 to 4 relevant axes in normal cases; fewer is better than unrelated motion.\n"
        "- Use numbers only, inside each axis range.\n"
        "- Choose parameters by interpreting the parameter meanings and the dialog context; do not treat examples or named gestures as a closed set of choices.\n"
        "- Smile intensity should mainly use mouth_smile when available: slight smile roughly 58-68, clear happy smile roughly 72-88, playful/teasing smile roughly 65-82 with optional head/gaze/brow nuance.\n"
        "- Wink or asymmetric eye details may use eye_open axes when available, but infer the side and strength from dialog meaning, head/gaze direction, and examples instead of following a fixed template.\n"
        "- mouth_open is optional and secondary when available; use it only for small expression/lip-shape adjustment, not as primary speech animation.\n"
        "- Keep values stable and readable; avoid chaotic extremes.\n\n"
        f"{motion_instruction_block}"
        f"{few_shot_block}"
        f"Text: {text}"
    )


def _build_few_shot_block(
    *,
    few_shot_examples: list[dict[str, Any]] | None,
    input_limit: int,
    header: str,
    output_label: str,
    limit: int | None = None,
) -> str:
    normalized_examples = [item for item in (few_shot_examples or []) if isinstance(item, dict)]
    if not normalized_examples:
        return ""
    if limit is not None:
        normalized_examples = normalized_examples[:limit]

    few_shot_lines = [header]
    for index, item in enumerate(normalized_examples, start=1):
        input_text = truncate_prompt_text(str(item.get("input") or "").strip(), input_limit)
        output_payload = item.get("output")
        output_json = json.dumps(
            output_payload if isinstance(output_payload, dict) else {},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        few_shot_lines.append(f"Example {index} input:\n{input_text}")
        few_shot_lines.append(f"Example {index} {output_label}:\n{output_json}")
    return "\n".join(few_shot_lines) + "\n\n"


def _build_motion_instruction_block(motion_instruction: str) -> str:
    motion_instruction_text = str(motion_instruction or "").strip()
    if not motion_instruction_text:
        return ""
    return (
        "Additional motion instruction:\n"
        f"{truncate_prompt_text(motion_instruction_text, 800)}\n\n"
    )


def _format_axis_semantics(values: Any) -> str:
    if not isinstance(values, list):
        return ""
    return ", ".join(
        truncate_prompt_text(str(item).strip(), 48)
        for item in values
        if str(item).strip()
    )


def _format_profile_axis_prompt_line(axis: dict[str, Any]) -> str:
    axis_id = str(axis.get("id") or "").strip()
    label = str(axis.get("label") or axis_id).strip()
    role = str(axis.get("control_role") or "").strip()
    neutral = axis.get("neutral", 50)
    value_range = axis.get("value_range")
    range_text = "[0,100]"
    if (
        isinstance(value_range, list)
        and len(value_range) == 2
        and isinstance(value_range[0], (int, float))
        and isinstance(value_range[1], (int, float))
    ):
        range_text = f"[{float(value_range[0]):g},{float(value_range[1]):g}]"
    negative = _format_axis_semantics(axis.get("negative_semantics")) or "negative direction"
    positive = _format_axis_semantics(axis.get("positive_semantics")) or "positive direction"
    notes = truncate_prompt_text(str(axis.get("usage_notes") or "").strip(), 160)
    description = truncate_prompt_text(str(axis.get("description") or "").strip(), 160)
    suffix = f" notes={notes}" if notes else ""
    return (
        f"- {axis_id} ({label}, role={role}, range={range_text}, neutral={neutral}): "
        f"low={negative}; high={positive}. {description}{suffix}"
    ).strip()


def truncate_prompt_text(value: str, max_chars: int) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."
