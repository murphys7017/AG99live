from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Any

LOGGER = logging.getLogger(__name__)


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
_IDLE_DEADZONE_MIN = 42
_IDLE_DEADZONE_MAX = 58
_MIN_EXPRESSIVE_MAX_DELTA = 24
_MIN_EXPRESSIVE_NONZERO_DELTA = 16

_NEUTRAL_EMOTION_MARKERS = {
    "neutral",
    "calm",
    "idle",
    "plain",
    "flat",
    "steady",
    "normal",
}

_SYSTEM_PROMPT = (
    "You are a compact emotion-to-axis selector for live avatar control. "
    "Return strict JSON only."
)
MOTION_INTENT_SCHEMA_VERSION = "engine.motion_intent.v1"
PARAMETER_PLAN_SCHEMA_VERSION = "engine.parameter_plan.v1"

_DEFAULT_SELECTOR_PLATFORM_DESCRIPTION = (
    "Source platform: AstrBot through AG99live desktop adapter.\n"
    "Interaction pattern: one user sends short text/voice turns and expects immediate assistant replies.\n"
    "Avatar behavior goal: natural and readable facial/head cues that support the turn meaning.\n"
    "Execution constraint: downstream playback directly writes Live2D parameters frame-by-frame.\n"
    "Preference: when emotion is non-neutral, use clearly readable amplitudes instead of near-center no-op values."
)
DEFAULT_MOTION_PROMPT_INSTRUCTION = (
    "Live2D 表现需要比真人更夸张。非中性情绪下，请让头部、眼睛、嘴部或眉毛至少 2 到 3 个轴明显偏离 50，"
    "避免输出几乎无动作的 45 到 55 区间。"
)


def _build_example_axes(**overrides: int) -> dict[str, int]:
    axes = {axis.name: 50 for axis in AXES}
    for key, value in overrides.items():
        if key not in axes:
            continue
        try:
            number = int(round(float(value)))
        except (TypeError, ValueError):
            number = 50
        axes[key] = max(0, min(100, number))
    return axes


DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES: list[dict[str, Any]] = [
    {
        "input": (
            "User: 嗯，我知道了。\n"
            "Assistant: 好的，我们继续下一步。"
        ),
        "output": {
            "emotion": "neutral",
            "mode": "parallel",
            "duration_ms": 1100,
            "axes": _build_example_axes(
                head_pitch=52,
                eye_open_left=54,
                eye_open_right=54,
                mouth_smile=56,
                brow_bias=52,
            ),
        },
    },
    {
        "input": (
            "User: 太好了！终于通过了！\n"
            "Assistant: 真棒，我们成功了！"
        ),
        "output": {
            "emotion": "joy",
            "mode": "parallel",
            "duration_ms": 1350,
            "axes": _build_example_axes(
                head_pitch=60,
                body_roll=58,
                gaze_y=58,
                eye_open_left=66,
                eye_open_right=66,
                mouth_open=72,
                mouth_smile=86,
                brow_bias=68,
            ),
        },
    },
    {
        "input": (
            "User: 我有点难过，今天状态不太好。\n"
            "Assistant: 没关系，我们慢慢来。"
        ),
        "output": {
            "emotion": "sad",
            "mode": "sequential",
            "duration_ms": 1500,
            "axes": _build_example_axes(
                head_pitch=38,
                body_roll=44,
                gaze_y=34,
                eye_open_left=40,
                eye_open_right=40,
                mouth_open=36,
                mouth_smile=22,
                brow_bias=30,
            ),
        },
    },
    {
        "input": (
            "User: 你这次真的有点过分了。\n"
            "Assistant: 我理解你的不满，我来马上修正。"
        ),
        "output": {
            "emotion": "tense",
            "mode": "parallel",
            "duration_ms": 1250,
            "axes": _build_example_axes(
                head_pitch=44,
                body_yaw=55,
                gaze_x=52,
                eye_open_left=46,
                eye_open_right=46,
                mouth_open=42,
                mouth_smile=26,
                brow_bias=18,
            ),
        },
    },
    {
        "input": (
            "User: 啊？你说这个现在就能用了？\n"
            "Assistant: 是的，现在已经可用了。"
        ),
        "output": {
            "emotion": "surprised",
            "mode": "parallel",
            "duration_ms": 1200,
            "axes": _build_example_axes(
                head_pitch=62,
                gaze_y=64,
                eye_open_left=88,
                eye_open_right=88,
                mouth_open=78,
                mouth_smile=58,
                brow_bias=84,
            ),
        },
    },
]


