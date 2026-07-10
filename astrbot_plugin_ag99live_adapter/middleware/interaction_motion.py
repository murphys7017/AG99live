from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from astrbot.api import logger
from astrbot.core.interaction import (
    InteractionResultContribution,
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
    coerce_plugin_hint_axis_value as _payload_coerce_plugin_hint_axis_value,
    describe_fallback_pose_axes as _payload_describe_fallback_pose_axes,
    describe_fallback_pose_axis_value as _payload_describe_fallback_pose_axis_value,
    is_axis_soft_range_neutral as _payload_is_axis_soft_range_neutral,
    normalize_duration_hint_ms as _payload_normalize_duration_hint_ms,
    normalize_motion_arguments_payload as _payload_normalize_motion_arguments_payload,
    normalize_plugin_hint_axes as _payload_normalize_plugin_hint_axes,
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
)
from ..runtime.motion_lab import enqueue_motion_lab_raw_event

AG99LIVE_PLUGIN_ID = "astrbot_plugin_ag99live_adapter"
AG99LIVE_MOTION_EFFECT_NAME = "ag99live.motion"
PROMPT_VARIATION_AXIS_IDS = ("head_yaw", "body_yaw")


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

        return [
            PromptExtension(
                plugin_id=self.plugin_id,
                mount="system",
                title="AG99live Motion Decision Contract",
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
                title="AG99live Motion Capability",
                value_kind="mapping",
                value=static_capability_payload,
                order=40,
                meta={
                    "scope": "static",
                    "node_type": "ag99live_motion_capability",
                },
            ),
            PromptExtension(
                plugin_id=self.plugin_id,
                mount="context",
                title="AG99live Motion Runtime",
                value_kind="mapping",
                value=runtime_payload,
                order=41,
                meta={
                    "scope": "dynamic",
                    "node_type": "ag99live_motion_runtime",
                },
            ),
        ]


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
                "semantic axes for this turn. Use resource_id only when a listed "
                "explicit expression or motion resource is clearly appropriate."
            ),
            parameters={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "intent_tags": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "axes": {
                        "type": "object",
                        "additionalProperties": {"type": "number"},
                        "minProperties": 1,
                    },
                    "duration_hint_ms": {"type": "integer"},
                    "resource_id": {"type": "string"},
                },
                "required": ["intent_tags", "axes"],
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


def _normalize_plugin_hint_axes(
    axes: Any,
    semantic_profile: dict[str, Any],
) -> tuple[dict[str, float] | None, list[str]]:
    return _payload_normalize_plugin_hint_axes(axes, semantic_profile)


def _coerce_plugin_hint_axis_value(raw_value: float, axis: dict[str, Any]) -> float:
    return _payload_coerce_plugin_hint_axis_value(raw_value, axis)


def _build_motion_visibility_summary(
    *,
    axes: dict[str, float],
    semantic_profile: dict[str, Any],
    intent_tags: list[str] | None = None,
    resource_id: str = "",
    fallback_pose_id: str = "",
    fallback_reasons: list[str] | None = None,
    fallback_score: float = 0.0,
    fallback_used: bool = False,
    matched_candidate_id: str = "",
    repair_added_axes: list[str] | None = None,
    repair_replaced_axes: list[str] | None = None,
) -> dict[str, Any]:
    return _payload_build_motion_visibility_summary(
        axes=axes,
        semantic_profile=semantic_profile,
        intent_tags=intent_tags,
        resource_id=resource_id,
        fallback_pose_id=fallback_pose_id,
        fallback_reasons=fallback_reasons,
        fallback_score=fallback_score,
        fallback_used=fallback_used,
        matched_candidate_id=matched_candidate_id,
        repair_added_axes=repair_added_axes,
        repair_replaced_axes=repair_replaced_axes,
    )


def _is_axis_soft_range_neutral(value: float, axis: dict[str, Any]) -> bool:
    return _payload_is_axis_soft_range_neutral(value, axis)


def _resolve_axis_value_range(axis: dict[str, Any]) -> tuple[float, float]:
    return _payload_resolve_axis_value_range(axis)


