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
    AxisSpec("head_yaw", "head_yaw", "向左转头", "居中", "向右转头"),
    AxisSpec("head_roll", "head_roll", "向左歪头", "居中", "向右歪头"),
    AxisSpec("head_pitch", "head_pitch", "低头", "居中", "抬头"),
    AxisSpec("body_yaw", "body_yaw", "身体向左转", "居中", "身体向右转"),
    AxisSpec("body_roll", "body_roll", "身体左倾", "居中", "身体右倾"),
    AxisSpec("gaze_x", "gaze_x", "看向左侧", "居中", "看向右侧"),
    AxisSpec("gaze_y", "gaze_y", "看向下方", "居中", "看向上方"),
    AxisSpec("eye_open_left", "eye_open_left", "闭眼", "正常睁眼", "睁大"),
    AxisSpec("eye_open_right", "eye_open_right", "闭眼", "正常睁眼", "睁大"),
    AxisSpec("mouth_open", "mouth_open", "闭嘴", "正常", "张嘴"),
    AxisSpec("mouth_smile", "mouth_smile", "不开心/嘴角下压", "中性", "微笑"),
    AxisSpec("brow_bias", "brow_bias", "皱眉/压眉", "中性", "挑眉/抬眉"),
]
AXIS_NAMES = [axis.name for axis in AXES]

MOTION_SELECTOR_SYSTEM_PROMPT = (
    "你是 Live2D 表情动作参数生成器，不是聊天助手。"
    "阅读已经完成的本轮对话，只返回一个严格 JSON 对象。"
    "不要回复用户，不要输出 Markdown，不要解释。"
)

