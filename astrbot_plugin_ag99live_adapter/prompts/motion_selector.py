from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .motion_selector_examples import (
    create_default_selector_few_shot_examples,
    resolve_selector_few_shot_examples as _resolve_selector_few_shot_examples,
)
from .semantic_axis_prompt import build_profile_axis_prompt_block


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
    AxisSpec("body_pitch", "body_pitch", "前倾/下沉", "居中", "后缩/挺起"),
    AxisSpec("eye_open_left", "eye_open_left", "闭眼", "正常睁眼", "睁大"),
    AxisSpec("eye_open_right", "eye_open_right", "闭眼", "正常睁眼", "睁大"),
    AxisSpec("eye_smile_left", "eye_smile_left", "放松", "中性", "笑眼/眯眼"),
    AxisSpec("eye_smile_right", "eye_smile_right", "放松", "中性", "笑眼/眯眼"),
    AxisSpec("gaze_x", "gaze_x", "看向左侧", "居中", "看向右侧"),
    AxisSpec("gaze_y", "gaze_y", "看向下方", "居中", "看向上方"),
    AxisSpec("mouth_smile", "mouth_smile", "不开心/嘴角下压", "中性", "微笑"),
    AxisSpec("mouth_x", "mouth_x", "嘴向左偏", "中性", "嘴向右偏"),
    AxisSpec("brow_bias", "brow_bias", "皱眉/压眉", "中性", "挑眉/抬眉"),
    AxisSpec("brow_left_detail", "brow_left_detail", "左眉下压", "中性", "左眉上扬"),
    AxisSpec("brow_right_detail", "brow_right_detail", "右眉下压", "中性", "右眉上扬"),
    AxisSpec("mouth_open", "mouth_open", "闭嘴", "正常", "张嘴"),
    AxisSpec("breath", "breath", "呼吸更弱", "中性", "呼吸更强"),
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
    "角色表现目标：用自然、可读的头部、身体、眼部、视线和少量面部细节支撑回复语气。\n"
    "播放方式：你输出的数值会直接用于驱动角色动作，所以要稳定、可理解，但不要把明确情绪压成几乎不动。\n"
    "偏好：当情绪不是中性时，使用清晰可见的头部和躯体幅度，避免接近中位的无效动作。"
)

DEFAULT_MOTION_PROMPT_INSTRUCTION = (
    "根据主回复的真实语气选择动作。中性、说明性回复可以使用 idle 或小幅动作；开心、惊讶、撒娇、调侃、道歉等明确情绪再使用 expressive。"
    "优先用头部、身体、眼睛开闭/笑眼和视线建立动作骨架；明确转身、回避、强调、惊讶、调侃或开心时，body_yaw/body_roll/body_pitch 可以成为清晰可见的动作主轴，而不只是微小跟随。"
    "再少量使用嘴角、嘴偏和眉毛补表情细节。mouth_open 和 breath 属于运行时/环境轴，不要当成主要说话动作。"
)


DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES = create_default_selector_few_shot_examples(AXIS_NAMES)


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


def resolve_selector_few_shot_examples(
    *,
    runtime_state: Any,
    update_runtime_state: bool = True,
) -> list[dict[str, Any]]:
    return _resolve_selector_few_shot_examples(
        runtime_state=runtime_state,
        default_examples=DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES,
        normalize_emotion_key=_normalize_emotion_key,
        update_runtime_state=update_runtime_state,
    )


def _normalize_emotion_key(value: str) -> str:
    normalized = "".join(char.lower() for char in str(value or "").strip() if char.isalnum() or char == "_")
    aliases = {
        "joy": "happy",
        "question": "confused",
        "playfulwink": "happy",
        "playful_wink": "happy",
        "extremelytired": "tired",
        "blush": "embarrassed",
    }
    return aliases.get(normalized, normalized)