def _normalize_duration_hint_ms(value: Any) -> int:
    return _payload_normalize_duration_hint_ms(value)


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

    profile_payload, _profile_error = _summarize_semantic_profile(runtime_state)
    if profile_payload is not None:
        raw_profile = profile_payload.pop("raw_profile", None)
        capability_payload["semantic_profile"] = profile_payload
        if isinstance(raw_profile, dict):
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

        capability_payload["effect_arguments_example"] = (
            _build_motion_effect_arguments_example(
                profile_payload,
                include_resource_id=bool(capability_payload.get("resource_candidates")),
            )
        )

    return capability_payload


def _build_motion_decision_contract_text(capability_payload: dict[str, Any]) -> str:
    effect_arguments_example = capability_payload.get("effect_arguments_example")
    format_json = "{}"
    if isinstance(effect_arguments_example, dict) and effect_arguments_example:
        import json

        format_json = json.dumps(
            effect_arguments_example,
            ensure_ascii=False,
            separators=(",", ":"),
        )

    motion_style_prompt = str(capability_payload.get("motion_style_prompt") or "").strip()
    style_text = ""
    if motion_style_prompt:
        style_text = (
            "角色风格偏好："
            f"{motion_style_prompt}"
            "这些偏好来自用户手调样本，用于约束角色表演习惯，不是固定动作模板。"
        )
    semantic_profile = capability_payload.get("semantic_profile")
    axis_prompt = ""
    if isinstance(semantic_profile, dict):
        axis_prompt = str(semantic_profile.get("axis_prompt") or "").strip()
    axis_prompt_text = f"可用 axes 参数及语义：\n{axis_prompt}\n" if axis_prompt else ""
    has_resource_candidates = bool(capability_payload.get("resource_candidates"))
    allowed_fields_text = (
        "必填字段是 intent_tags 和 axes；可选字段只有 resource_id 和 duration_hint_ms。"
        if has_resource_candidates
        else "必填字段是 intent_tags 和 axes；可选字段只有 duration_hint_ms。"
    )
    resource_field_text = (
        "resource_id 只有在确定要引用明确资源时才填写，不确定就省略。"
        if has_resource_candidates
        else ""
    )
    fallback_pose_text = ""
    fallback_candidates = capability_payload.get("fallback_pose_candidates")
    if isinstance(fallback_candidates, list) and fallback_candidates:
        lines = ["可参考的姿态语义样本（只用于理解姿态组合，不要输出这些 id）："]
        for item in fallback_candidates:
            if not isinstance(item, dict):
                continue
            pose_id = str(item.get("id") or "").strip()
            if not pose_id:
                continue
            label = str(item.get("label") or pose_id).strip()
            source = str(item.get("source") or "").strip()
            context_parts = []
            emotion_bias = _join_prompt_list(item.get("emotion_bias"), limit=3)
            intensity = str(item.get("intensity") or "").strip()
            scenarios = _join_prompt_list(item.get("recommended_scenarios"), limit=3)
            description = _truncate_text(str(item.get("description") or "").strip(), 72)
            pose_descriptors = _join_prompt_list(item.get("pose_descriptors"), limit=4)
            key_axes = _format_key_axes_for_prompt(item.get("key_axes"))
            if emotion_bias:
                context_parts.append(f"语义={emotion_bias}")
            if pose_descriptors:
                context_parts.append(f"姿态={pose_descriptors}")
            if intensity:
                context_parts.append(f"强度={intensity}")
            if scenarios:
                context_parts.append(f"适用={scenarios}")
            if description:
                context_parts.append(f"说明={description}")
            if key_axes:
                context_parts.append(f"关键轴={key_axes}")
            context_text = f"；{'；'.join(context_parts)}" if context_parts else ""
            lines.append(
                f"- {label}"
                + (f" ({source})" if source else "")
                + context_text
            )
        fallback_pose_text = "\n".join(lines) + "\n"
    resource_text = ""
    resource_candidates = capability_payload.get("resource_candidates")
    if isinstance(resource_candidates, list) and resource_candidates:
        lines = ["可选明确资源（只有需要特定表情/动画时才输出 resource_id；不确定就省略）："]
        for item in resource_candidates:
            if not isinstance(item, dict):
                continue
            resource_id = str(item.get("resource_id") or "").strip()
            if not resource_id:
                continue
            label = str(item.get("label") or resource_id).strip()
            context_parts = []
            tags = _join_prompt_list(item.get("tags"), limit=4)
            scenarios = _join_prompt_list(item.get("recommended_scenarios"), limit=3)
            description = _truncate_text(str(item.get("description") or "").strip(), 72)
            intensity = str(item.get("intensity") or "").strip()
            if tags:
                context_parts.append(f"标签={tags}")
            if scenarios:
                context_parts.append(f"适用={scenarios}")
            if intensity:
                context_parts.append(f"强度={intensity}")
            if description:
                context_parts.append(f"说明={description}")
            context_text = f"；{'；'.join(context_parts)}" if context_parts else ""
            lines.append(f"- {resource_id}: {label}{context_text}")
        resource_text = "\n".join(lines) + "\n"

    persona_effect_available = bool(capability_payload.get("persona_effect_available", True))
    if persona_effect_available:
        output_contract_text = (
            "你正在控制一个 Live2D 模型；在本轮动作 arguments 中填写动作参数。"
            f"{allowed_fields_text}"
        )
        output_shape_text = f" 输出形状示例：{format_json}"
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

    return (
        f"{output_contract_text}"
        "intent_tags 用 2 到 6 个开放关键词概括本轮语气、姿态和场景。"
        f"{resource_field_text}"
        "axes 是必填对象，只能使用下方列出的轴 id，并且每个值都直接写成 JSON number。"
        "axes 是本轮动作目标，不是角色全部参数的状态快照；没有明确方向或表演贡献的轴直接省略。"
        "优先选择能表达姿态方向、视线焦点和身体重心的关键轴，再用少量表情轴补充情绪细节。"
        "普通回复也要给轻量姿态参数；明显转身、强调、回避、惊讶、调侃、开心或疑惑时，动作幅度要更明确。"
        "示例只展示结构和数值，不要照抄示例内容。"
        f"{style_text}"
        f"{axis_prompt_text}"
        f"{resource_text}"
        f"{fallback_pose_text}"
        f"{output_shape_text}"
    )


