"""Short demonstrations in the selected model's semantic axis units."""

from __future__ import annotations

from typing import Any

# Signed fractions of the travel from neutral to the corresponding endpoint.
# Each example pairs the actual line with only its visible changes.
_SCENES = (
    ("嗯，我在听。", ((260, {"mouth_smile": .18}),)),
    ("咦，你说的是右边那个？", (
        (140, {"gaze_x": .42}), (280, {"head_yaw": .24, "head_roll": .14}),
        (320, {}), (190, {"gaze_x": 0}),
    )),
    ("真的？……太好了。", (
        (140, {"eye_open_left": .4, "eye_open_right": .4}), (210, {}),
        (330, {"eye_open_left": 0, "eye_open_right": 0, "mouth_smile": .52}),
    )),
)


def _example(
    speech: str, beats: tuple[tuple[int, dict[str, float]], ...], axes: dict[str, dict[str, Any]],
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
    return {"speech": speech, "output": output}


def expression_examples(axes: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    examples = [
        example for speech, beats in _SCENES
        if (example := _example(speech, beats, axes)) is not None
    ]
    if examples:
        return examples
    tilt = _example("嗯？", ((280, {"head_roll": .2}),), axes)
    return [tilt or {"speech": "我陪你安静一会儿。", "output": [{"ms": 600}]}]