DEFAULT_SELECTOR_PLATFORM_DESCRIPTION = (
    "场景：用户正在和一个由 Live2D 角色承载的助手对话。\n"
    "交互模式：用户以短文本或语音进行单轮输入，并期待助手快速回应。\n"
    "角色表现目标：用自然、可读的面部、头部和视线变化支撑回复语气。\n"
    "播放方式：你输出的数值会直接用于驱动角色动作，所以要稳定、克制、可理解。\n"
    "偏好：当情绪不是中性时，使用清晰可见的幅度，避免接近中位的无效动作。"
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
        "input": "用户：嗯，我知道了。\n助手：好的，我们继续下一步。",
        "output": {
            "emotion": "neutral",
            "mode": "idle",
            "duration_ms": 1100,
            "axes": _build_example_axes(head_pitch=51, mouth_smile=52),
        },
    },
    {
        "input": "用户：太好了！终于通过了！\n助手：真棒，我们成功了！",
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
        "input": "用户：我有点难过，今天状态不太好。\n助手：没关系，我们慢慢来。",
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
        "input": "用户：你能对我眨一下眼吗？\n助手：当然可以，给你一个小小的 wink。",
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
        "input": "用户：啊？你说这个现在就能用了？\n助手：是的，现在已经可用了。",
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

    return DEFAULT_SELECTOR_PLATFORM_DESCRIPTION


def resolve_selector_few_shot_examples(*, runtime_state: Any) -> list[dict[str, Any]]:
    enabled = bool(getattr(runtime_state, "realtime_motion_fewshot_enabled", True))
    if not enabled:
        if hasattr(runtime_state, "motion_tuning_fewshot_diagnostics"):
            runtime_state.motion_tuning_fewshot_diagnostics = []
        return []

    count = int(getattr(runtime_state, "realtime_motion_fewshot_count", 4))
    count = max(0, count)
    if count == 0:
        if hasattr(runtime_state, "motion_tuning_fewshot_diagnostics"):
            runtime_state.motion_tuning_fewshot_diagnostics = []
        return []

    user_examples = [
        item
        for item in getattr(runtime_state, "motion_tuning_reference_examples", [])
        if isinstance(item, dict)
    ]
    selected_user_examples = user_examples[:count]
    default_count = max(0, count - len(selected_user_examples))
    default_examples = DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES[:default_count]
    resolved_examples = [*selected_user_examples, *default_examples]

    diagnostics: list[str] = []
    if len(selected_user_examples) < count:
        diagnostics.append(
            "motion_tuning_user_samples_insufficient:"
            f"requested={count}:user_available={len(selected_user_examples)}"
        )
    if default_examples:
        diagnostics.append(
            "motion_tuning_default_backfill_applied:"
            f"count={len(default_examples)}"
        )
    if len(resolved_examples) < count:
        diagnostics.append(
            "motion_tuning_fewshot_final_shortage:"
            f"requested={count}:final_count={len(resolved_examples)}"
        )
    if hasattr(runtime_state, "motion_tuning_fewshot_diagnostics"):
        runtime_state.motion_tuning_fewshot_diagnostics = diagnostics
    return resolved_examples


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
            "平台上下文：\n"
            f"{truncate_prompt_text(normalized_platform_context, 760)}\n\n"
        )

    if user and assistant:
        return prefix + (
            "请为本轮对话生成角色表情和动作控制参数。\n"
            f"用户：{truncate_prompt_text(user, 260)}\n"
            f"助手：{truncate_prompt_text(assistant, 320)}"
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
        header="少量示例（仅作为风格参考，不要机械照抄）：",
        output_label="输出 JSON",
    )
    motion_instruction_block = _build_motion_instruction_block(motion_instruction)

    return (
        "请根据文本为 Live2D 角色选择 [0,100] 范围内的动作轴数值。\n"
        "平台与任务：\n"
        "- AG99live 会在 AstrBot 对话过程中驱动 Live2D 角色。\n"
        "- 你的任务是选择能支撑助手回复语气的表情和控制参数。\n"
        "- 不要生成聊天文本，只生成控制 JSON。\n\n"
        f"可用参数：\n{axis_block}\n\n"
        "返回要求：\n"
        "只返回一个符合以下结构的 JSON 对象：\n"
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
        "生成规则：\n"
        "- 包含所有列出的轴。\n"
        "- 只使用整数。\n"
        "- 中性、说明性、低情绪回复使用 mode=idle；明确情绪或明确姿态使用 mode=expressive。\n"
        "- 按语义匹配选择数值，不要按固定动作列表套模板。\n"
        "- 数值要稳定、可读，避免混乱的极端值。\n\n"
        f"{motion_instruction_block}"
        f"{few_shot_block}"
        f"文本：{text}"
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

    few_shot_block = _build_few_shot_block(
        few_shot_examples=few_shot_examples,
        input_limit=420,
        header=(
            "少量示例仅作为风格参考。请把示例表达意图转换到当前可用轴；"
            "不要复制未知轴名。"
        ),
        output_label="参考输出",
        limit=3,
    )
    motion_instruction_block = _build_motion_instruction_block(motion_instruction)

    return (
        "请根据文本为 Live2D 角色选择语义动作轴数值。\n"
        "平台与任务：\n"
        "- AG99live 会在 AstrBot 对话过程中驱动 Live2D 角色。\n"
        "- 主 LLM 已经完成助手回复；你的任务是把本轮对话转换成语义控制参数。\n"
        "- 不要生成聊天文本、解释、Markdown 或额外字段。\n\n"
        "可控制参数：\n"
        "- 你只能使用下面列出的参数，不要编造参数名。\n"
        "- 每个参数都有取值范围、中性值、低值含义、高值含义和使用说明。\n"
        "- 参数分为主要控制参数和辅助细节参数。\n"
        "- 主要控制参数用于决定本次动作的核心表现，例如头部方向、视线、笑意、眉眼状态。\n"
        "- 辅助细节参数用于补充细节，例如单侧眼睛开合、眉毛细微变化、轻微口型修饰。\n"
        "- 输出时优先选择最能表达本轮语气的少数参数；不要为了凑数量而输出无关参数。\n"
        f"{axis_block}\n\n"
        "返回要求：\n"
        "只返回一个符合以下结构的 JSON 对象：\n"
        "{\n"
        '  "emotion": "short-label",\n'
        '  "mode": "idle or expressive",\n'
        '  "duration_ms": 1200,\n'
        '  "axes": {\n'
        f'    "{allowed_axis_ids[0]}": 50\n'
        "  }\n"
        "}\n"
        "生成规则：\n"
        "- 中性、说明性、低情绪回复使用 mode=idle；只有当助手文本带有明确情绪或明确姿态时才使用 mode=expressive。\n"
        "- 通常输出 1 到 4 个相关轴；宁可少输出，也不要输出无关动作。\n"
        "- 只使用数字，并保持在每个轴自己的范围内。\n"
        "- 通过理解参数含义和对话上下文来选择参数；不要把示例或动作名当成封闭选项。\n"
        "- 如果存在 mouth_smile，笑意强度主要由 mouth_smile 表达：轻微微笑约 58-68，明显开心约 72-88，调皮或逗趣约 65-82，并可搭配头部、视线、眉毛细节。\n"
        "- 如果存在 eye_open 轴，可以用于 wink 或不对称眼部细节；侧向和强度应从对话语义、头部/视线方向和示例中推断，不要固定套模板。\n"
        "- 如果存在 mouth_open，它只是可选的次要口型微调；不要把它当成主要说话口型动画。\n"
        "- 数值要稳定、可读，避免混乱的极端值。\n\n"
        f"{motion_instruction_block}"
        f"{few_shot_block}"
        f"文本：{text}"
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
        few_shot_lines.append(f"示例 {index} 输入：\n{input_text}")
        few_shot_lines.append(f"示例 {index} {output_label}：\n{output_json}")
    return "\n".join(few_shot_lines) + "\n\n"


def _build_motion_instruction_block(motion_instruction: str) -> str:
    motion_instruction_text = str(motion_instruction or "").strip()
    if not motion_instruction_text:
        return ""
    return (
        "补充动作指令：\n"
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
    role_label = _format_control_role_label(role)
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
    negative = _format_axis_semantics(axis.get("negative_semantics")) or "负方向"
    positive = _format_axis_semantics(axis.get("positive_semantics")) or "正方向"
    notes = truncate_prompt_text(str(axis.get("usage_notes") or "").strip(), 160)
    description = truncate_prompt_text(str(axis.get("description") or "").strip(), 160)
    suffix = f" 使用说明={notes}" if notes else ""
    return (
        f"- {axis_id}（{label}，{role_label}，范围 {range_text}，中性值 {neutral}）："
        f"低值={negative}；高值={positive}。{description}{suffix}"
    ).strip()


def _format_control_role_label(role: str) -> str:
    if role == "primary":
        return "主要控制参数"
    if role == "hint":
        return "辅助细节参数"
    return "可控制参数"


def truncate_prompt_text(value: str, max_chars: int) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."