def _build_official_inline_motion_intent_example(
    capability_payload: dict[str, Any],
) -> dict[str, Any]:
    semantic_profile = capability_payload.get("semantic_profile")
    effect_arguments_example = capability_payload.get("effect_arguments_example")
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
    if isinstance(effect_arguments_example, dict):
        for key in ("intent_tags", "duration_hint_ms", "resource_id", "axes"):
            if key in effect_arguments_example:
                intent[key] = effect_arguments_example[key]
    return intent


def _build_motion_effect_arguments_example(
    profile_payload: dict[str, Any],
    *,
    include_resource_id: bool,
) -> dict[str, Any]:
    prompt_axes = profile_payload.get("prompt_axes")
    if not isinstance(prompt_axes, list) or not prompt_axes:
        return {}

    axis_schema: dict[str, Any] = {}
    for index, axis in enumerate(_select_motion_format_example_axes(prompt_axes, limit=5)):
        if not isinstance(axis, dict):
            continue
        axis_id = str(axis.get("id") or "").strip()
        if not axis_id:
            continue
        axis_schema[axis_id] = _resolve_axis_example_value(axis, index=index)

    payload = {
        "intent_tags": ["语气关键词", "姿态关键词", "场景关键词"],
        "duration_hint_ms": DEFAULT_MOTION_INTENT_DURATION_MS,
        "axes": axis_schema,
    }
    if include_resource_id:
        payload["resource_id"] = "可选资源id"
    return payload


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
                "pose_descriptors": _describe_fallback_pose_axes(
                    item.get("axes"),
                    axis_by_id=axis_by_id,
                )[:4],
                "key_axes": _summarize_key_axes(item.get("axes"), limit=5),
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
    descriptors = _describe_fallback_pose_axes(item.get("axes"), axis_by_id=axis_by_id)
    if descriptors:
        return "+".join(descriptors[:3])
    return "metadata:" + _normalize_prompt_fallback_metadata_signature(item)


