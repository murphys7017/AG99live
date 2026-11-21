"""Describe the selected rig's expression axes in the motion provider prompt."""

from collections.abc import Mapping
from typing import Any


# Translate profile text, rather than assigning a meaning to an axis ID.
# For example, brow_bias controls height on one rig and brow form on another.
_DESCRIPTIONS = {
    "Controls left-right head orientation.": "脸朝向哪一侧",
    "Controls up-down head orientation.": "下巴的高低",
    "Controls side tilt of the head.": "头歪向哪一侧",
    "Controls left-right upper-body orientation.": "上半身朝向哪一侧",
    "Controls side tilt of the torso.": "上半身向哪一侧倾斜",
    "Controls forward/back or vertical-feeling body posture.": "上半身前倾或挺起的姿态",
    "Controls left-right eye target direction.": "双眼视线的水平方向",
    "Controls up-down eye target direction.": "双眼视线的垂直方向",
    "Controls openness of the left eye.": "左眼眼睑开合",
    "Controls openness of the right eye.": "右眼眼睑开合",
    "Controls smile/squint shape of the left eye.": "左眼的笑眼形状",
    "Controls smile/squint shape of the right eye.": "右眼的笑眼形状",
    "Controls smile-vs-frown mouth form.": "嘴角的表情",
    "Controls left-right mouth offset for asymmetric expressions.": "嘴形向哪一侧偏",
    "Controls brow raise-vs-frown bias.": "眉毛扬起或皱起的姿态",
    "Controls smiling-versus-tense brow form, not brow height.": "两侧眉形的紧张或舒展",
    "Controls the one-sided left brow down shape.": "左眉单侧下压",
    "Controls the one-sided right brow down shape.": "右眉单侧下压",
}

_DIRECTIONS = {
    ("look left", "turn left", "avoid left"): "向左转脸",
    ("look right", "turn right", "side glance right"): "向右转脸",
    ("look down", "lower chin", "bashful drop"): "低头、收下巴",
    ("look up", "raise chin", "confident lift"): "抬头、抬下巴",
    ("tilt left", "skeptical lean", "guarded angle"): "向左歪头",
    ("tilt right", "playful lean", "curious angle"): "向右歪头",
    ("body turns left", "left-side emphasis", "strong left follow-through"): "上半身向左转",
    ("body turns right", "right-side emphasis", "strong right follow-through"): "上半身向右转",
    ("body tilts left", "left sway", "guarded left lean"): "上半身向左侧倾",
    ("body tilts right", "right sway", "playful right lean"): "上半身向右侧倾",
    ("lean forward", "drop posture", "low-energy slump"): "前倾、姿态下沉",
    ("lift posture", "lean back", "brighten upward"): "挺起、向后仰",
    ("eyes left", "track left"): "目光向左",
    ("eyes right", "track right"): "目光向右",
    ("eyes down", "drop gaze"): "目光向下",
    ("eyes up", "lift gaze"): "目光向上",
    ("close left eye", "wink left"): "左眼合拢",
    ("open left eye", "alert left eye"): "左眼睁大",
    ("close right eye", "wink right"): "右眼合拢",
    ("open right eye", "alert right eye"): "右眼睁大",
    ("relax left eye smile", "reduce left squint", "neutral left eye"): "左眼的笑意减弱",
    ("left smiling eye", "left squint smile", "playful left eye"): "左眼笑着眯起",
    ("relax right eye smile", "reduce right squint", "neutral right eye"): "右眼的笑意减弱",
    ("right smiling eye", "right squint smile", "playful right eye"): "右眼笑着眯起",
    ("frown", "tight mouth", "reduce smile intensity"): "嘴角收紧或下压",
    ("smile", "warm grin", "increase smile intensity"): "嘴角上扬",
    ("mouth shifts left", "left smirk", "asymmetric grin left"): "嘴形向左偏",
    ("mouth shifts right", "right smirk", "asymmetric grin right"): "嘴形向右偏",
    ("furrow brow", "tense brow"): "皱眉",
    ("raise brow", "curious brow"): "扬眉",
    ("tense brow form", "frowning brow shape"): "眉形收紧",
    ("soften brow form", "smiling brow shape"): "眉形舒展",
    ("lower left brow", "tense left brow down"): "左眉向下压",
    ("relax left brow down control",): "松开左眉的下压",
    ("lower right brow", "tense right brow down"): "右眉向下压",
    ("relax right brow down control",): "松开右眉的下压",
}


def describe_expression_axis(axis: Mapping[str, Any]) -> dict[str, Any]:
    row = {key: axis[key] for key in ("id", "value_range", "neutral") if key in axis}
    description = axis.get("description") or axis.get("label")
    if description:
        row["description"] = _DESCRIPTIONS.get(description, description)
    for key in ("negative_semantics", "positive_semantics"):
        if key in axis:
            phrases = axis[key]
            translated = _DIRECTIONS.get(tuple(phrases))
            row[key] = [translated] if translated else phrases
    return row
