from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from astrbot.api import logger
from astrbot.core.interaction import InteractionResultContribution
try:
    from astrbot.core.interaction import (
        get_interaction_route_decision as get_interaction_reply_plan,
    )
except ImportError:  # pragma: no cover - only older AstrBot cores expose the legacy name.
    from astrbot.core.interaction import (
        get_interaction_decision as get_interaction_reply_plan,
    )
try:
    from astrbot.core.interaction import PersonaEffectSpec
except ImportError:  # pragma: no cover - older AstrBot cores do not expose it.
    PersonaEffectSpec = None  # type: ignore[assignment]
from astrbot.core.prompt import PromptExtension

from .motion_payload import (
    are_motion_axes_all_neutralish as _payload_are_motion_axes_all_neutralish,
    build_motion_visibility_summary as _payload_build_motion_visibility_summary,
    build_prompt_axis_lookup as _payload_build_prompt_axis_lookup,
    build_prompt_axis_lookup_from_axes as _payload_build_prompt_axis_lookup_from_axes,
    describe_axis_descriptors as _payload_describe_axis_descriptors,
    describe_axis_descriptor as _payload_describe_axis_descriptor,
    is_axis_soft_range_neutral as _payload_is_axis_soft_range_neutral,
    normalize_motion_arguments_payload as _payload_normalize_motion_arguments_payload,
    resolve_axis_descriptor_threshold as _payload_resolve_axis_descriptor_threshold,
    resolve_axis_neutral_delta as _payload_resolve_axis_neutral_delta,
    resolve_axis_neutral_value as _payload_resolve_axis_neutral_value,
    resolve_axis_soft_range as _payload_resolve_axis_soft_range,
    resolve_axis_value_range as _payload_resolve_axis_value_range,
    validate_motion_resource_id_for_payload as _payload_validate_motion_resource_id,
)
from ..motion.output_sanitizer import sanitize_assistant_output_text
from ..motion.motion_intent import (
    DEFAULT_MOTION_INTENT_DURATION_MS,
    resolve_selected_semantic_axis_profile,
)
from ..motion.resource_catalog import (
    build_motion_resource_candidates,
)
from ..motion.fallback_pose import (
    build_fallback_pose_candidates,
)
from ..prompts.motion_selector import (
    resolve_motion_prompt_instruction,
)
from ..prompts.semantic_axis_prompt import (
    format_profile_axis_prompt_line,
    profile_prompt_axes,
    resolve_available_axis_levels,
)
from ..runtime.motion_lab import enqueue_motion_lab_raw_event

AG99LIVE_PLUGIN_ID = "astrbot_plugin_ag99live_adapter"
AG99LIVE_MOTION_EFFECT_NAME = "ag99live.motion"
PROMPT_VARIATION_AXIS_IDS = ("head_yaw", "body_yaw")
INTERACTION_ROUTE_DECISION_EXTRA_KEY = "_interaction_route_decision"


@dataclass(slots=True)
class _MotionRuntimeBundle:
    adapter: Any
    turn_coordinator: Any
    runtime_state: Any


@dataclass(slots=True)
class _FrontendIdentitySnapshot:
    event_frontend_turn_id: str | None
    active_frontend_turn_id: str | None

    @property
    def scheduled_frontend_turn_id(self) -> str | None:
        return self.event_frontend_turn_id or self.active_frontend_turn_id


@dataclass(slots=True)
class _InteractionReplyPlanSnapshot:
    route_mode: str | None
    should_emit_immediate_reply: bool | None
    source: str


@dataclass(slots=True)
class _MotionSchedulePolicy:
    should_schedule: bool
    source: str | None
    reason: str


@dataclass(slots=True)
class _MotionScheduleAttempt:
    phase: str
    source: str | None
    scheduled_frontend_turn_id: str | None
    event_frontend_turn_id: str | None
    active_frontend_turn_id: str | None
    reply_plan_route_mode: str | None
    reply_plan_should_emit_immediate_reply: bool | None
    reply_plan_source: str | None
    motion_generation_mode: str
    scheduled: bool
    reason: str
    assistant_text: str
    motion_payload: dict[str, Any] | None = None
    motion_resolution_reason: str | None = None

    def to_metadata(self) -> dict[str, Any]:
        metadata = {
            "phase": self.phase,
            "source": self.source,
            "scheduled_frontend_turn_id": self.scheduled_frontend_turn_id,
            "event_frontend_turn_id": self.event_frontend_turn_id,
            "active_frontend_turn_id": self.active_frontend_turn_id,
            "reply_plan_route_mode": self.reply_plan_route_mode,
            "reply_plan_should_emit_immediate_reply": self.reply_plan_should_emit_immediate_reply,
            "reply_plan_source": self.reply_plan_source,
            "motion_generation_mode": self.motion_generation_mode,
            "scheduled": self.scheduled,
            "reason": self.reason,
        }
        if self.motion_resolution_reason:
            metadata["motion_resolution_reason"] = self.motion_resolution_reason
        return metadata


class AG99liveMotionPromptContributor:
    plugin_id = "ag99live.motion.prompt"
    priority = 40

    async def collect(self, event, plugin_context, view):
        del plugin_context

        bundle = _resolve_motion_runtime_bundle(event)
        if bundle is None:
            return None

        if not _should_contribute_motion_prompt(view):
            return None

        static_capability_payload = _build_motion_static_capability_payload(
            bundle.runtime_state
        )
        runtime_payload = _build_motion_runtime_payload(
            event,
            bundle.turn_coordinator,
            bundle.runtime_state,
            view=view,
        )

        extensions = [
            PromptExtension(
                plugin_id=self.plugin_id,
                mount="system",
                title="Live2D Motion Decision",
                value_kind="text",
                value=_build_motion_decision_contract_text(static_capability_payload),
                order=39,
                meta={
                    "scope": "static",
                    "node_type": "ag99live_motion_decision_contract",
                },
            ),
            PromptExtension(
                plugin_id=self.plugin_id,
                mount="capability",
                title="Live2D Motion Capability",
                value_kind="mapping",
                value=_build_motion_capability_prompt_payload(
                    static_capability_payload
                ),
                order=40,
                meta={
                    "scope": "static",
                    "node_type": "ag99live_motion_capability",
                },
            ),
        ]
        if runtime_payload:
            extensions.append(
                PromptExtension(
                    plugin_id=self.plugin_id,
                    mount="context",
                    title="Previous Live2D Motion",
                    value_kind="mapping",
                    value=runtime_payload,
                    order=41,
                    meta={
                        "scope": "dynamic",
                        "node_type": "live2d_previous_motion",
                    },
                )
            )
        return extensions


class AG99liveMotionResultContributor:
    plugin_id = "ag99live.motion.result"
    priority = 40

    async def collect(self, event, plugin_context, view):
        del plugin_context

        attempt = await _schedule_motion_from_interaction_result(event, view)
        if attempt is None:
            return None

        client_objects = []
        if attempt.motion_payload is not None:
            client_objects.append(
                {
                    "type": "ag99live.motion_payload",
                    "motion_payload": attempt.motion_payload,
                    "mode": "preview",
                    "source": attempt.source or "persona_effect",
                }
            )
        return InteractionResultContribution(
            plugin_id=self.plugin_id,
            client_objects=client_objects,
            metadata={"ag99live_motion_schedule": attempt.to_metadata()},
            priority=self.priority,
        )


def register_ag99live_interaction_contributors(context: Any) -> None:
    _register_ag99live_motion_persona_effect(context)

    register_prompt = getattr(context, "register_interaction_prompt_contributor", None)
    if callable(register_prompt):
        register_prompt(AG99liveMotionPromptContributor())

    register_result = getattr(context, "register_interaction_result_contributor", None)
    if callable(register_result):
        register_result(AG99liveMotionResultContributor())