def _describe_fallback_pose_axes(
    value: Any,
    *,
    axis_by_id: Mapping[str, dict[str, Any]] | None = None,
) -> list[str]:
    return _payload_describe_fallback_pose_axes(value, axis_by_id=axis_by_id)


def _describe_fallback_pose_axis_value(
    axis_id: str,
    value: float,
    *,
    axis: dict[str, Any] | None = None,
) -> str:
    return _payload_describe_fallback_pose_axis_value(axis_id, value, axis=axis)


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


def _resolve_motion_format_fallback_pose_id(candidates: Any) -> str | None:
    if not isinstance(candidates, list):
        return None
    for item in candidates:
        if not isinstance(item, dict):
            continue
        pose_id = str(item.get("id") or "").strip()
        if pose_id:
            return pose_id
    return None


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
    payload = {
        "configured_generation_mode": _resolve_motion_generation_mode(runtime_state),
        "prompt_purpose": _resolve_prompt_purpose(view),
    }
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

    axes = snapshot.get("axes")
    if not isinstance(axes, dict):
        return {}

    semantic_profile = None
    try:
        semantic_profile = resolve_selected_semantic_axis_profile(runtime_state=runtime_state)
    except Exception:  # noqa: BLE001
        semantic_profile = None
    axis_by_id = _build_prompt_axis_lookup(semantic_profile)

    key_axes: list[dict[str, Any]] = []
    summary_parts: list[str] = []
    for axis_id in PROMPT_VARIATION_AXIS_IDS:
        axis_value = axes.get(axis_id)
        if not isinstance(axis_value, (int, float)) or isinstance(axis_value, bool):
            continue
        axis = axis_by_id.get(axis_id)
        descriptor = _describe_fallback_pose_axis_value(axis_id, float(axis_value), axis=axis)
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
        summary_parts.append(f"{axis_id}={descriptor}({float(axis_value):g})")

    if not key_axes:
        return {}

    resource_id = str(snapshot.get("resource_id") or "").strip()
    summary_text = "上一动作关键轴：" + "，".join(summary_parts) + "。"
    if resource_id:
        summary_text += f" 上一动作 resource_id={resource_id}。"
    summary_text += " 参考上一动作，按本轮语义重新选择方向、幅度和重心。"
    return {
        "previous_motion_key_axes": key_axes,
        "previous_motion_summary": summary_text,
        "previous_motion_variation_instruction": (
            "参考上一动作的 head_yaw/body_yaw，按本轮语义调整方向与幅度。"
        ),
    }


def _resolve_previous_motion_prompt_snapshot(turn_coordinator: Any) -> dict[str, Any] | None:
    getter = getattr(turn_coordinator, "get_last_prompt_motion_snapshot", None)
    snapshot = None
    if callable(getter):
        try:
            snapshot = getter()
        except Exception:  # noqa: BLE001
            snapshot = None
    if snapshot is None:
        snapshot = getattr(turn_coordinator, "_last_prompt_motion_snapshot", None)
    if not isinstance(snapshot, dict):
        return None
    return snapshot


def _summarize_semantic_profile(
    runtime_state: Any,
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
                    "control_role": str(axis.get("control_role") or "").strip(),
                    "value_range": _normalize_axis_range(axis.get("value_range"), [0.0, 100.0]),
                    "negative_semantics": _normalize_axis_text_list(axis.get("negative_semantics")),
                    "positive_semantics": _normalize_axis_text_list(axis.get("positive_semantics")),
                    "usage_notes": _truncate_text(str(axis.get("usage_notes") or "").strip(), 160),
                }
                for axis in prompt_axes
                if str(axis.get("id") or "").strip()
            ],
            "axis_prompt": _build_middleware_axis_prompt(prompt_axes),
        },
        None,
    )