class RealtimeMotionPlanGenerator:
    def __init__(self, *, runtime_state: Any) -> None:
        self.runtime_state = runtime_state

    async def generate(
        self,
        *,
        user_text: str,
        assistant_text: str,
    ) -> dict[str, Any] | None:
        if not bool(getattr(self.runtime_state, "enable_realtime_motion_plan", True)):
            return None

        context_text = build_selector_context(
            user_text=user_text,
            assistant_text=assistant_text,
            platform_context=build_selector_platform_context(runtime_state=self.runtime_state),
        )
        selector_raw = await self._call_astrbot_selector(
            context_text,
            few_shot_examples=resolve_selector_few_shot_examples(runtime_state=self.runtime_state),
            motion_instruction=resolve_motion_prompt_instruction(runtime_state=self.runtime_state),
        )
        selector = normalize_selector_output(selector_raw)
        intent = build_intent_from_selector(selector)
        valid, failure_reason = validate_motion_intent_payload(intent)
        if not valid:
            LOGGER.warning(
                "Realtime motion intent rejected after selector normalization: %s",
                failure_reason,
            )
            return None
        return intent

    async def _call_astrbot_selector(
        self,
        context_text: str,
        *,
        few_shot_examples: list[dict[str, Any]],
        motion_instruction: str,
    ) -> dict[str, Any]:
        provider = getattr(self.runtime_state, "selected_motion_analysis_provider", None)
        if provider is None:
            raise RuntimeError(
                "AstrBot motion provider is unavailable. "
                "Configure `motion_analysis_provider_id` or set a current chat provider."
            )

        timeout = float(getattr(self.runtime_state, "realtime_motion_timeout_seconds", 8.0) or 8.0)
        response = await asyncio.wait_for(
            provider.text_chat(
                prompt=build_selector_user_prompt(
                    context_text,
                    few_shot_examples=few_shot_examples,
                    motion_instruction=motion_instruction,
                ),
                system_prompt=_SYSTEM_PROMPT,
            ),
            timeout=timeout,
        )
        completion_text = str(getattr(response, "completion_text", "") or "").strip()
        if not completion_text:
            raise RuntimeError("AstrBot motion provider returned empty completion_text.")
        return _extract_json_object(completion_text)


def build_selector_platform_context(*, runtime_state: Any) -> str:
    enabled = bool(getattr(runtime_state, "realtime_motion_platform_context_enabled", True))
    if not enabled:
        return ""

    custom_description = str(
        getattr(runtime_state, "realtime_motion_platform_description", "") or ""
    ).strip()
    if custom_description:
        return _truncate_text(custom_description, 720)

    platform_config = getattr(runtime_state, "platform_config", {})
    adapter_alias = "AG99live Desktop"
    if isinstance(platform_config, dict):
        configured_alias = str(platform_config.get("conf_name") or "").strip()
        if configured_alias:
            adapter_alias = configured_alias

    client_uid = str(getattr(runtime_state, "client_uid", "") or "").strip() or "desktop-client"
    return (
        f"{_DEFAULT_SELECTOR_PLATFORM_DESCRIPTION}\n"
        f"Adapter alias: {adapter_alias}.\n"
        f"Session target: {client_uid}."
    )


def resolve_selector_few_shot_examples(*, runtime_state: Any) -> list[dict[str, Any]]:
    enabled = bool(getattr(runtime_state, "realtime_motion_fewshot_enabled", True))
    if not enabled:
        return []

    max_count = len(DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES)
    count_raw = getattr(runtime_state, "realtime_motion_fewshot_count", 4)
    try:
        count = int(round(float(count_raw)))
    except (TypeError, ValueError):
        count = 4
    count = max(0, min(count, max_count))
    if count == 0:
        return []
    return DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES[:count]