def _register_ag99live_motion_persona_effect(context: Any) -> None:
    if PersonaEffectSpec is None:
        return

    unregister_effects = getattr(context, "unregister_persona_effects", None)
    if callable(unregister_effects):
        unregister_effects(plugin_id=AG99LIVE_PLUGIN_ID)

    register_effect = getattr(context, "register_persona_effect", None)
    if not callable(register_effect):
        return

    register_effect(
        PersonaEffectSpec(
            plugin_id=AG99LIVE_PLUGIN_ID,
            name=AG99LIVE_MOTION_EFFECT_NAME,
            description=(
                "Generate Live2D motion intent for persona expression. Describe "
                "the visible performance with intent_tags and choose meaningful "
                "semantic axis levels for this turn. Select at most one typed resource "
                "only when a listed expression or complete motion is clearly appropriate. "
                "Emit exactly one motion effect for an assistant segment; never "
                "split a movement sequence into multiple effects."
            ),
            parameters={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "intent_tags": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 6,
                        "uniqueItems": True,
                        "items": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 48,
                        },
                    },
                    "axis_levels": {
                        "type": "object",
                        "additionalProperties": {
                            "type": "integer",
                            "minimum": -4,
                            "maximum": 4,
                        },
                        "minProperties": 1,
                        "maxProperties": 6,
                    },
                    "motion_steps": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": 4,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "axis_levels": {
                                    "type": "object",
                                    "additionalProperties": {
                                        "type": "integer",
                                        "minimum": -4,
                                        "maximum": 4,
                                    },
                                    "minProperties": 1,
                                    "maxProperties": 6,
                                },
                                "duration_weight": {
                                    "type": "integer",
                                    "minimum": 1,
                                    "maximum": 3,
                                },
                            },
                            "required": ["axis_levels", "duration_weight"],
                        },
                    },
                    "duration_hint_ms": {
                        "type": "integer",
                        "minimum": 320,
                        "maximum": 15000,
                    },
                    "expression_resource_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                    },
                    "motion_resource_id": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                    },
                },
                "required": ["intent_tags"],
                "oneOf": [
                    {"required": ["axis_levels"]},
                    {"required": ["motion_steps"]},
                ],
                "allOf": [
                    {
                        "not": {
                            "required": [
                                "expression_resource_id",
                                "motion_resource_id",
                            ],
                        },
                    },
                    {
                        "not": {
                            "required": [
                                "motion_steps",
                                "motion_resource_id",
                            ],
                        },
                    },
                ],
            },
        )
    )


def _resolve_motion_runtime_bundle(event: Any) -> _MotionRuntimeBundle | None:
    platform_id = _call_event_method(event, "get_platform_id")
    platform_name = _call_event_method(event, "get_platform_name")
    if platform_id != "olv_pet_adapter" and platform_name != "olv_pet_adapter":
        return None

    adapter = getattr(event, "adapter", None)
    turn_coordinator = getattr(adapter, "turn_coordinator", None)
    runtime_state = getattr(turn_coordinator, "runtime_state", None)
    if adapter is None or turn_coordinator is None or runtime_state is None:
        return None

    return _MotionRuntimeBundle(
        adapter=adapter,
        turn_coordinator=turn_coordinator,
        runtime_state=runtime_state,
    )


def _resolve_persona_effect_motion_payload(
    event: Any,
    runtime_state: Any,
    *,
    view: Any = None,
) -> dict[str, Any] | None:
    payload, _reason = _resolve_persona_effect_motion_payload_with_reason(
        event,
        runtime_state,
        view=view,
    )
    return payload


def _resolve_persona_effect_motion_payload_with_reason(
    event: Any,
    runtime_state: Any,
    *,
    view: Any = None,
) -> tuple[dict[str, Any] | None, str]:
    raw_arguments, effect_reason = _extract_ag99live_motion_effect_arguments(event, view)
    if raw_arguments is None:
        return None, effect_reason
    return _normalize_motion_arguments_payload(
        raw_arguments,
        runtime_state,
        base_reason=effect_reason,
    )


def _normalize_motion_arguments_payload(
    raw_motion_arguments: dict[str, Any],
    runtime_state: Any,
    *,
    base_reason: str,
) -> tuple[dict[str, Any] | None, str]:
    return _payload_normalize_motion_arguments_payload(
        raw_motion_arguments,
        runtime_state,
        base_reason=base_reason,
        append_resolution_reason=_append_resolution_reason,
        sanitize_reason_fragment=_sanitize_reason_fragment,
    )


def _extract_ag99live_motion_effect_arguments(event: Any, view: Any) -> tuple[dict[str, Any] | None, str]:
    effect_calls = _extract_effect_calls_for_motion(event, view)
    if not effect_calls:
        return None, "effect_calls_missing"

    matching_calls = []
    for raw_call in effect_calls:
        call = _thaw_snapshot_value(raw_call)
        name = _effect_call_get(call, "name")
        if str(name or "").strip() != AG99LIVE_MOTION_EFFECT_NAME:
            continue
        matching_calls.append(call)

    if len(matching_calls) > 1:
        return None, "persona_effect_duplicate"

    if matching_calls:
        call = matching_calls[0]
        arguments = _effect_call_get(call, "arguments")
        arguments = _thaw_snapshot_value(arguments)
        if isinstance(arguments, Mapping):
            return {
                str(key): _thaw_snapshot_value(value)
                for key, value in arguments.items()
            }, "persona_effect"
        return None, "persona_effect_arguments_invalid"

    return None, "ag99live_motion_effect_missing"


def _extract_effect_calls_for_motion(event: Any, view: Any) -> list[Any]:
    if _resolve_result_phase(view) == "final":
        raw_calls = _call_event_method(
            event,
            "get_extra",
            "_interaction_final_response_effect_calls",
            None,
        )
        thawed_calls = _thaw_snapshot_value(raw_calls)
        if isinstance(thawed_calls, list):
            return thawed_calls
    return _extract_effect_calls_from_view(view)


def _extract_effect_calls_from_view(view: Any) -> list[Any]:
    raw_calls = getattr(view, "effect_calls", None)
    if raw_calls is None:
        metadata = getattr(view, "metadata", None)
        if isinstance(metadata, Mapping):
            raw_calls = metadata.get("effect_calls")
        elif callable(getattr(metadata, "get", None)):
            raw_calls = metadata.get("effect_calls")
    if raw_calls is None:
        result = getattr(view, "result", None)
        if result is not None:
            raw_calls = getattr(result, "effect_calls", None)

    thawed = _thaw_snapshot_value(raw_calls)
    if isinstance(thawed, list):
        return thawed
    return []


def _effect_call_get(call: Any, key: str) -> Any:
    if isinstance(call, Mapping):
        return call.get(key)
    return getattr(call, key, None)


def _validate_motion_resource_id(
    resource_id: Any,
    *,
    candidates: list[dict[str, Any]],
) -> tuple[str, str]:
    return _payload_validate_motion_resource_id(
        resource_id,
        candidates=candidates,
        sanitize_reason_fragment=_sanitize_reason_fragment,
    )


def _are_motion_axes_all_neutralish(
    axes: dict[str, float],
    semantic_profile: dict[str, Any],
) -> bool:
    return _payload_are_motion_axes_all_neutralish(axes, semantic_profile)


def _build_motion_visibility_summary(
    *,
    axes: dict[str, float],
    semantic_profile: dict[str, Any],
    intent_tags: list[str] | None = None,
    resource_id: str = "",
) -> dict[str, Any]:
    return _payload_build_motion_visibility_summary(
        axes=axes,
        semantic_profile=semantic_profile,
        intent_tags=intent_tags,
        resource_id=resource_id,
    )


def _is_axis_soft_range_neutral(value: float, axis: dict[str, Any]) -> bool:
    return _payload_is_axis_soft_range_neutral(value, axis)


def _resolve_axis_value_range(axis: dict[str, Any]) -> tuple[float, float]:
    return _payload_resolve_axis_value_range(axis)