def _build_middleware_axis_prompt(prompt_axes: list[dict[str, Any]]) -> str:
    return "\n".join(
        format_profile_axis_prompt_line(axis, truncate_text=_truncate_text)
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




def _summarize_key_axes(value: Any, *, limit: int) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, float] = {}
    for axis_id, axis_value in value.items():
        if len(result) >= limit:
            break
        if not isinstance(axis_value, (int, float)) or isinstance(axis_value, bool):
            continue
        normalized_axis_id = str(axis_id or "").strip()
        if not normalized_axis_id:
            continue
        result[normalized_axis_id] = round(float(axis_value), 2)
    return result


def _join_prompt_list(value: Any, *, limit: int) -> str:
    if not isinstance(value, list):
        return ""
    items = [
        _truncate_text(str(item).strip(), 24)
        for item in value
        if str(item).strip()
    ][: max(0, limit)]
    return ", ".join(items)


def _format_key_axes_for_prompt(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    parts = []
    for axis_id, axis_value in value.items():
        if not isinstance(axis_value, (int, float)) or isinstance(axis_value, bool):
            continue
        normalized_axis_id = str(axis_id or "").strip()
        if not normalized_axis_id:
            continue
        parts.append(f"{normalized_axis_id}={float(axis_value):g}")
    return ", ".join(parts)


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
    payload_resource_id = ""
    payload_fallback_pose_id = ""
    if isinstance(payload, dict):
        axes = payload.get("axes")
        if isinstance(axes, dict):
            payload_axes_keys = sorted(
                str(key).strip()
                for key in axes.keys()
                if str(key).strip()
            )
        payload_resource_id = str(payload.get("resource_id") or "").strip()
        payload_fallback_pose_id = str(payload.get("fallback_pose_id") or "").strip()

    logger.info(
        "WIRING persona_effect_motion phase=%s payload_present=%s reason=%s "
        "effect_names=%s effect_fields=%s effect_axis_keys=%s effect_intent_tags=%s "
        "effect_resource_id=%s payload_axes=%s payload_resource_id=%s payload_fallback_pose_id=%s",
        phase or "",
        payload is not None,
        reason,
        ",".join(sorted(effect_names)),
        ",".join(effect_summary["fields"]),
        ",".join(effect_summary["axis_keys"]),
        ",".join(effect_summary["intent_tags"]),
        effect_summary["resource_id"],
        ",".join(payload_axes_keys),
        payload_resource_id,
        payload_fallback_pose_id,
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
            "payload_kind": "engine.motion_intent.v3" if isinstance(motion_payload, dict) else "",
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
        "resource_id": "",
    }
    raw_arguments, _reason = _extract_ag99live_motion_effect_arguments(event, view)
    if not isinstance(raw_arguments, dict):
        return summary

    summary["fields"] = sorted(
        str(key).strip()
        for key in raw_arguments.keys()
        if str(key).strip()
    )
    raw_axes = raw_arguments.get("axes")
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
    summary["resource_id"] = str(raw_arguments.get("resource_id") or "").strip()
    return summary


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
    return "split_after_reply"


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
        return _resolve_immediate_phase_policy(reply_plan, motion_generation_mode=motion_generation_mode)
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
    reply_plan: _InteractionReplyPlanSnapshot | None,
    *,
    motion_generation_mode: str,
) -> _MotionSchedulePolicy:
    if reply_plan is None:
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="immediate_phase_reply_plan_unresolved",
        )
    if reply_plan.route_mode == "self_reply":
        return _MotionSchedulePolicy(
            should_schedule=True,
            source="interaction_result_immediate",
            reason="schedule_self_reply_immediate",
        )
    if reply_plan.route_mode in {"hybrid", "delegate_to_core"}:
        return _MotionSchedulePolicy(
            should_schedule=True,
            source="interaction_result_immediate",
            reason="schedule_hybrid_immediate",
        )
    if reply_plan.route_mode:
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="immediate_phase_route_unresolved",
        )
    return _MotionSchedulePolicy(
        should_schedule=False,
        source=None,
        reason="immediate_phase_reply_plan_unresolved",
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
        _call_event_method(event, "get_extra", "_interaction_decision", None),
        source="event_extra",
    )
    if snapshot is not None:
        return snapshot

    return _coerce_interaction_reply_plan_snapshot(
        getattr(view, "decision", None),
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