def resolve_motion_prompt_instruction(*, runtime_state: Any) -> str:
    raw_value = str(getattr(runtime_state, "motion_prompt_instruction", "") or "").strip()
    if not raw_value:
        return DEFAULT_MOTION_PROMPT_INSTRUCTION
    return _truncate_text(raw_value, 800)


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
            f"{_truncate_text(normalized_platform_context, 760)}\n\n"
        )

    if user and assistant:
        return prefix + (
            "Generate expression controls for this dialog turn.\n"
            f"User: {_truncate_text(user, 260)}\n"
            f"Assistant: {_truncate_text(assistant, 320)}"
        )
    if assistant:
        return prefix + _truncate_text(assistant, 360)
    return prefix + _truncate_text(user, 360)


def build_selector_user_prompt(
    text: str,
    *,
    few_shot_examples: list[dict[str, Any]] | None = None,
    motion_instruction: str = "",
) -> str:
    lines: list[str] = []
    for axis in AXES:
        lines.append(
            f"- {axis.name}: 0={axis.low_label}, 50={axis.mid_label}, 100={axis.high_label}"
        )
    axis_block = "\n".join(lines)
    few_shot_block = ""
    normalized_examples = [item for item in (few_shot_examples or []) if isinstance(item, dict)]
    if normalized_examples:
        few_shot_lines = ["Few-shot examples (style reference, do not copy literally):"]
        for index, item in enumerate(normalized_examples, start=1):
            input_text = _truncate_text(str(item.get("input") or "").strip(), 560)
            output_payload = item.get("output")
            output_json = json.dumps(
                output_payload if isinstance(output_payload, dict) else {},
                ensure_ascii=False,
                separators=(",", ":"),
            )
            few_shot_lines.append(f"Example {index} input:\n{input_text}")
            few_shot_lines.append(f"Example {index} output JSON:\n{output_json}")
        few_shot_block = "\n".join(few_shot_lines) + "\n\n"
    motion_instruction_text = str(motion_instruction or "").strip()
    motion_instruction_block = ""
    if motion_instruction_text:
        motion_instruction_block = (
            "Additional motion instruction:\n"
            f"{_truncate_text(motion_instruction_text, 800)}\n\n"
        )

    return (
        "Given text, choose axis values in [0,100] for an avatar.\n"
        f"Axes:\n{axis_block}\n\n"
        "Return JSON only with this schema:\n"
        "{\n"
        '  "emotion": "short-label",\n'
        '  "mode": "parallel or sequential",\n'
        '  "duration_ms": 1200,\n'
        '  "axes": {\n'
        '    "head_yaw": 50, "head_roll": 50, "head_pitch": 50,\n'
        '    "body_yaw": 50, "body_roll": 50,\n'
        '    "gaze_x": 50, "gaze_y": 50,\n'
        '    "eye_open_left": 50, "eye_open_right": 50,\n'
        '    "mouth_open": 50, "mouth_smile": 50, "brow_bias": 50\n'
        '  }\n'
        "}\n"
        "Rules:\n"
        "- Include all listed axes.\n"
        "- Use integers only.\n"
        "- Avoid flat/no-op outputs around 50 unless the emotion is truly neutral.\n"
        "- For non-neutral emotion, make at least 2 head/face axes visibly deviate from center.\n"
        "- Keep values stable and readable; avoid chaotic extremes.\n\n"
        f"{motion_instruction_block}"
        f"{few_shot_block}"
        f"Text: {text}"
    )


