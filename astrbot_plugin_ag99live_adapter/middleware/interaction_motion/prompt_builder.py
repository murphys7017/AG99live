from __future__ import annotations

import json
from typing import Any

from .prompt_context import (
    _build_motion_runtime_reference_examples,
    _build_motion_variation_payload,
    _summarize_semantic_profile,
)
from .prompt_references import (
    _build_official_inline_motion_intent_example,
    _build_prompt_pose_reference_candidates,
    _select_prompt_resource_candidates,
)
from ...motion.pose_reference import build_pose_reference_candidates
from ...motion.resource_catalog import build_motion_resource_candidates
from ...protocol.schema_versions import MOTION_INTENT_V4_SCHEMA_VERSION

def _build_motion_static_capability_payload(runtime_state: Any) -> dict[str, Any]:
    capability_payload: dict[str, Any] = {
        "persona_effect_available": bool(
            getattr(runtime_state, "ag99live_motion_persona_effect_available", True)
        ),
    }
    profile_payload = _summarize_semantic_profile(runtime_state)
    raw_profile = profile_payload.pop("raw_profile", None)
    if not isinstance(raw_profile, dict):
        raise RuntimeError("semantic_motion_prompt_profile_payload_invalid")
    capability_payload["semantic_profile"] = profile_payload
    pose_reference_candidates = build_pose_reference_candidates(
        runtime_state=runtime_state,
        semantic_profile=raw_profile,
        limit=None,
    )
    prompt_pose_references = _build_prompt_pose_reference_candidates(
        pose_reference_candidates,
        semantic_profile=raw_profile,
        limit=4,
    )
    if prompt_pose_references:
        capability_payload["pose_reference_candidates"] = prompt_pose_references
    resource_candidates = build_motion_resource_candidates(
        runtime_state=runtime_state,
    )
    if resource_candidates:
        capability_payload["resource_candidates"] = resource_candidates

    return capability_payload