def resolve_motion_prompt_instruction(*, runtime_state: Any) -> str:
    raw_value = str(getattr(runtime_state, "motion_prompt_instruction", "") or "").strip()
    if not raw_value:
        return DEFAULT_MOTION_PROMPT_INSTRUCTION
    return truncate_prompt_text(raw_value, 800)


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
    style_prompt: str = "",
    motion_instruction: str = "",
    semantic_profile: dict[str, Any] | None = None,
    motion_reference_templates: list[dict[str, Any]] | None = None,
    motion_catalog_options: list[dict[str, Any]] | None = None,
) -> str:
    del motion_reference_templates, motion_catalog_options
    if semantic_profile is not None:
        return build_selector_user_prompt_v2(
            text,
            few_shot_examples=few_shot_examples,
            style_prompt=style_prompt,
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
        '  "emotion_label": "short-label",\n'
        '  "duration_hint_ms": 1000,\n'
        '  "fallback_pose_id": "neutral",\n'
        '  "axes": {\n'
        '    "head_yaw": 50, "head_roll": 50, "head_pitch": 50,\n'
        '    "body_yaw": 50, "body_roll": 50, "body_pitch": 50,\n'
        '    "eye_open_left": 50, "eye_open_right": 50,\n'
        '    "eye_smile_left": 50, "eye_smile_right": 50,\n'
        '    "gaze_x": 50, "gaze_y": 50,\n'
        '    "mouth_smile": 50, "mouth_x": 50, "brow_bias": 50,\n'
        '    "brow_left_detail": 50, "brow_right_detail": 50\n'
        '  }\n'
        "}\n"
        "生成规则：\n"
        "- 包含所有列出的轴。\n"
        "- 只使用整数。\n"
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
    style_prompt: str = "",
    motion_instruction: str = "",
    semantic_profile: dict[str, Any],
) -> str:
    axis_block, allowed_axis_ids = build_profile_axis_prompt_block(
        semantic_profile,
        truncate_text=truncate_prompt_text,
    )

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
    style_prompt_block = _build_style_prompt_block(style_prompt)

    return (
        "请根据文本为 Live2D 角色选择语义动作轴数值。\n"
        "平台与任务：\n"
        "- AG99live 会在 AstrBot 对话过程中驱动 Live2D 角色。\n"
        "- 主 LLM 已经完成助手回复；你的任务是把本轮对话转换成一个语义姿态目标。\n"
        "- 不要生成聊天文本、解释、Markdown 或额外字段。\n\n"
        "可控制参数：\n"
        "- 你只能使用下面列出的参数，不要编造参数名。\n"
        "- 每个参数都有取值范围、中性值、低值含义、高值含义和使用说明。\n"
        "- 参数分为主要控制参数和辅助细节参数。\n"
        "- 主要控制参数用于决定本次动作骨架，例如头部、身体、眼睛开闭/笑眼和视线。\n"
        "- 辅助细节参数用于补充嘴角、嘴部偏移和眉毛细节。\n"
        "- 输出时优先选择最能表达本轮语气的少数参数；不要为了凑数量而输出无关参数。\n"
        f"{axis_block}\n\n"
        "返回要求：\n"
        "只返回一个符合以下结构的 JSON 对象：\n"
        "{\n"
        '  "emotion_label": "short-label",\n'
        '  "duration_hint_ms": 1000,\n'
        '  "fallback_pose_id": "neutral",\n'
        '  "axes": {\n'
        f'    "{allowed_axis_ids[0]}": 50\n'
        "  }\n"
        "}\n"
        "生成规则：\n"
        "- 不要输出 choice、mode、motion_id、动画文件、表情文件或播放资源引用。\n"
        "- 不要生成时间曲线、关键帧、随机抖动或来回摆动；只给目标姿态轴值。\n"
        "- 尽可能输出能支撑本轮语气的相关轴，尤其保留头部、身体和视线的动作骨架；不要为了凑数量输出无关动作。\n"
        "- 只使用数字，并保持在每个轴自己的范围内。\n"
        "- 通过理解参数含义和对话上下文来选择参数；不要把示例或动作名当成封闭选项。\n"
        "- 示例只是语气锚点，不是模板答案；不要机械复用示例中的固定组合。\n"
        "- 如果存在 body_yaw/body_roll/body_pitch，它们是头部之后最重要的躯体动作骨架；明确情绪、转向、强调、回避、惊讶或调侃时应使用可见幅度，不要总是只给轻微跟随。\n"
        "- 如果存在 eye_open 或 eye_smile 轴，可以用于眨眼、疲惫、惊讶、眯眼、笑眼；侧向和强度应从语义、头部/视线方向和示例推断。\n"
        "- 如果存在 mouth_smile/mouth_x/brow_*，它们是表情辅轴，用于少量补充嘴角、歪嘴和眉毛细节，不要盖过头身眼动作。\n"
        "- 如果存在 mouth_open 或 breath，它们通常由运行时控制；除非文本明确需要哈欠、惊讶张嘴或呼吸状态，否则不要输出。\n"
        "- 数值要稳定、可读，避免混乱的极端值。\n\n"
        f"{style_prompt_block}"
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
            _normalize_few_shot_output(output_payload),
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


def _build_style_prompt_block(style_prompt: str) -> str:
    style_prompt_text = str(style_prompt or "").strip()
    if not style_prompt_text:
        return ""
    return (
        "角色风格偏好：\n"
        f"{truncate_prompt_text(style_prompt_text, 1200)}\n\n"
    )


def _normalize_few_shot_output(output_payload: Any) -> dict[str, Any]:
    if not isinstance(output_payload, dict):
        return {}
    axes = output_payload.get("axes")
    normalized: dict[str, Any] = {
        "emotion_label": str(
            output_payload.get("emotion_label") or output_payload.get("emotion") or "neutral"
        ).strip() or "neutral",
        "duration_hint_ms": output_payload.get("duration_hint_ms", output_payload.get("duration_ms", 1000)),
        "fallback_pose_id": str(output_payload.get("fallback_pose_id") or "neutral").strip() or "neutral",
        "axes": axes if isinstance(axes, dict) else {},
    }
    return normalized


def truncate_prompt_text(value: str, max_chars: int) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."
