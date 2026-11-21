"""Input and output contract of the released AG99 Qwen3.5 motion weights."""

import json
from collections.abc import Mapping
from typing import Any

from ..motion.motion_intent import MAX_MOTION_DURATION_MS, normalize_motion_steps


# Training instruction from the released continuous SFT dataset, with its
# step-count prescription removed. The total duration and per-step weights
# still have the meanings learned by the model.
SYSTEM_PROMPT = (
    "You generate one AG99live training action JSON object from the supplied dialogue context. "
    "Return only JSON, with no markdown or explanation. "
    "The output must contain exactly two fields: motion_steps and duration_hint_ms. "
    "Write motion_steps in playback order. "
    "Every step must contain exactly axis_values and duration_weight. "
    "axis_values maps semantic axis IDs to concrete numeric values inside each axis value_range; "
    "do not use discrete levels or axis_levels. duration_weight is an integer from 1 to 3. "
    "duration_hint_ms is an integer from 320 to 15000 and is required. "
    "Keep steps sparse: write only axes that start or change in that step. "
    "Do not output motion_guidance, neurobrain_state, intent_tags, resource IDs, schema metadata, or any other field."
)


def uses_trained_expression_prompt(provider: Any, provider_id: str) -> bool:
    get_model = getattr(provider, "get_model", None)
    model = (get_model() if callable(get_model) else "") or provider_id
    name = model.rsplit("/", 1)[-1].partition(":")[0].lower()
    return name in {
        "ag99-qwen35-f16", "ag99-qwen35-q8", "ag99-qwen35-q4",
        "ag99live-motion-f16", "ag99live-motion-q8", "ag99live-motion-q4",
    }


def build_trained_expression_prompts(
    axes: list[dict[str, Any]],
    user: str,
    speech: str,
    intent: Mapping[str, Any] | None,
) -> tuple[str, str]:
    fields = (
        "id", "label", "value_range", "neutral",
        "negative_semantics", "positive_semantics", "usage_notes",
    )
    capability = {
        "axis_value_format": "axis_values",
        "axes": [
            {key: axis[key] for key in fields if key in axis}
            for axis in sorted(axes, key=lambda axis: axis["id"])
        ],
    }
    intent = intent or {}
    turn = {
        "user": user,
        "segment": {
            "speech": speech,
            "actions": intent.get("actions", []),
            "tendency": intent.get("tendency", {}),
        },
    }
    return (
        SYSTEM_PROMPT + "\n\nLive2D 能力：\n" + json.dumps(capability, ensure_ascii=False, separators=(",", ":")),
        json.dumps(turn, ensure_ascii=False, separators=(",", ":")),
    )


def trained_expression_record(text: str) -> dict[str, Any]:
    # The released GGUF can emit a closing reasoning token after the JSON.
    value = json.loads(text.rstrip().removesuffix("</think>"))
    if not isinstance(value, dict) or set(value) != {"motion_steps", "duration_hint_ms"}:
        raise ValueError("trained_expression_object_required")
    duration = value["duration_hint_ms"]
    if type(duration) is not int or not 320 <= duration <= MAX_MOTION_DURATION_MS:
        raise ValueError("duration_hint_ms_out_of_range")
    steps = value["motion_steps"]
    if not isinstance(steps, list) or not steps or len(steps) > duration:
        raise ValueError("motion_steps_count_invalid")
    for step in steps:
        if not isinstance(step, dict) or set(step) != {"axis_values", "duration_weight"}:
            raise ValueError("weighted_expression_step_required")
        weight = step["duration_weight"]
        if type(weight) is not int or not 1 <= weight <= 3:
            raise ValueError("duration_weight_invalid")
    normalized, reason = normalize_motion_steps(steps)
    if normalized is None:
        raise ValueError(reason)
    return {"motion_steps": normalized, "duration_hint_ms": duration, "intent_tags": ["动作"]}