def _build_motion_static_capability_payload(runtime_state: Any) -> dict[str, Any]:
    capability_payload: dict[str, Any] = {
        "persona_effect_available": bool(
            getattr(runtime_state, "ag99live_motion_persona_effect_available", True)
        ),
        "motion_instruction": resolve_motion_prompt_instruction(
            runtime_state=runtime_state
        ),
    }
    build_style_prompt = getattr(runtime_state, "build_motion_tuning_style_prompt", None)
    if callable(build_style_prompt):
        style_prompt = str(build_style_prompt() or "").strip()
        if style_prompt:
            capability_payload["motion_style_prompt"] = style_prompt
    list_reference_examples = getattr(
        runtime_state,
        "list_effective_motion_tuning_examples",
        None,
    )
    if callable(list_reference_examples):
        reference_examples = list_reference_examples()
        if reference_examples:
            capability_payload["reference_examples"] = reference_examples

    profile_payload, profile_error = _summarize_semantic_profile(
        runtime_state,
        use_axis_levels=capability_payload["persona_effect_available"],
    )
    if profile_payload is None:
        raise RuntimeError(
            f"semantic_motion_prompt_profile_unavailable:{profile_error or 'unknown_error'}"
        )
    raw_profile = profile_payload.pop("raw_profile", None)
    if not isinstance(raw_profile, dict):
        raise RuntimeError("semantic_motion_prompt_profile_payload_invalid")
    capability_payload["semantic_profile"] = profile_payload
    fallback_candidates = build_fallback_pose_candidates(
        runtime_state=runtime_state,
        semantic_profile=raw_profile,
        limit=None,
    )
    prompt_fallback_candidates = _build_prompt_fallback_pose_candidates(
        fallback_candidates,
        semantic_profile=raw_profile,
        limit=4,
    )
    if prompt_fallback_candidates:
        capability_payload["fallback_pose_candidates"] = prompt_fallback_candidates
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
    axis_field_name = "axis_levels" if persona_effect_available else "axes"
    optional_fields = ["duration_hint_ms"]
    if has_expression_resources:
        optional_fields.append("expression_resource_id")
    if has_motion_resources:
        optional_fields.append("motion_resource_id")
    allowed_fields_text = (
        "必填字段是 intent_tags，并且 axis_levels 与 motion_steps 必须二选一；"
        f"可选字段只有 {'、'.join(optional_fields)}。"
        if persona_effect_available
        else f"必填字段是 intent_tags 和 {axis_field_name}；"
        f"可选字段只有 {'、'.join(optional_fields)}。"
    )
    resource_field_text = (
        "expression_resource_id 表示可与不冲突姿态叠加的表情资源；"
        "motion_resource_id 表示替代普通参数姿态播放的完整动作资源；"
        "两者不能同时填写；选择 expression 时必须省略该候选 conflicting_axis_ids 中的轴；"
        "不确定时两个资源字段都省略。"
        if has_expression_resources or has_motion_resources
        else ""
    )
    if persona_effect_available:
        sequence_guidance = (
            "用户明确要求连续、往返或分阶段动作时，优先选择一个能完整表达该序列的 motion_resource_id；"
            "没有合适资源时使用 motion_steps，按播放顺序输出 2 到 4 步。"
            if has_motion_resources
            else "用户明确要求连续、往返或分阶段动作时使用 motion_steps，按播放顺序输出 2 到 4 步。"
        )
        output_contract_text = (
            "你正在控制一个 Live2D 模型，并为本轮回复生成可见动作。"
            "每个回复片段必须且只能调用一次动作效果；"
            "不要用多个动作调用表达动作序列。"
            f"{sequence_guidance}"
            f"{allowed_fields_text}"
        )
        output_shape_text = ""
    else:
        inline_wrapper = {
            "mode": "inline",
            "intent": _build_official_inline_motion_intent_example(capability_payload),
        }
        import json

        inline_json = json.dumps(
            inline_wrapper,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        output_contract_text = (
            "当前 AstrBot 运行环境不支持动作注入函数；请把动作参数放入官方兼容标签 "
            "<@anim {...}>，并追加在回复末尾。标签外层只作为传输包装，内部 intent "
            f"字段必须是 engine.motion_intent.v3，且遵循当前动作参数契约。{allowed_fields_text}"
        )
        output_shape_text = f" 输出标签示例：<@anim {inline_json}>"

    axis_instruction = (
        "每个值必须是 -4 到 4 的整数等级：-4=夸张负、-3=清晰可见负、-2=克制负、-1=细节负、"
        "0=明确中性、+1=细节正、+2=克制正、+3=清晰可见正、+4=夸张正；省略表示本轮不控制此轴；"
        "没有明确方向或表演贡献的轴直接省略。"
        if persona_effect_available
        else "每个值都直接写成 JSON number；没有明确方向或表演贡献的轴直接省略。"
    )
    axis_shape_text = (
        "单姿态使用 axis_levels；动作序列使用 motion_steps。两者必须且只能选择一个。"
        "motion_steps 每步都必须提供 axis_levels 和 duration_weight；所有步骤必须使用完全相同的轴集合，"
        "duration_weight 只能是 1 到 3 的整数。axis_levels 只能使用下方列出的轴 id。"
        if persona_effect_available
        else f"{axis_field_name} 是必填对象，只能使用下方列出的轴 id。"
    )
    return (
        f"{output_contract_text}"
        "intent_tags 用 1 到 6 个开放关键词概括本轮语气、姿态和场景。"
        f"{resource_field_text}"
        f"{axis_shape_text}"
        f"{axis_instruction}"
        "只输出本轮直接需要控制的轴，最多 6 个；关系图可派生的跟随轴不要为了凑完整而重复输出。"
        "优先选择能表达姿态方向、视线焦点和身体重心的关键轴，再用少量表情轴补充情绪细节。"
        "普通回复的主要姿态轴从 3 级开始；2 级用于克制表达，1 级仅用于细节，4 级用于短暂夸张表演。"
        "示例只展示结构和数值，不要照抄示例内容。"
        f"{output_shape_text}"
    )


def _build_motion_capability_prompt_payload(
    capability_payload: dict[str, Any],
) -> dict[str, Any]:
    persona_effect_available = bool(
        capability_payload.get("persona_effect_available", True)
    )
    result: dict[str, Any] = {
        "axis_value_format": "axis_levels" if persona_effect_available else "axes",
    }
    if persona_effect_available:
        result["axis_level_scale"] = {
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
            if persona_effect_available:
                axis_fields.append("available_levels")
            else:
                axis_fields.insert(3, "value_range")
            result["axes"] = [
                {
                    key: axis.get(key)
                    for key in axis_fields
                    if axis.get(key) not in (None, "", [])
                }
                for axis in prompt_axes
                if isinstance(axis, dict) and str(axis.get("id") or "").strip()
            ]

    style_prompt = str(capability_payload.get("motion_style_prompt") or "").strip()
    if style_prompt:
        result["character_motion_style"] = style_prompt
    motion_instruction = str(capability_payload.get("motion_instruction") or "").strip()
    if motion_instruction:
        result["motion_generation_guidance"] = motion_instruction

    reference_examples = capability_payload.get("reference_examples")
    if persona_effect_available and isinstance(reference_examples, list):
        allowed_axis_ids = {
            str(item.get("id") or "").strip()
            for item in result.get("axes") or []
            if isinstance(item, dict) and str(item.get("id") or "").strip()
        }
        available_levels_by_axis = {
            str(item.get("id") or "").strip(): set(item.get("available_levels") or [])
            for item in result.get("axes") or []
            if isinstance(item, dict) and str(item.get("id") or "").strip()
        }
        projected_examples = _project_reference_examples_for_prompt(
            reference_examples,
            allowed_axis_ids=allowed_axis_ids,
            available_levels_by_axis=available_levels_by_axis,
        )
        if projected_examples:
            result["reference_examples"] = projected_examples

    references = capability_payload.get("fallback_pose_candidates")
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


def _project_reference_examples_for_prompt(
    examples: list[Any],
    *,
    allowed_axis_ids: set[str],
    available_levels_by_axis: dict[str, set[int]],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in examples:
        if not isinstance(item, dict):
            raise ValueError("motion_reference_example_shape_invalid")
        input_text = str(item.get("input") or "").strip()
        output = item.get("output")
        if not input_text or not isinstance(output, dict):
            raise ValueError("motion_reference_example_shape_invalid")
        raw_intent_tags = output.get("intent_tags")
        if not isinstance(raw_intent_tags, list):
            raise ValueError("motion_reference_example_intent_tags_invalid")
        if any(not isinstance(tag, str) for tag in raw_intent_tags):
            raise ValueError("motion_reference_example_intent_tags_invalid")
        intent_tags = [tag.strip() for tag in raw_intent_tags if tag.strip()]
        if (
            not 1 <= len(intent_tags) <= 6
            or len(set(intent_tags)) != len(intent_tags)
            or any(len(tag) > 48 for tag in intent_tags)
        ):
            raise ValueError("motion_reference_example_intent_tags_invalid")
        has_axis_levels = "axis_levels" in output
        has_motion_steps = "motion_steps" in output
        if has_axis_levels == has_motion_steps:
            raise ValueError("motion_reference_example_motion_shape_invalid")
        projected_output: dict[str, Any] = {
            "intent_tags": intent_tags,
        }
        duration_hint_ms = output.get("duration_hint_ms")
        if (
            isinstance(duration_hint_ms, int)
            and not isinstance(duration_hint_ms, bool)
            and 320 <= duration_hint_ms <= 15000
        ):
            projected_output["duration_hint_ms"] = duration_hint_ms
        elif duration_hint_ms is not None:
            raise ValueError("motion_reference_example_duration_invalid")
        axis_levels = (
            _project_example_axis_levels(
                output.get("axis_levels"),
                allowed_axis_ids=allowed_axis_ids,
                available_levels_by_axis=available_levels_by_axis,
            )
            if has_axis_levels
            else {}
        )
        if axis_levels:
            projected_output["axis_levels"] = axis_levels
        else:
            motion_steps = output.get("motion_steps")
            projected_steps: list[dict[str, Any]] = []
            if isinstance(motion_steps, list) and 2 <= len(motion_steps) <= 4:
                for step in motion_steps:
                    if not isinstance(step, dict):
                        raise ValueError("motion_reference_example_step_invalid")
                    step_levels = _project_example_axis_levels(
                        step.get("axis_levels"),
                        allowed_axis_ids=allowed_axis_ids,
                        available_levels_by_axis=available_levels_by_axis,
                    )
                    if not step_levels:
                        projected_steps = []
                        break
                    duration_weight = step.get("duration_weight")
                    if (
                        not isinstance(duration_weight, int)
                        or isinstance(duration_weight, bool)
                        or not 1 <= duration_weight <= 3
                    ):
                        raise ValueError("motion_reference_example_step_invalid")
                    projected_steps.append(
                        {
                            "axis_levels": step_levels,
                            "duration_weight": duration_weight,
                        }
                    )
                projected_axis_sets = {
                    tuple(step["axis_levels"].keys())
                    for step in projected_steps
                }
                if len(projected_axis_sets) > 1:
                    raise ValueError("motion_reference_example_step_axes_mismatch")
            elif motion_steps is not None:
                raise ValueError("motion_reference_example_steps_invalid")
            if projected_steps:
                projected_output["motion_steps"] = projected_steps
            else:
                continue
        result.append({"input": input_text, "output": projected_output})
    return result


def _project_example_axis_levels(
    value: Any,
    *,
    allowed_axis_ids: set[str],
    available_levels_by_axis: dict[str, set[int]],
) -> dict[str, int]:
    if not isinstance(value, dict):
        raise ValueError("motion_reference_example_axis_levels_invalid")
    result: dict[str, int] = {}
    for axis_id, level in value.items():
        normalized_axis_id = str(axis_id).strip()
        if normalized_axis_id not in allowed_axis_ids:
            continue
        if (
            not isinstance(level, int)
            or isinstance(level, bool)
            or not -4 <= level <= 4
        ):
            raise ValueError(
                f"motion_reference_example_axis_level_invalid:{normalized_axis_id}"
            )
        if level not in available_levels_by_axis.get(normalized_axis_id, set()):
            raise ValueError(
                "motion_reference_example_axis_level_unavailable:"
                f"{normalized_axis_id}:{level}"
            )
        result[normalized_axis_id] = level
    return result


def _select_prompt_resource_candidates(
    resources: list[Any],
    *,
    limit_per_type: int = 8,
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    counts = {"expression": 0, "motion": 0}
    for item in resources:
        if not isinstance(item, dict):
            continue
        resource_type = str(item.get("resource_type") or "").strip()
        if resource_type not in counts or counts[resource_type] >= limit_per_type:
            continue
        counts[resource_type] += 1
        selected.append(item)
    return selected


def _build_official_inline_motion_intent_example(
    capability_payload: dict[str, Any],
) -> dict[str, Any]:
    semantic_profile = capability_payload.get("semantic_profile")
    intent: dict[str, Any] = {
        "schema_version": "engine.motion_intent.v3",
        "profile_id": "",
        "profile_revision": 1,
        "model_id": "",
        "mode": "expressive",
        "intent_tags": ["语气关键词", "姿态关键词", "场景关键词"],
        "duration_hint_ms": 1000,
        "axes": {},
    }
    if isinstance(semantic_profile, dict):
        intent["profile_id"] = str(semantic_profile.get("profile_id") or "")
        profile_revision = semantic_profile.get("profile_revision")
        if isinstance(profile_revision, int) and profile_revision > 0:
            intent["profile_revision"] = profile_revision
        intent["model_id"] = str(semantic_profile.get("model_id") or "")
    if isinstance(semantic_profile, dict):
        prompt_axes = semantic_profile.get("prompt_axes")
        if isinstance(prompt_axes, list):
            intent["axes"] = {
                str(axis.get("id") or "").strip(): _resolve_axis_example_value(axis, index=index)
                for index, axis in enumerate(
                    _select_motion_format_example_axes(prompt_axes, limit=5)
                )
                if isinstance(axis, dict) and str(axis.get("id") or "").strip()
            }
    return intent


def _build_prompt_fallback_pose_candidates(
    fallback_candidates: list[dict[str, Any]],
    *,
    semantic_profile: dict[str, Any] | None = None,
    limit: int,
) -> list[dict[str, Any]]:
    axis_by_id = _build_prompt_axis_lookup(semantic_profile)
    selected_candidates = _select_representative_fallback_pose_candidates(
        fallback_candidates,
        axis_by_id=axis_by_id,
        limit=limit,
    )
    result: list[dict[str, Any]] = []
    for item in selected_candidates:
        pose_id = str(item.get("id") or "").strip()
        source = str(item.get("source") or "").strip()
        result.append(
            {
                "id": pose_id,
                "label": str(item.get("label") or pose_id).strip(),
                "emotion_label": str(item.get("emotion_label") or "").strip(),
                "description": _truncate_text(
                    str(item.get("description") or "").strip(),
                    96,
                ),
                "emotion_bias": _normalize_axis_text_list(item.get("emotion_bias"))[:4],
                "intensity": str(item.get("intensity") or "").strip(),
                "recommended_scenarios": _normalize_axis_text_list(
                    item.get("recommended_scenarios")
                )[:4],
                "pose_descriptors": _describe_axis_descriptors(
                    item.get("axes"),
                    axis_by_id=axis_by_id,
                )[:4],
                "key_axis_levels": _summarize_key_axis_levels(
                    item.get("axes"),
                    axis_by_id=axis_by_id,
                    limit=5,
                ),
                "source": source,
            }
        )
    return result


def _select_representative_fallback_pose_candidates(
    fallback_candidates: list[dict[str, Any]],
    *,
    axis_by_id: Mapping[str, dict[str, Any]] | None = None,
    limit: int,
) -> list[dict[str, Any]]:
    max_items = max(0, limit)
    if max_items <= 0:
        return []

    candidates = [
        item
        for item in fallback_candidates
        if _is_prompt_fallback_pose_candidate(item)
    ]
    if not candidates:
        return []

    by_signature: dict[str, list[dict[str, Any]]] = {}
    for item in candidates:
        signature = _classify_prompt_fallback_pose_signature(item, axis_by_id=axis_by_id)
        by_signature.setdefault(signature, []).append(item)

    for signature_candidates in by_signature.values():
        signature_candidates.sort(
            key=_score_prompt_fallback_pose_candidate,
            reverse=True,
        )

    selected: list[dict[str, Any]] = []
    selected_ids: set[str] = set()
    ranked_signatures = sorted(
        by_signature.items(),
        key=lambda entry: _score_prompt_fallback_signature(entry[0], entry[1]),
        reverse=True,
    )
    for _signature, signature_candidates in ranked_signatures:
        if len(selected) >= max_items:
            break
        item = signature_candidates[0]
        candidate_id = str(item.get("id") or "").strip()
        if candidate_id in selected_ids:
            continue
        selected.append(item)
        selected_ids.add(candidate_id)

    if len(selected) < min(2, max_items):
        ranked = sorted(
            candidates,
            key=_score_prompt_fallback_pose_candidate,
            reverse=True,
        )
        for item in ranked:
            if len(selected) >= min(2, max_items):
                break
            candidate_id = str(item.get("id") or "").strip()
            if candidate_id in selected_ids:
                continue
            selected.append(item)
            selected_ids.add(candidate_id)

    return selected[:max_items]


def _is_prompt_fallback_pose_candidate(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    pose_id = str(item.get("id") or "").strip()
    if not pose_id:
        return False
    axes = item.get("axes")
    return isinstance(axes, dict) and bool(axes)


def _classify_prompt_fallback_pose_signature(
    item: dict[str, Any],
    *,
    axis_by_id: Mapping[str, dict[str, Any]] | None = None,
) -> str:
    descriptors = _describe_axis_descriptors(item.get("axes"), axis_by_id=axis_by_id)
    if descriptors:
        return "+".join(descriptors[:3])
    return "metadata:" + _normalize_prompt_fallback_metadata_signature(item)


def _describe_axis_descriptors(
    value: Any,
    *,
    axis_by_id: Mapping[str, dict[str, Any]] | None = None,
) -> list[str]:
    return _payload_describe_axis_descriptors(value, axis_by_id=axis_by_id)


def _describe_axis_descriptor(
    axis_id: str,
    value: float,
    *,
    axis: dict[str, Any] | None = None,
) -> str:
    return _payload_describe_axis_descriptor(axis_id, value, axis=axis)


def _build_prompt_axis_lookup(
    semantic_profile: dict[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    return _payload_build_prompt_axis_lookup(semantic_profile)


def _build_prompt_axis_lookup_from_axes(
    prompt_axes: list[dict[str, Any]] | None,
) -> dict[str, dict[str, Any]]:
    return _payload_build_prompt_axis_lookup_from_axes(prompt_axes)


def _resolve_axis_soft_range(axis: dict[str, Any] | None) -> tuple[float, float] | None:
    return _payload_resolve_axis_soft_range(axis)


def _resolve_axis_neutral_delta(value: float, axis: dict[str, Any] | None) -> float:
    return _payload_resolve_axis_neutral_delta(value, axis)


def _resolve_axis_descriptor_threshold(axis: dict[str, Any] | None) -> float:
    return _payload_resolve_axis_descriptor_threshold(axis)


def _normalize_prompt_fallback_metadata_signature(item: dict[str, Any]) -> str:
    for key in ("label", "emotion_label", "id"):
        value = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff]+", "_", str(item.get(key) or "").strip())
        if value:
            return value[:48]
    return "unknown"


def _score_prompt_fallback_signature(
    signature: str,
    candidates: list[dict[str, Any]],
) -> tuple[int, int, str]:
    descriptors = [part for part in signature.split("+") if part]
    descriptor_score = min(len(descriptors), 3) * 20
    skeleton_score = 0
    if any(part.startswith(("look_", "tilt_", "gaze_")) for part in descriptors):
        skeleton_score += 12
    if any(part.startswith(("body_", "lean_")) for part in descriptors):
        skeleton_score += 10
    if any("eye" in part or "mouth" in part or "brow" in part for part in descriptors):
        skeleton_score += 5
    best_candidate_score = max(
        (_score_prompt_fallback_pose_candidate(item)[0] for item in candidates),
        default=0,
    )
    return descriptor_score + skeleton_score, best_candidate_score, signature


def _score_prompt_fallback_pose_candidate(item: dict[str, Any]) -> tuple[int, int, int, str]:
    source = str(item.get("source") or "").strip()
    source_score = {
        "motion_tuning_sample": 90,
        "motion_catalog_semantic_extract": 80,
        "expression_parameter_extract": 70,
        "profile_binding_parameter_extract": 45,
    }.get(source, 40)
    intensity = str(item.get("intensity") or "").strip().lower()
    intensity_score = {
        "high": 30,
        "medium": 20,
        "low": 10,
    }.get(intensity, 0)
    axes = item.get("axes")
    axis_score = min(len(axes), 5) if isinstance(axes, dict) else 0
    label = str(item.get("label") or item.get("id") or "").strip()
    metadata_score = 0
    if str(item.get("description") or "").strip():
        metadata_score += 3
    if _normalize_axis_text_list(item.get("recommended_scenarios")):
        metadata_score += 2
    if _normalize_axis_text_list(item.get("emotion_bias")):
        metadata_score += 2
    return source_score + intensity_score + metadata_score, axis_score, len(label), label


def _select_motion_format_example_axes(
    prompt_axes: list[dict[str, Any]],
    *,
    limit: int,
) -> list[dict[str, Any]]:
    primary_axes = [
        axis
        for axis in prompt_axes
        if isinstance(axis, dict)
        and str(axis.get("control_role") or "").strip() == "primary"
    ]
    other_axes = [
        axis
        for axis in prompt_axes
        if isinstance(axis, dict)
        and str(axis.get("control_role") or "").strip() != "primary"
    ]
    return (primary_axes + other_axes)[: max(0, limit)]


def _resolve_axis_example_value(axis: dict[str, Any], *, index: int) -> float:
    neutral = _resolve_axis_neutral_value(axis)
    min_value, max_value = _resolve_axis_value_range(axis)
    soft_range = axis.get("soft_range")
    if (
        isinstance(soft_range, list)
        and len(soft_range) == 2
        and isinstance(soft_range[0], (int, float))
        and isinstance(soft_range[1], (int, float))
    ):
        soft_min = float(soft_range[0])
        soft_max = float(soft_range[1])
    else:
        span = max((max_value - min_value) * 0.08, 1.0)
        soft_min = neutral - span
        soft_max = neutral + span

    use_positive = index % 2 == 0
    if use_positive and soft_max < max_value:
        span = max(soft_max - neutral, 1.0)
        value = soft_max + max(span * 0.35, 1.0)
    elif soft_min > min_value:
        span = max(neutral - soft_min, 1.0)
        value = soft_min - max(span * 0.35, 1.0)
    elif soft_max < max_value:
        span = max(soft_max - neutral, 1.0)
        value = soft_max + max(span * 0.35, 1.0)
    else:
        value = neutral

    return round(max(min_value, min(max_value, value)), 4)


def _resolve_axis_neutral_value(axis: dict[str, Any]) -> float:
    return _payload_resolve_axis_neutral_value(axis)


def _build_motion_runtime_payload(
    event: Any,
    turn_coordinator: Any,
    runtime_state: Any,
    *,
    view: Any,
) -> dict[str, Any]:
    del event, view
    payload: dict[str, Any] = {}
    previous_motion_payload = _build_previous_motion_variation_payload(
        turn_coordinator,
        runtime_state=runtime_state,
    )
    if previous_motion_payload:
        payload.update(previous_motion_payload)
    return payload


def _build_previous_motion_variation_payload(
    turn_coordinator: Any,
    *,
    runtime_state: Any,
) -> dict[str, Any]:
    snapshot = _resolve_previous_motion_prompt_snapshot(turn_coordinator)
    if not isinstance(snapshot, dict):
        return {}

    axis_levels = snapshot.get("axis_levels")
    motion_steps = snapshot.get("motion_steps")
    if isinstance(motion_steps, list) and motion_steps:
        last_step = motion_steps[-1]
        if isinstance(last_step, dict):
            axis_levels = last_step.get("axis_levels")
    axes = snapshot.get("axes")
    if not isinstance(axis_levels, dict) and not isinstance(axes, dict):
        return {}

    semantic_profile = resolve_selected_semantic_axis_profile(runtime_state=runtime_state)
    axis_by_id = _build_prompt_axis_lookup(semantic_profile)

    key_axes: list[dict[str, Any]] = []
    key_axis_levels: dict[str, int] = {}
    for axis_id in PROMPT_VARIATION_AXIS_IDS:
        axis_level = axis_levels.get(axis_id) if isinstance(axis_levels, dict) else None
        if isinstance(axis_level, int) and not isinstance(axis_level, bool) and -4 <= axis_level <= 4:
            key_axes.append({"axis_id": axis_id, "level": axis_level})
            key_axis_levels[axis_id] = axis_level
            continue
        if not isinstance(axes, dict):
            continue
        axis_value = axes.get(axis_id)
        if not isinstance(axis_value, (int, float)) or isinstance(axis_value, bool):
            continue
        axis = axis_by_id.get(axis_id)
        descriptor = _describe_axis_descriptor(axis_id, float(axis_value), axis=axis)
        if not descriptor:
            descriptor = "neutral_center"
        neutral = _resolve_axis_neutral_value(axis) if isinstance(axis, dict) else 50.0
        key_axes.append(
            {
                "axis_id": axis_id,
                "value": round(float(axis_value), 2),
                "descriptor": descriptor,
                "neutral": round(neutral, 2),
            }
        )

    if not key_axes:
        return {}

    expression_resource_id = str(snapshot.get("expression_resource_id") or "").strip()
    motion_resource_id = str(snapshot.get("motion_resource_id") or "").strip()
    previous_motion = {
        "key_axis_levels": key_axis_levels,
        "key_axes": key_axes if not key_axis_levels else [],
        "expression_resource_id": expression_resource_id,
        "motion_resource_id": motion_resource_id,
        "was_sequence": bool(motion_steps),
        "guidance": "参考上一动作，但按本轮语义重新选择方向、幅度和身体重心，避免机械复刻。",
    }
    return {
        "previous_motion": {
            key: value
            for key, value in previous_motion.items()
            if value not in (None, "", [], {}) or key in {"was_sequence", "guidance"}
        }
    }


def _resolve_previous_motion_prompt_snapshot(turn_coordinator: Any) -> dict[str, Any] | None:
    getter = getattr(turn_coordinator, "get_last_prompt_motion_snapshot", None)
    snapshot = None
    if callable(getter):
        snapshot = getter()
    if snapshot is None:
        snapshot = getattr(turn_coordinator, "_last_prompt_motion_snapshot", None)
    if not isinstance(snapshot, dict):
        return None
    return snapshot


def _summarize_semantic_profile(
    runtime_state: Any,
    *,
    use_axis_levels: bool,
) -> tuple[dict[str, Any] | None, str | None]:
    try:
        semantic_profile = resolve_selected_semantic_axis_profile(runtime_state=runtime_state)
        prompt_axes = profile_prompt_axes(semantic_profile)
    except Exception as exc:  # noqa: BLE001
        return None, str(exc)
    return (
        {
            "profile_id": str(semantic_profile.get("profile_id") or "").strip(),
            "profile_revision": int(semantic_profile.get("revision") or 0),
            "model_id": str(semantic_profile.get("model_id") or "").strip(),
            "axis_count": len(prompt_axes),
            "raw_profile": semantic_profile,
            "prompt_axes": [
                {
                    "id": str(axis.get("id") or "").strip(),
                    "label": str(axis.get("label") or axis.get("id") or "").strip(),
                    "description": _truncate_text(
                        str(axis.get("description") or "").strip(), 160
                    ),
                    "control_role": str(axis.get("control_role") or "").strip(),
                    "value_range": _normalize_axis_range(axis.get("value_range"), [0.0, 100.0]),
                    "negative_semantics": _normalize_axis_text_list(axis.get("negative_semantics")),
                    "positive_semantics": _normalize_axis_text_list(axis.get("positive_semantics")),
                    "usage_notes": _truncate_text(str(axis.get("usage_notes") or "").strip(), 160),
                    "available_levels": resolve_available_axis_levels(axis),
                }
                for axis in prompt_axes
                if str(axis.get("id") or "").strip()
            ],
            "axis_prompt": _build_middleware_axis_prompt(
                prompt_axes,
                use_axis_levels=use_axis_levels,
            ),
        },
        None,
    )


def _build_middleware_axis_prompt(
    prompt_axes: list[dict[str, Any]],
    *,
    use_axis_levels: bool,
) -> str:
    return "\n".join(
        format_profile_axis_prompt_line(
            axis,
            truncate_text=_truncate_text,
            use_axis_levels=use_axis_levels,
        )
        for axis in prompt_axes
    )


def _truncate_text(value: str, max_length: int) -> str:
    normalized = str(value or "").strip()
    if max_length <= 0 or len(normalized) <= max_length:
        return normalized
    return normalized[: max(0, max_length - 1)].rstrip() + "…"


def _normalize_axis_text_list(value: Any) -> list[str]:
    if isinstance(value, str):
        items = re.split(r"[-,，、/|]+", value)
    elif isinstance(value, list):
        items = value
    else:
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in items:
        normalized = _truncate_text(str(item).strip(), 48)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result




def _summarize_key_axis_levels(
    value: Any,
    *,
    axis_by_id: Mapping[str, dict[str, Any]],
    limit: int,
) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, int] = {}
    for axis_id, axis_value in value.items():
        if len(result) >= limit:
            break
        if not isinstance(axis_value, (int, float)) or isinstance(axis_value, bool):
            continue
        normalized_axis_id = str(axis_id or "").strip()
        if not normalized_axis_id:
            continue
        axis = axis_by_id.get(normalized_axis_id)
        anchors = axis.get("level_anchors") if isinstance(axis, dict) else None
        if not isinstance(anchors, dict):
            continue
        numeric_anchors: list[tuple[int, float]] = []
        for raw_level, raw_anchor in anchors.items():
            try:
                level = int(raw_level)
                anchor = float(raw_anchor)
            except (TypeError, ValueError):
                continue
            if -4 <= level <= 4:
                numeric_anchors.append((level, anchor))
        if len(numeric_anchors) != 9:
            continue
        level, _anchor = min(
            numeric_anchors,
            key=lambda item: (abs(item[1] - float(axis_value)), abs(item[0])),
        )
        result[normalized_axis_id] = level
    return result


def _normalize_axis_range(value: Any, fallback: list[float] | None) -> list[float] | None:
    if (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], (int, float))
        and isinstance(value[1], (int, float))
    ):
        return [float(value[0]), float(value[1])]
    return fallback


async def _schedule_motion_from_interaction_result(
    event: Any,
    view: Any,
) -> _MotionScheduleAttempt | None:
    bundle = _resolve_motion_runtime_bundle(event)
    if bundle is None:
        return None

    motion_generation_mode = _resolve_motion_generation_mode(bundle.runtime_state)
    phase = _resolve_result_phase(view)
    assistant_text = _extract_assistant_text(view)
    identity = _resolve_frontend_identity_snapshot(event, bundle.turn_coordinator)
    reply_plan = _resolve_interaction_reply_plan_snapshot(event, view)

    motion_payload, motion_reason = _resolve_persona_effect_motion_payload_with_reason(
        event, bundle.runtime_state, view=view
    )
    _log_persona_effect_motion_resolution(
        event,
        phase=phase,
        payload=motion_payload,
        reason=motion_reason,
        view=view,
    )
    _record_motion_lab_interaction_event(
        bundle,
        event,
        view=view,
        phase=phase,
        identity=identity,
        assistant_text=assistant_text,
        motion_payload=motion_payload,
        motion_reason=motion_reason,
    )

    policy = _resolve_motion_schedule_policy(
        event,
        phase=phase,
        motion_generation_mode=motion_generation_mode,
        reply_plan=reply_plan,
    )

    if motion_payload is not None and policy.should_schedule:
        _call_event_method(event, "set_extra", "ag99live_split_motion_scheduled", True)
        return _MotionScheduleAttempt(
            phase=phase,
            source="persona_effect",
            scheduled_frontend_turn_id=identity.scheduled_frontend_turn_id,
            event_frontend_turn_id=identity.event_frontend_turn_id,
            active_frontend_turn_id=identity.active_frontend_turn_id,
            reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
            reply_plan_should_emit_immediate_reply=(
                reply_plan.should_emit_immediate_reply if reply_plan is not None else None
            ),
            reply_plan_source=reply_plan.source if reply_plan is not None else None,
            motion_generation_mode=motion_generation_mode,
            scheduled=True,
            reason="persona_effect_motion_client_object",
            assistant_text=assistant_text,
            motion_payload=motion_payload,
            motion_resolution_reason=motion_reason,
        )

    if not assistant_text:
        return _MotionScheduleAttempt(
            phase=phase,
            source=None,
            scheduled_frontend_turn_id=identity.scheduled_frontend_turn_id,
            event_frontend_turn_id=identity.event_frontend_turn_id,
            active_frontend_turn_id=identity.active_frontend_turn_id,
            reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
            reply_plan_should_emit_immediate_reply=(
                reply_plan.should_emit_immediate_reply if reply_plan is not None else None
            ),
            reply_plan_source=reply_plan.source if reply_plan is not None else None,
            motion_generation_mode=motion_generation_mode,
            scheduled=False,
            reason="assistant_text_empty",
            assistant_text=assistant_text,
            motion_resolution_reason=motion_reason,
        )

    if not policy.should_schedule or policy.source is None:
        return _MotionScheduleAttempt(
            phase=phase,
            source=None,
            scheduled_frontend_turn_id=identity.scheduled_frontend_turn_id,
            event_frontend_turn_id=identity.event_frontend_turn_id,
            active_frontend_turn_id=identity.active_frontend_turn_id,
            reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
            reply_plan_should_emit_immediate_reply=(
                reply_plan.should_emit_immediate_reply if reply_plan is not None else None
            ),
            reply_plan_source=reply_plan.source if reply_plan is not None else None,
            motion_generation_mode=motion_generation_mode,
            scheduled=False,
            reason=policy.reason,
            assistant_text=assistant_text,
            motion_resolution_reason=motion_reason,
        )

    if policy.should_schedule and motion_payload is None:
        missing_reason = _append_resolution_reason(
            motion_reason,
            "self_reply_motion_missing"
            if phase == "immediate"
            and reply_plan is not None
            and reply_plan.route_mode == "self_reply"
            else "motion_payload_missing",
        )
        return _MotionScheduleAttempt(
            phase=phase,
            source=policy.source,
            scheduled_frontend_turn_id=identity.scheduled_frontend_turn_id,
            event_frontend_turn_id=identity.event_frontend_turn_id,
            active_frontend_turn_id=identity.active_frontend_turn_id,
            reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
            reply_plan_should_emit_immediate_reply=(
                reply_plan.should_emit_immediate_reply if reply_plan is not None else None
            ),
            reply_plan_source=reply_plan.source if reply_plan is not None else None,
            motion_generation_mode=motion_generation_mode,
            scheduled=False,
            reason="motion_payload_missing",
            assistant_text=assistant_text,
            motion_resolution_reason=missing_reason,
        )

    return _MotionScheduleAttempt(
        phase=phase,
        source=policy.source,
        scheduled_frontend_turn_id=identity.scheduled_frontend_turn_id,
        event_frontend_turn_id=identity.event_frontend_turn_id,
        active_frontend_turn_id=identity.active_frontend_turn_id,
        reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
        reply_plan_should_emit_immediate_reply=(
            reply_plan.should_emit_immediate_reply if reply_plan is not None else None
        ),
        reply_plan_source=reply_plan.source if reply_plan is not None else None,
        motion_generation_mode=motion_generation_mode,
        scheduled=False,
        reason=policy.reason,
        assistant_text=assistant_text,
        motion_resolution_reason=motion_reason,
    )


def _log_persona_effect_motion_resolution(
    event: Any,
    *,
    phase: str,
    payload: dict[str, Any] | None,
    reason: str,
    view: Any = None,
) -> None:
    effect_names = []
    for raw_call in _extract_effect_calls_for_motion(event, view):
        call = _thaw_snapshot_value(raw_call)
        name = str(_effect_call_get(call, "name") or "").strip()
        if name:
            effect_names.append(name)

    effect_summary = _summarize_ag99live_motion_effect_arguments(event, view)
    payload_axes_keys: list[str] = []
    payload_expression_resource_id = ""
    payload_motion_resource_id = ""
    if isinstance(payload, dict):
        axes = payload.get("axis_levels")
        motion_steps = payload.get("motion_steps")
        if isinstance(axes, dict):
            payload_axes_keys = sorted(
                str(key).strip()
                for key in axes.keys()
                if str(key).strip()
            )
        elif isinstance(motion_steps, list):
            payload_axes_keys = _collect_motion_step_axis_keys(motion_steps)
        payload_expression_resource_id = str(
            payload.get("expression_resource_id") or ""
        ).strip()
        payload_motion_resource_id = str(
            payload.get("motion_resource_id") or ""
        ).strip()

    logger.info(
        "WIRING persona_effect_motion phase=%s payload_present=%s reason=%s "
        "effect_names=%s effect_fields=%s effect_axis_keys=%s effect_intent_tags=%s "
        "effect_expression_resource_id=%s effect_motion_resource_id=%s "
        "payload_axis_keys=%s payload_expression_resource_id=%s "
        "payload_motion_resource_id=%s",
        phase or "",
        payload is not None,
        reason,
        ",".join(sorted(effect_names)),
        ",".join(effect_summary["fields"]),
        ",".join(effect_summary["axis_keys"]),
        ",".join(effect_summary["intent_tags"]),
        effect_summary["expression_resource_id"],
        effect_summary["motion_resource_id"],
        ",".join(payload_axes_keys),
        payload_expression_resource_id,
        payload_motion_resource_id,
    )


def _record_motion_lab_interaction_event(
    bundle: _MotionRuntimeBundle,
    event: Any,
    *,
    view: Any,
    phase: str,
    identity: _FrontendIdentitySnapshot,
    assistant_text: str,
    motion_payload: dict[str, Any] | None,
    motion_reason: str,
) -> None:
    profile = None
    try:
        profile = resolve_selected_semantic_axis_profile(runtime_state=bundle.runtime_state)
    except Exception:  # noqa: BLE001
        profile = None
    effect_calls = [_thaw_snapshot_value(item) for item in _extract_effect_calls_for_motion(event, view)]
    turn_id = identity.scheduled_frontend_turn_id
    base_event = {
        "conversation_uid": getattr(getattr(bundle.turn_coordinator, "session_state", None), "client_uid", None),
        "turn_id": turn_id,
        "frontend_turn_id": identity.event_frontend_turn_id,
        "source_route": "persona_effect",
        "phase": phase,
        "model_name": str((profile or {}).get("model_id") or "").strip(),
        "profile_id": str((profile or {}).get("profile_id") or "").strip(),
        "profile_revision": (profile or {}).get("revision"),
        "assistant_text": assistant_text,
    }
    enqueue_motion_lab_raw_event(
        bundle.runtime_state,
        {
            **base_event,
            "event_type": "motion.persona_effect_received",
            "payload_kind": "effect_calls",
            "raw": {
                "effect_calls": effect_calls,
                "effect_summary": _summarize_ag99live_motion_effect_arguments(event, view),
                "view_metadata": _thaw_snapshot_value(getattr(view, "metadata", None)),
                "reply_plan": _thaw_snapshot_value(get_interaction_reply_plan(event)),
                "original_user_text": _call_event_method(event, "get_extra", "ag99live_original_message_str", ""),
            },
        },
    )
    enqueue_motion_lab_raw_event(
        bundle.runtime_state,
        {
            **base_event,
            "event_type": "motion.intent_resolved",
            "payload_kind": (
                str(motion_payload.get("schema_version") or "").strip()
                if isinstance(motion_payload, dict)
                else ""
            ),
            "raw": {
                "motion_payload": motion_payload,
                "motion_reason": motion_reason,
                "effect_calls": effect_calls,
                "assistant_text": assistant_text,
            },
        },
    )


def _summarize_ag99live_motion_effect_arguments(event: Any, view: Any) -> dict[str, Any]:
    summary = {
        "fields": [],
        "axis_keys": [],
        "intent_tags": [],
        "expression_resource_id": "",
        "motion_resource_id": "",
    }
    raw_arguments, _reason = _extract_ag99live_motion_effect_arguments(event, view)
    if not isinstance(raw_arguments, dict):
        return summary

    summary["fields"] = sorted(
        str(key).strip()
        for key in raw_arguments.keys()
        if str(key).strip()
    )
    raw_axes = raw_arguments.get("axis_levels")
    if not isinstance(raw_axes, Mapping):
        motion_steps = _thaw_snapshot_value(raw_arguments.get("motion_steps"))
        if isinstance(motion_steps, list):
            summary["axis_keys"] = _collect_motion_step_axis_keys(motion_steps)
    if isinstance(raw_axes, Mapping):
        summary["axis_keys"] = sorted(
            str(key).strip()
            for key in raw_axes.keys()
            if str(key).strip()
        )
    raw_intent_tags = _thaw_snapshot_value(raw_arguments.get("intent_tags"))
    if isinstance(raw_intent_tags, (list, tuple, set)):
        summary["intent_tags"] = [
            str(item).strip()
            for item in raw_intent_tags
            if str(item).strip()
        ]
    elif str(raw_intent_tags or "").strip():
        summary["intent_tags"] = [str(raw_intent_tags).strip()]
    summary["expression_resource_id"] = str(
        raw_arguments.get("expression_resource_id") or ""
    ).strip()
    summary["motion_resource_id"] = str(
        raw_arguments.get("motion_resource_id") or ""
    ).strip()
    return summary


def _collect_motion_step_axis_keys(motion_steps: list[Any]) -> list[str]:
    axis_ids: set[str] = set()
    for step in motion_steps:
        step_axes = step.get("axis_levels") if isinstance(step, dict) else None
        if not isinstance(step_axes, Mapping):
            continue
        axis_ids.update(
            str(axis_id).strip()
            for axis_id in step_axes
            if str(axis_id).strip()
        )
    return sorted(axis_ids)


def _thaw_snapshot_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): _thaw_snapshot_value(item)
            for key, item in value.items()
        }
    if isinstance(value, tuple):
        return [_thaw_snapshot_value(item) for item in value]
    if isinstance(value, list):
        return [_thaw_snapshot_value(item) for item in value]
    return value


def _append_resolution_reason(base: str | None, suffix: str) -> str:
    normalized_base = str(base or "").strip()
    normalized_suffix = str(suffix or "").strip()
    if not normalized_base or normalized_base == "ok":
        return normalized_suffix or "ok"
    if not normalized_suffix or normalized_suffix == "ok":
        return normalized_base
    return f"{normalized_base}:{normalized_suffix}"


def _extract_assistant_text(view: Any) -> str:
    for value in (
        getattr(view, "final_result", None),
        getattr(view, "core_result", None),
        getattr(view, "immediate_reply", None),
    ):
        text = sanitize_assistant_output_text(str(value or "")).strip()
        if text:
            return text
    return ""


def _extract_user_text(event: Any) -> str:
    for value in (
        _call_event_method(event, "get_extra", "ag99live_original_message_str"),
        getattr(event, "message_str", None),
        getattr(getattr(event, "message_obj", None), "message_str", None),
    ):
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _sanitize_reason_fragment(value: Any) -> str:
    fragment = re.sub(r"[^0-9A-Za-z_.:-]+", "_", str(value or "").strip())
    return fragment[:80] or "unknown"


def _resolve_motion_generation_mode(runtime_state: Any) -> str:
    del runtime_state
    return "single_response_effect"


def _resolve_result_phase(view: Any) -> str:
    metadata = getattr(view, "metadata", None)
    if isinstance(metadata, Mapping):
        return str(metadata.get("phase") or "").strip()
    getter = getattr(metadata, "get", None)
    if callable(getter):
        return str(getter("phase") or "").strip()
    return ""


def _resolve_motion_schedule_policy(
    event: Any,
    *,
    phase: str,
    motion_generation_mode: str,
    reply_plan: _InteractionReplyPlanSnapshot | None,
) -> _MotionSchedulePolicy:
    if phase == "immediate":
        return _resolve_immediate_phase_policy()
    if phase == "final":
        return _resolve_final_phase_policy(
            event,
            motion_generation_mode=motion_generation_mode,
            reply_plan=reply_plan,
        )
    return _MotionSchedulePolicy(
        should_schedule=False,
        source=None,
        reason="unsupported_phase",
    )


def _resolve_immediate_phase_policy(
) -> _MotionSchedulePolicy:
    return _MotionSchedulePolicy(
        should_schedule=True,
        source="interaction_result_immediate",
        reason="schedule_immediate_persona_reply",
    )


def _resolve_final_phase_policy(
    event: Any,
    *,
    motion_generation_mode: str,
    reply_plan: _InteractionReplyPlanSnapshot | None,
) -> _MotionSchedulePolicy:
    if reply_plan is not None and reply_plan.route_mode == "self_reply":
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="self_reply_does_not_use_final_phase",
        )
    already_scheduled = bool(
        _call_event_method(event, "get_extra", "ag99live_split_motion_scheduled", False)
    )
    route_mode = reply_plan.route_mode if reply_plan is not None else None
    if already_scheduled and route_mode not in {"hybrid", "delegate_to_core"}:
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="already_scheduled_by_motion_pipeline",
        )
    return _MotionSchedulePolicy(
        should_schedule=True,
        source="interaction_result_final",
        reason="schedule_core_reply_final",
    )