def _build_motion_decision_contract_text(capability_payload: dict[str, Any]) -> str:
    resource_candidates = capability_payload.get("resource_candidates")
    has_expression_resources = any(
        isinstance(item, dict) and item.get("resource_type") == "expression"
        for item in resource_candidates or []
    )
    has_motion_resources = any(
        isinstance(item, dict) and item.get("resource_type") == "motion"
        for item in resource_candidates or []
    )
    persona_effect_available = bool(capability_payload.get("persona_effect_available", True))
    resource_field_text = (
        "expression_resource_id 表示可与不冲突姿态叠加的表情资源；"
        "motion_resource_id 表示替代普通参数姿态播放的完整动作资源；"
        "两者不能同时填写；选择 expression 时必须省略该候选 conflicting_axis_ids 中的轴；"
        "不确定时两个资源字段都省略。"
        if has_expression_resources or has_motion_resources
        else ""
    )
    sequence_guidance = (
        (
            "用户明确要求且候选完整动作能表达整个连续表演时，优先选择对应 motion_resource_id；"
        )
        if has_motion_resources
        else ""
    ) + (
        "回复本身存在清晰的姿态转折、重心切换、追问句尾或短时夸张后的回收时，可以使用 motion_steps，"
        "按播放顺序输出 2 到 4 个姿态事件；只有一个稳定姿态时使用 axis_levels。"
        "不要按词语、停顿或语音节奏拆分 motion_steps。"
    )
    if persona_effect_available:
        output_contract_text = (
            "你正在控制一个 Live2D 模型，并为本轮回复生成可见动作。"
            "每个回复片段必须且只能调用一次动作效果；"
            "不要用多个动作调用表达动作序列。"
            f"{sequence_guidance}"
        )
        output_shape_text = ""
    else:
        inline_wrapper = {
            "mode": "inline",
            "intent": _build_official_inline_motion_intent_example(capability_payload),
        }
        inline_json = json.dumps(
            inline_wrapper,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        output_contract_text = (
            "当前 AstrBot 运行环境不支持动作注入函数；请把动作参数放入官方兼容标签 "
            "<@anim {...}>，并追加在回复末尾。标签外层只作为传输包装，内部 intent "
            f"字段必须是 {MOTION_INTENT_V4_SCHEMA_VERSION}，且遵循当前动作参数契约。"
            f"{sequence_guidance}"
        )
        output_shape_text = f" 输出标签示例：<@anim {inline_json}>"

    axis_instruction = (
        "等级语义是：-4=夸张负、-3=清晰可见负、-2=克制负、-1=细节负、"
        "0=明确中性、+1=细节正、+2=克制正、+3=清晰可见正、+4=夸张正；省略表示本轮不控制此轴；"
        "没有明确方向或表演贡献的轴直接省略。"
    )
    axis_shape_text = (
        "单姿态使用 axis_levels；动作序列使用 motion_steps；完整动作资源只使用 motion_resource_id。三者必须且只能选择一个。"
        "motion_steps 的所有步骤必须使用完全相同的轴集合，最后一步可以保持有意义的非中性姿态。"
        "axis_levels 只能使用下方列出的轴 id。"
    )
    return (
        f"{output_contract_text}"
        "intent_tags 用开放关键词概括本轮语气、姿态和场景。"
        f"{resource_field_text}"
        f"{axis_shape_text}"
        f"{axis_instruction}"
        "只输出本轮直接需要控制的轴；关系图可派生的跟随轴不要为了凑完整而重复输出。"
        "优先选择能表达姿态方向、视线焦点和身体重心的关键轴，再用少量表情轴补充情绪细节。"
        "在可用轴中优先用 head_yaw、head_roll、body_yaw、body_roll、gaze_x、gaze_y 表达左右朝向、侧倾和重心变化；"
        "head_pitch 只用于确有低头、抬头或点头语义的动作，不能作为通用强调动作。"
        "普通回复的主要姿态轴从 3 级开始；2 级用于克制表达，1 级仅用于细节，4 级用于短暂夸张表演。"
        "示例只展示结构和数值，不要照抄示例内容。"
        f"{output_shape_text}"
    )

def _build_motion_capability_prompt_payload(
    capability_payload: dict[str, Any],
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "axis_value_format": "axis_levels",
        "axis_level_scale": {
            "-4": "短时夸张负方向",
            "-3": "普通 Live2D 清晰可见负方向",
            "-2": "克制负方向",
            "-1": "局部细节或缓入负方向",
            "0": "明确回到中性",
            "1": "局部细节或缓入正方向",
            "2": "克制正方向",
            "3": "普通 Live2D 清晰可见正方向",
            "4": "短时夸张正方向",
            "omitted": "本轮不控制该轴",
        },
    }

    semantic_profile = capability_payload.get("semantic_profile")
    if isinstance(semantic_profile, dict):
        prompt_axes = semantic_profile.get("prompt_axes")
        if isinstance(prompt_axes, list):
            axis_fields = [
                "id",
                "label",
                "description",
                "control_role",
                "negative_semantics",
                "positive_semantics",
                "usage_notes",
            ]
            axis_fields.append("available_levels")
            result["axes"] = [
                {
                    key: axis.get(key)
                    for key in axis_fields
                    if axis.get(key) not in (None, "", [])
                }
                for axis in prompt_axes
                if isinstance(axis, dict) and str(axis.get("id") or "").strip()
            ]

    motion_instruction = str(capability_payload.get("motion_instruction") or "").strip()
    if motion_instruction:
        result["motion_generation_guidance"] = motion_instruction

    references = capability_payload.get("pose_reference_candidates")
    if isinstance(references, list):
        result["pose_references"] = [
            {
                key: item.get(key)
                for key in (
                    "label",
                    "description",
                    "emotion_bias",
                    "intensity",
                    "recommended_scenarios",
                    "pose_descriptors",
                    "key_axis_levels",
                )
                if item.get(key) not in (None, "", [])
            }
            for item in references
            if isinstance(item, dict)
        ]

    resources = capability_payload.get("resource_candidates")
    if isinstance(resources, list):
        allowed_axis_ids = {
            str(item.get("id") or "").strip()
            for item in result.get("axes") or []
            if isinstance(item, dict) and str(item.get("id") or "").strip()
        }
        result["resources"] = [
            {
                key: (
                    [
                        axis_id
                        for axis_id in item.get("conflicting_axis_ids") or []
                        if axis_id in allowed_axis_ids
                    ]
                    if key == "conflicting_axis_ids"
                    else item.get(key)
                )
                for key in (
                    "resource_id",
                    "resource_type",
                    "label",
                    "description",
                    "tags",
                    "emotion_bias",
                    "recommended_scenarios",
                    "intensity",
                    "conflicting_axis_ids",
                )
                if (
                    key != "conflicting_axis_ids"
                    and item.get(key) not in (None, "", [])
                ) or (
                    key == "conflicting_axis_ids"
                    and any(
                        axis_id in allowed_axis_ids
                        for axis_id in item.get("conflicting_axis_ids") or []
                    )
                )
            }
            for item in _select_prompt_resource_candidates(resources)
            if isinstance(item, dict)
        ]
    return result

def _build_motion_runtime_payload(
    event: Any,
    turn_coordinator: Any,
    runtime_state: Any,
    *,
    capability_payload: dict[str, Any],
    view: Any,
) -> tuple[dict[str, Any], list[str]]:
    del view
    payload: dict[str, Any] = {}
    reference_resolution = _build_motion_runtime_reference_examples(
        event=event,
        runtime_state=runtime_state,
        capability_payload=capability_payload,
    )
    reference_examples = reference_resolution["examples"]
    if reference_examples:
        payload["reference_examples"] = reference_examples
    reference_diagnostics = reference_resolution["diagnostics"]
    previous_motion_payload = _build_motion_variation_payload(
        turn_coordinator,
        runtime_state=runtime_state,
    )
    if previous_motion_payload:
        payload.update(previous_motion_payload)
    return payload, reference_diagnostics
