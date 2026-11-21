"""Short demonstrations in the selected model's semantic axis units."""

from __future__ import annotations

from typing import Any

from .motion_selector_examples import MotionReferenceExamplesResolution, select_relevant_user_examples

# Signed fractions of the travel from neutral to the corresponding endpoint.
# Each example pairs the actual line with only its visible changes.
_SCENES = (
    ("explain", "你看右边那盏灯。刚才还暗着呢，现在亮起来了。嗯，这下我也看清了。", (
        (220, {"gaze_x": .76}),
        (680, {"head_yaw": .72}),
        (1050, {"head_roll": -.36}),
        (510, {"head_roll": 0, "mouth_smile": .46}),
        (980, {"gaze_x": 0, "head_yaw": .20}),
        (760, {"head_yaw": 0, "mouth_smile": .74}),
    )),
    ("neutral", "嗯，我在听。", ((260, {"mouth_smile": .48}),)),
    ("listening", "旁边这位，我看见你了。嗯，我听着。", (
        (180, {"gaze_x": -.56}),
        (420, {"head_yaw": -.50, "gaze_x": -.24}),
        (260, {"mouth_smile": .52, "eye_smile_left": .32, "eye_smile_right": .32}),
        (300, {}),
    )),
    ("surprised", "真的？……太好了。", (
        (140, {"eye_open_left": .90, "eye_open_right": .90}), (210, {}),
        (330, {"eye_open_left": 0, "eye_open_right": 0, "mouth_smile": .80}),
    )),
    ("confused", "咦，你说的是右边那个？", (
        (140, {"gaze_x": .76}), (280, {"head_yaw": .48, "head_roll": .72}),
        (320, {}), (190, {"gaze_x": 0}),
    )),
)


def _example(
    category: str, speech: str, beats: tuple[tuple[int, dict[str, float]], ...],
    axes: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    output = []
    for ms, targets in beats:
        point = {"ms": ms}
        for key, amount in targets.items():
            axis = axes.get(key, {})
            bounds, neutral = axis.get("value_range"), axis.get("neutral")
            if not isinstance(bounds, (list, tuple)) or len(bounds) != 2:
                return None
            if not all(type(value) in (float, int) for value in (*bounds, neutral)):
                return None
            if not bounds[0] <= neutral <= bounds[1]:
                return None
            endpoint = bounds[0] if amount < 0 else bounds[1]
            if amount and endpoint == neutral:
                return None
            point[key] = round(neutral + abs(amount) * (endpoint - neutral), 3)
        output.append(point)
    return {"category": category, "input": speech, "assistant_text": speech, "output": output}


def resolve_expression_examples(
    state: Any, axes: dict[str, dict[str, Any]], request_text: str,
) -> MotionReferenceExamplesResolution:
    count = max(0, int(getattr(state, "motion_tuning_fewshot_count", 3)))
    if not count or not getattr(state, "motion_tuning_fewshot_enabled", True):
        return {"examples": [], "diagnostics": []}
    list_samples = getattr(state, "list_motion_tuning_reference_examples", None)
    candidates = list_samples() if callable(list_samples) else []
    reviewed = select_relevant_user_examples(
        candidates=[
            item for item in candidates
            if isinstance(item.get("output"), list) and item.get("assistant_text")
        ],
        request_text=request_text,
        count=min(count, int(getattr(state, "motion_tuning_user_fewshot_count", 0))),
    )
    defaults = [
        example for category, speech, beats in _SCENES
        if (example := _example(category, speech, beats, axes)) is not None
    ]
    if not defaults:
        tilt = _example("confused", "嗯？", ((280, {"head_roll": .70}),), axes)
        quiet_line = "我陪你安静一会儿。"
        defaults.append(tilt or {
            "category": "neutral",
            "input": quiet_line,
            "assistant_text": quiet_line,
            "output": [{"ms": 600}],
        })
    return {"examples": (reviewed + defaults)[:count], "diagnostics": ["timed_expression_examples"]}
