from __future__ import annotations

import json
from typing import Any


EXPRESSION_KEYWORD_REFERENCES: list[dict[str, Any]] = [
    {
        "id": "calm_continue",
        "keywords": ["平静", "说明", "确认", "继续"],
        "attitude": "稳定自然",
        "visual": ["轻微点头", "弱笑", "视线稳定"],
        "reference_axes": {
            "head_pitch": 52,
            "gaze_y": 50,
            "mouth_smile": 54,
            "brow_bias": 50,
        },
    },
    {
        "id": "positive_encouragement",
        "keywords": ["开心", "鼓励", "赞同", "成功"],
        "attitude": "积极亲近",
        "visual": ["明显笑意", "眼神明亮", "头部略抬"],
        "reference_axes": {
            "head_pitch": 60,
            "gaze_y": 58,
            "mouth_smile": 78,
            "brow_bias": 64,
        },
    },
    {
        "id": "serious_dissatisfied",
        "keywords": ["生气", "不满", "严肃", "反驳"],
        "attitude": "克制但有压迫感",
        "visual": ["压眉", "笑意降低", "头部略低"],
        "reference_axes": {
            "head_pitch": 45,
            "gaze_y": 48,
            "mouth_smile": 24,
            "brow_bias": 28,
        },
    },
    {
        "id": "surprise_discovery",
        "keywords": ["惊讶", "意外", "突然", "发现"],
        "attitude": "短促明显",
        "visual": ["睁眼", "挑眉", "抬头"],
        "reference_axes": {
            "head_pitch": 62,
            "gaze_y": 64,
            "eye_open_left": 92,
            "eye_open_right": 92,
            "brow_bias": 82,
        },
    },
    {
        "id": "doubt_thinking",
        "keywords": ["疑惑", "不确定", "确认", "思考"],
        "attitude": "迟疑求证",
        "visual": ["轻微歪头", "视线偏移", "疑惑眉"],
        "reference_axes": {
            "head_roll": 58,
            "gaze_x": 56,
            "gaze_y": 47,
            "mouth_smile": 42,
            "brow_bias": 44,
        },
    },
    {
        "id": "shy_soft_avoidance",
        "keywords": ["害羞", "不好意思", "尴尬", "被夸"],
        "attitude": "柔和回避",
        "visual": ["低头", "视线躲闪", "弱笑"],
        "reference_axes": {
            "head_pitch": 40,
            "gaze_y": 42,
            "gaze_x": 58,
            "mouth_smile": 58,
            "brow_bias": 47,
        },
    },
    {
        "id": "tired_low_energy",
        "keywords": ["疲惫", "无力", "困", "低能量"],
        "attitude": "低能量",
        "visual": ["眼半闭", "头部下垂", "笑意降低"],
        "reference_axes": {
            "head_pitch": 35,
            "gaze_y": 36,
            "eye_open_left": 38,
            "eye_open_right": 38,
            "mouth_smile": 32,
        },
    },
]


def build_expression_keyword_reference_block() -> str:
    lines = [
        "表情关键词参考动作：",
        "参考轴值是 0-100 语义轴空间里的动作草图，不是必须照抄的硬约束，也不是 +/- 差值。",
        "只输出当前可控制参数中存在的轴；如果参考轴不存在，就忽略它。",
        "根据当前语气轻重在参考值附近调整；如果用户编辑了轴解释，以当前可控制参数说明为准。",
    ]
    for reference in EXPRESSION_KEYWORD_REFERENCES:
        keywords = "/".join(
            str(item).strip()
            for item in reference.get("keywords", [])
            if str(item).strip()
        )
        attitude = str(reference.get("attitude") or "").strip()
        visual = "、".join(
            str(item).strip()
            for item in reference.get("visual", [])
            if str(item).strip()
        )
        reference_axes = reference.get("reference_axes")
        reference_axes_json = json.dumps(
            reference_axes if isinstance(reference_axes, dict) else {},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        lines.append(
            f"- {keywords}：态度={attitude}；表现={visual}；参考轴值={reference_axes_json}"
        )
    return "\n".join(lines) + "\n\n"