def _resolve_interaction_reply_plan_snapshot(
    event: Any,
    view: Any,
) -> _InteractionReplyPlanSnapshot | None:
    snapshot = _coerce_interaction_reply_plan_snapshot(
        get_interaction_reply_plan(event),
        source="event_turn_state",
    )
    if snapshot is not None:
        return snapshot

    snapshot = _coerce_interaction_reply_plan_snapshot(
        _call_event_method(
            event,
            "get_extra",
            INTERACTION_ROUTE_DECISION_EXTRA_KEY,
            None,
        ),
        source="event_extra",
    )
    if snapshot is not None:
        return snapshot

    return _coerce_interaction_reply_plan_snapshot(
        getattr(view, "route_decision", None),
        source="view",
    )


def _coerce_interaction_reply_plan_snapshot(
    value: Any,
    *,
    source: str,
) -> _InteractionReplyPlanSnapshot | None:
    if value is None:
        return None

    if isinstance(value, Mapping):
        route_mode_raw = value.get("route_mode")
        should_emit_raw = (
            value.get("should_emit_immediate_reply")
            if "should_emit_immediate_reply" in value
            else None
        )
    else:
        route_mode_raw = getattr(value, "route_mode", None)
        should_emit_raw = getattr(value, "should_emit_immediate_reply", None)

    route_mode = _normalize_optional_string(getattr(route_mode_raw, "value", route_mode_raw))
    should_emit_immediate_reply = (
        bool(should_emit_raw) if should_emit_raw is not None else None
    )
    if route_mode is None and should_emit_immediate_reply is None:
        return None
    return _InteractionReplyPlanSnapshot(
        route_mode=route_mode,
        should_emit_immediate_reply=should_emit_immediate_reply,
        source=source,
    )