def normalize_selector_output(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("selector_payload_not_object")

    emotion_raw = payload.get("emotion")
    emotion = str(emotion_raw).strip() if isinstance(emotion_raw, str) else ""
    if not emotion:
        raise ValueError("selector_emotion_empty")

    if "mode" not in payload:
        raise ValueError("selector_mode_missing")
    mode = str(payload.get("mode") or "").strip().lower()
    if mode not in {"parallel", "sequential", "idle", "expressive"}:
        raise ValueError("selector_mode_invalid")

    if "duration_ms" not in payload:
        raise ValueError("selector_duration_ms_missing")
    duration_ms_raw = payload.get("duration_ms")
    if not isinstance(duration_ms_raw, (int, float)):
        raise ValueError("selector_duration_ms_not_number")
    duration_ms = int(round(float(duration_ms_raw)))
    if duration_ms < 0:
        raise ValueError("selector_duration_ms_negative")
    duration_ms = max(400, min(6000, duration_ms))

    raw_axes = payload.get("axes")
    if not isinstance(raw_axes, dict):
        raise ValueError("selector_axes_not_object")

    axes: dict[str, int] = {}
    missing_axis_names: list[str] = []
    for axis in AXES:
        if axis.name not in raw_axes:
            missing_axis_names.append(axis.name)
            axes[axis.name] = 50
            continue
        axis_value = raw_axes.get(axis.name)
        if not isinstance(axis_value, (int, float)):
            raise ValueError(f"selector_axis_not_number:{axis.name}")
        if float(axis_value) < 0 or float(axis_value) > 100:
            raise ValueError(f"selector_axis_out_of_range:{axis.name}")
        axes[axis.name] = clamp_axis_value(axis_value)

    if missing_axis_names:
        LOGGER.warning(
            "Realtime motion selector output missing axes; defaulting to 50. missing=%s",
            ",".join(missing_axis_names),
        )

    unexpected_axis_names: list[str] = []
    for axis_name in raw_axes.keys():
        if axis_name not in AXIS_NAMES:
            unexpected_axis_names.append(str(axis_name))
    if unexpected_axis_names:
        LOGGER.warning(
            "Realtime motion selector output ignored unexpected axes. unexpected=%s",
            ",".join(unexpected_axis_names),
        )

    axes = _apply_expressive_floor(
        axes=axes,
        emotion=emotion,
    )

    return {
        "emotion": emotion,
        "mode": mode,
        "duration_ms": duration_ms,
        "axes": axes,
    }


def build_intent_from_selector(selector_output: dict[str, Any]) -> dict[str, Any]:
    axes = selector_output.get("axes")
    if not isinstance(axes, dict):
        raise ValueError("selector_axes_not_object")
    normalized_axes = {
        axis.name: clamp_axis_value(axes.get(axis.name))
        for axis in AXES
    }
    requested_mode = str(selector_output.get("mode") or "").strip().lower()
    mode = requested_mode if requested_mode in {"idle", "expressive"} else "expressive"
    if mode != "idle" and _is_idle_deadzone(normalized_axes):
        mode = "idle"

    duration_ms_raw = selector_output.get("duration_ms")
    if not isinstance(duration_ms_raw, (int, float)):
        raise ValueError("selector_duration_ms_not_number")
    duration_hint_ms = int(round(float(duration_ms_raw)))
    duration_hint_ms = max(320, min(15000, duration_hint_ms))

    emotion_label = str(selector_output.get("emotion") or "").strip()
    if not emotion_label:
        raise ValueError("selector_emotion_empty")

    return {
        "schema_version": MOTION_INTENT_SCHEMA_VERSION,
        "mode": mode,
        "emotion_label": emotion_label,
        "duration_hint_ms": duration_hint_ms,
        "key_axes": {
            axis_name: {"value": axis_value}
            for axis_name, axis_value in normalized_axes.items()
        },
        "summary": {
            "key_axes_count": len(AXIS_NAMES),
        },
    }


def normalize_motion_intent_payload(intent: Any) -> dict[str, Any]:
    if not isinstance(intent, dict):
        raise ValueError("intent_not_object")

    schema_version = str(intent.get("schema_version") or "").strip()
    if schema_version != MOTION_INTENT_SCHEMA_VERSION:
        raise ValueError("invalid_schema_version")

    mode = str(intent.get("mode") or "").strip().lower()
    if mode not in {"expressive", "idle"}:
        raise ValueError("invalid_mode")

    emotion_label = str(intent.get("emotion_label") or "").strip()
    if not emotion_label:
        raise ValueError("emotion_label_empty")

    key_axes = intent.get("key_axes")
    if not isinstance(key_axes, dict):
        raise ValueError("key_axes_not_object")

    normalized_axes: dict[str, dict[str, int]] = {}
    missing_axis_names: list[str] = []
    for axis_name in AXIS_NAMES:
        axis_payload = key_axes.get(axis_name)
        if not isinstance(axis_payload, dict) or "value" not in axis_payload:
            missing_axis_names.append(axis_name)
            normalized_axes[axis_name] = {"value": 50}
            continue

        value = axis_payload.get("value")
        if not isinstance(value, (int, float)):
            raise ValueError(f"axis_{axis_name}_value_not_number")
        if float(value) < 0 or float(value) > 100:
            raise ValueError(f"axis_{axis_name}_value_out_of_range")
        normalized_axes[axis_name] = {"value": clamp_axis_value(value)}

    if missing_axis_names:
        LOGGER.warning(
            "Motion intent missing axes; defaulting to 50. missing=%s",
            ",".join(missing_axis_names),
        )

    unexpected_axis_names = [
        str(axis_name)
        for axis_name in key_axes.keys()
        if axis_name not in AXIS_NAMES
    ]
    if unexpected_axis_names:
        LOGGER.warning(
            "Motion intent ignored unexpected axes. unexpected=%s",
            ",".join(unexpected_axis_names),
        )

    duration_hint_raw = intent.get("duration_hint_ms")
    duration_hint_ms: int | None = None
    if duration_hint_raw is not None:
        if not isinstance(duration_hint_raw, (int, float)):
            raise ValueError("duration_hint_ms_not_number")
        if float(duration_hint_raw) < 0:
            raise ValueError("duration_hint_ms_negative")
        duration_hint_ms = max(320, min(15000, int(round(float(duration_hint_raw)))))

    return {
        "schema_version": MOTION_INTENT_SCHEMA_VERSION,
        "mode": mode,
        "emotion_label": emotion_label,
        "duration_hint_ms": duration_hint_ms,
        "key_axes": normalized_axes,
        "summary": {
            "key_axes_count": len(AXIS_NAMES),
        },
    }


def _apply_expressive_floor(
    *,
    axes: dict[str, int],
    emotion: str,
) -> dict[str, int]:
    normalized_emotion = str(emotion or "").strip().lower()
    if _is_neutralish_emotion(normalized_emotion):
        return axes

    deltas = {
        axis_name: clamp_axis_value(value) - 50
        for axis_name, value in axes.items()
    }
    nonzero_deltas = [abs(delta) for delta in deltas.values() if delta != 0]
    max_abs_delta = max(nonzero_deltas) if nonzero_deltas else 0
    if max_abs_delta >= _MIN_EXPRESSIVE_MAX_DELTA:
        return axes

    # If selector collapses to near-center but emotion is non-neutral,
    # lift subtle deltas to a visible amplitude to avoid no-op execution.
    if max_abs_delta == 0:
        seeded = dict(axes)
        seeded.update(_build_emotion_seed_axes(normalized_emotion))
        return {
            axis_name: clamp_axis_value(value)
            for axis_name, value in seeded.items()
        }

    scale = _MIN_EXPRESSIVE_MAX_DELTA / float(max_abs_delta)
    boosted: dict[str, int] = {}
    for axis_name, base_value in axes.items():
        delta = deltas.get(axis_name, 0)
        if delta == 0:
            boosted[axis_name] = clamp_axis_value(base_value)
            continue
        candidate_delta = int(round(delta * scale))
        if abs(candidate_delta) < _MIN_EXPRESSIVE_NONZERO_DELTA:
            candidate_delta = _MIN_EXPRESSIVE_NONZERO_DELTA if delta > 0 else -_MIN_EXPRESSIVE_NONZERO_DELTA
        boosted[axis_name] = clamp_axis_value(50 + candidate_delta)

    return boosted


def _is_neutralish_emotion(emotion: str) -> bool:
    normalized = str(emotion or "").strip().lower()
    if not normalized:
        return True
    for marker in _NEUTRAL_EMOTION_MARKERS:
        # Use word-boundary match so "abnormal" doesn't false-trigger on "normal".
        if re.search(r"\b" + re.escape(marker) + r"\b", normalized):
            return True
    return False


def _build_emotion_seed_axes(emotion: str) -> dict[str, int]:
    mood = str(emotion or "").strip().lower()
    if any(token in mood for token in {"happy", "joy", "playful", "smile", "excited", "surprise"}):
        return {
            "head_pitch": 62,
            "eye_open_left": 64,
            "eye_open_right": 64,
            "mouth_open": 68,
            "mouth_smile": 76,
            "brow_bias": 62,
        }
    if any(token in mood for token in {"angry", "tense", "firm", "disgust"}):
        return {
            "head_pitch": 44,
            "eye_open_left": 46,
            "eye_open_right": 46,
            "mouth_open": 40,
            "mouth_smile": 28,
            "brow_bias": 24,
        }
    if any(token in mood for token in {"sad", "down", "tired", "confused", "wry", "hesitant"}):
        return {
            "head_pitch": 42,
            "gaze_y": 38,
            "eye_open_left": 44,
            "eye_open_right": 44,
            "mouth_open": 42,
            "mouth_smile": 34,
            "brow_bias": 36,
        }
    return {
        "head_roll": 60,
        "head_pitch": 56,
        "mouth_smile": 62,
        "brow_bias": 58,
    }


def clamp_axis_value(value: Any) -> int:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        number = 50
    return max(0, min(100, number))


def _is_idle_deadzone(axis_values: dict[str, int]) -> bool:
    for axis_name in AXIS_NAMES:
        value = clamp_axis_value(axis_values.get(axis_name, 50))
        if value < _IDLE_DEADZONE_MIN or value > _IDLE_DEADZONE_MAX:
            return False
    return True


def validate_motion_intent_payload(intent: Any) -> tuple[bool, str]:
    try:
        normalize_motion_intent_payload(intent)
    except ValueError as exc:
        return False, str(exc)
    return True, ""


def validate_parameter_plan_payload(plan: Any) -> tuple[bool, str]:
    if not isinstance(plan, dict):
        return False, "plan_not_object"

    schema_version = str(plan.get("schema_version") or "").strip()
    if schema_version != PARAMETER_PLAN_SCHEMA_VERSION:
        return False, "invalid_schema_version"

    mode = str(plan.get("mode") or "").strip().lower()
    if mode not in {"expressive", "idle"}:
        return False, "invalid_mode"

    timing = plan.get("timing")
    if not isinstance(timing, dict):
        return False, "timing_not_object"
    timing_keys = ("duration_ms", "blend_in_ms", "hold_ms", "blend_out_ms")
    for key in timing_keys:
        value = timing.get(key)
        if not isinstance(value, (int, float)):
            return False, f"timing_{key}_not_number"
        if float(value) < 0:
            return False, f"timing_{key}_negative"

    key_axes = plan.get("key_axes")
    if not isinstance(key_axes, dict):
        return False, "key_axes_not_object"
    if len(key_axes) != len(AXIS_NAMES):
        return False, "key_axes_count_mismatch"
    for axis_name in AXIS_NAMES:
        axis_payload = key_axes.get(axis_name)
        if not isinstance(axis_payload, dict):
            return False, f"missing_axis_{axis_name}"
        value = axis_payload.get("value")
        if not isinstance(value, (int, float)):
            return False, f"axis_{axis_name}_value_not_number"
        if float(value) < 0 or float(value) > 100:
            return False, f"axis_{axis_name}_value_out_of_range"
    for axis_name in key_axes.keys():
        if axis_name not in AXIS_NAMES:
            return False, f"unexpected_axis_{axis_name}"

    supplementary = plan.get("supplementary_params")
    if not isinstance(supplementary, list):
        return False, "supplementary_not_list"
    for item in supplementary:
        if not isinstance(item, dict):
            return False, "supplementary_item_not_object"
        parameter_id = str(item.get("parameter_id") or "").strip()
        if not parameter_id:
            return False, "supplementary_parameter_id_empty"
        source_atom_id = str(item.get("source_atom_id") or "").strip()
        if not source_atom_id:
            return False, "supplementary_source_atom_id_empty"
        channel = str(item.get("channel") or "").strip()
        if not channel:
            return False, "supplementary_channel_empty"
        target_value = item.get("target_value")
        weight = item.get("weight")
        if not isinstance(target_value, (int, float)):
            return False, "supplementary_target_value_not_number"
        if float(target_value) < -1.0 or float(target_value) > 1.0:
            return False, "supplementary_target_value_out_of_range"
        if not isinstance(weight, (int, float)):
            return False, "supplementary_weight_not_number"
        if float(weight) < 0.0 or float(weight) > 1.0:
            return False, "supplementary_weight_out_of_range"

    return True, ""


def _extract_json_object(text: str) -> dict[str, Any]:
    normalized = str(text or "").strip()
    if not normalized:
        raise ValueError("Selector response is empty.")

    try:
        payload = json.loads(normalized)
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", normalized, flags=re.DOTALL)
    if not match:
        raise ValueError("Selector response does not contain a JSON object.")

    payload = json.loads(match.group(0))
    if not isinstance(payload, dict):
        raise ValueError("Selector payload is not a JSON object.")
    return payload


def _truncate_text(value: str, max_chars: int) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."