def _resolve_frontend_identity_snapshot(
    event: Any,
    turn_coordinator: Any,
) -> _FrontendIdentitySnapshot:
    raw_message = getattr(getattr(event, "message_obj", None), "raw_message", None)
    event_frontend_turn_id = None
    if isinstance(raw_message, dict):
        event_frontend_turn_id = _normalize_optional_string(raw_message.get("turn_id"))
    session_state = getattr(turn_coordinator, "session_state", None)
    return _FrontendIdentitySnapshot(
        event_frontend_turn_id=event_frontend_turn_id,
        active_frontend_turn_id=_normalize_optional_string(
            getattr(session_state, "current_turn_id", None)
        ),
    )


def _normalize_optional_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _resolve_prompt_purpose(view: Any) -> str:
    """Read the prompt purpose from the AstrBot view.

    Returns one of ``"router"``, ``"persona_reply"``, ``"core_reply"``,
    or ``"unknown"``.
    """
    purpose = _normalize_optional_string(getattr(view, "purpose", None))
    if purpose:
        return purpose
    metadata = getattr(view, "metadata", None)
    if isinstance(metadata, Mapping):
        purpose = _normalize_optional_string(metadata.get("purpose"))
    elif callable(getattr(metadata, "get", None)):
        purpose = _normalize_optional_string(metadata.get("purpose"))
    if purpose:
        return purpose
    return "unknown"


def _should_contribute_motion_prompt(view: Any) -> bool:
    """Only inject motion capability into persona_reply / core_reply prompts.

    This keeps router and other prompt lanes clean of ag99live motion metadata.
    """
    purpose = _resolve_prompt_purpose(view)
    return purpose in {"persona_reply", "core_reply"}


def _call_event_method(event: Any, method_name: str, *args: Any) -> Any:
    method = getattr(event, method_name, None)
    if callable(method):
        return method(*args)
    return None
