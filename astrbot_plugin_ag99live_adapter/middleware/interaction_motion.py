from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from astrbot.api import logger
from astrbot.core.interaction import (
    InteractionResultContribution,
    get_interaction_decision as get_interaction_reply_plan,
)
from astrbot.core.prompt import PromptExtension

from ..motion.output_sanitizer import sanitize_assistant_output_text
from ..motion.motion_intent import (
    _apply_expressive_floor_v2,
    DEFAULT_MOTION_INTENT_DURATION_MS,
    MOTION_INTENT_V3_SCHEMA_VERSION,
    derive_motion_emotion_label,
    derive_motion_fallback_decision,
    describe_motion_axes_for_fallback,
    normalize_motion_intent_tags,
    normalize_motion_resource_id,
    resolve_selected_semantic_axis_profile,
)
from ..motion.resource_catalog import (
    build_motion_resource_candidates,
    validate_motion_resource_id,
)
from ..motion.fallback_pose import (
    DEFAULT_FALLBACK_POSE_ID,
    build_default_neutral_pose_axes,
    repair_motion_axes_with_fallback_pose,
    build_fallback_pose_candidates,
    resolve_fallback_pose,
    resolve_fallback_pose_axes,
)
from ..prompts.motion_selector import (
    resolve_motion_prompt_instruction,
)
from ..prompts.semantic_axis_prompt import (
    format_profile_axis_prompt_line,
    profile_prompt_axes,
)

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
    plugin_hints_motion_payload: dict[str, Any] | None = None
    plugin_hints_resolution_reason: str | None = None

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
        if self.plugin_hints_resolution_reason:
            metadata["plugin_hints_resolution_reason"] = self.plugin_hints_resolution_reason
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

        capability_payload = _build_motion_capability_payload(bundle.runtime_state)
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
                value=_build_motion_decision_contract_text(capability_payload),
                order=39,
                meta={
                    "scope": "dynamic",
                    "node_type": "ag99live_motion_decision_contract",
                },
            ),
            PromptExtension(
                plugin_id=self.plugin_id,
                mount="capability",
                title="AG99live Motion Capability",
                value_kind="mapping",
                value=capability_payload,
                order=40,
                meta={
                    "scope": "dynamic",
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
        if attempt.plugin_hints_motion_payload is not None:
            client_objects.append(
                {
                    "type": "ag99live.motion_payload",
                    "motion_payload": attempt.plugin_hints_motion_payload,
                    "mode": "preview",
                    "source": attempt.source or "plugin_hints",
                }
            )
        return InteractionResultContribution(
            plugin_id=self.plugin_id,
            client_objects=client_objects,
            metadata={"ag99live_motion_schedule": attempt.to_metadata()},
            priority=self.priority,
        )


def register_ag99live_interaction_contributors(context: Any) -> None:
    register_prompt = getattr(context, "register_interaction_prompt_contributor", None)
    if callable(register_prompt):
        register_prompt(AG99liveMotionPromptContributor())

    register_result = getattr(context, "register_interaction_result_contributor", None)
    if callable(register_result):
        register_result(AG99liveMotionResultContributor())


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


def _resolve_plugin_hints_motion_payload(
    event: Any,
    runtime_state: Any,
    *,
    view: Any = None,
) -> dict[str, Any] | None:
    payload, _reason = _resolve_plugin_hints_motion_payload_with_reason(
        event,
        runtime_state,
        view=view,
    )
    return payload


def _resolve_plugin_hints_motion_payload_with_reason(
    event: Any,
    runtime_state: Any,
    *,
    view: Any = None,
) -> tuple[dict[str, Any] | None, str]:
    hints = _extract_plugin_hints_from_view(view) if view is not None else None
    if hints is None:
        hints = _call_event_method(event, "get_extra", "_interaction_plugin_hints")
    hints, hints_reason = _coerce_plugin_hints_mapping_with_reason(hints)
    if not isinstance(hints, dict):
        return None, hints_reason

    motion_hint = hints.get("ag99live_motion")
    if not isinstance(motion_hint, dict):
        return None, _append_resolution_reason(hints_reason, "ag99live_motion_missing")

    forbidden_fields = [
        key
        for key in (
            "choice",
            "mode",
            "motion_id",
            "catalog_motion",
            "motion3",
            "exp3",
            "kind",
            "emotion",
            "emotion_label",
            "fallback_pose_id",
            "summary",
        )
        if key in motion_hint
    ]

    try:
        semantic_profile = resolve_selected_semantic_axis_profile(
            runtime_state=runtime_state
        )
    except Exception as exc:  # noqa: BLE001
        return None, f"semantic_profile_unresolved:{exc}"

    profile_id = str(semantic_profile.get("profile_id") or "").strip()
    if not profile_id:
        return None, "profile_id_empty"

    if forbidden_fields:
        return None, _append_resolution_reason(
            hints_reason,
            "forbidden_fields:" + ",".join(forbidden_fields),
        )

    intent_tags = normalize_motion_intent_tags(motion_hint.get("intent_tags"))
    if not intent_tags:
        return None, _append_resolution_reason(hints_reason, "intent_tags_empty")
    emotion_label = derive_motion_emotion_label(intent_tags)
    resource_id = normalize_motion_resource_id(motion_hint.get("resource_id"))
    axes = motion_hint.get("axes")
    validated_axes = None
    expressive_floor_emotion = emotion_label
    apply_expressive_floor = True
    repair_added_axes: list[str] = []
    repair_replaced_axes: list[str] = []
    reason = hints_reason
    validated_axes = _normalize_plugin_hint_axes(
        axes,
        semantic_profile,
        emotion_label=emotion_label,
    )
    if not validated_axes:
        reason = _append_resolution_reason(reason, "axes_empty_or_invalid")

    fallback_candidates = build_fallback_pose_candidates(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
        limit=None,
    )
    resource_candidates = build_motion_resource_candidates(
        runtime_state=runtime_state,
    )
    resource_id, resource_reason = _validate_motion_resource_id(
        resource_id,
        candidates=resource_candidates,
    )
    if resource_reason:
        reason = _append_resolution_reason(reason, resource_reason)

    fallback_decision = derive_motion_fallback_decision(
        candidates=fallback_candidates,
        intent_tags=intent_tags,
        resource_id=resource_id,
        axes=validated_axes if isinstance(validated_axes, dict) else axes,
        describe_axes=lambda value: describe_motion_axes_for_fallback(
            value,
            semantic_profile=semantic_profile,
        ),
    )
    fallback_pose_id = fallback_decision.fallback_pose_id

    if not validated_axes:
        fallback_resolution = resolve_fallback_pose(
            runtime_state=runtime_state,
            semantic_profile=semantic_profile,
            fallback_pose_id=fallback_pose_id,
        )
        if fallback_resolution is not None:
            validated_axes = fallback_resolution.axes
            if fallback_resolution.is_default_neutral:
                expressive_floor_emotion = "neutral"
                apply_expressive_floor = False
            reason = _append_resolution_reason(reason, f"fallback_pose:{fallback_pose_id}")
        else:
            validated_axes = build_default_neutral_pose_axes(semantic_profile)
            fallback_pose_id = DEFAULT_FALLBACK_POSE_ID
            expressive_floor_emotion = "neutral"
            apply_expressive_floor = False
            reason = _append_resolution_reason(
                reason,
                f"fallback_pose_default:{DEFAULT_FALLBACK_POSE_ID}",
            )
    else:
        fallback_resolution = resolve_fallback_pose(
            runtime_state=runtime_state,
            semantic_profile=semantic_profile,
            fallback_pose_id=fallback_pose_id,
        )
        if fallback_resolution is not None:
            (
                validated_axes,
                repair_added_axes,
                repair_replaced_axes,
            ) = repair_motion_axes_with_fallback_pose(
                axes=validated_axes,
                semantic_profile=semantic_profile,
                fallback_axes=fallback_resolution.axes,
            )
            if repair_added_axes:
                reason = _append_resolution_reason(
                    reason,
                    f"skeleton_repair_added:{','.join(repair_added_axes)}",
                )
            if repair_replaced_axes:
                reason = _append_resolution_reason(
                    reason,
                    f"skeleton_repair_replaced:{','.join(repair_replaced_axes)}",
                )

    if not validated_axes:
        return None, reason

    if apply_expressive_floor:
        validated_axes = _apply_expressive_floor_v2(
            axes=validated_axes,
            emotion=expressive_floor_emotion,
            semantic_profile=semantic_profile,
        )

    duration_hint_ms = _normalize_duration_hint_ms(motion_hint.get("duration_hint_ms"))
    summary = _build_motion_visibility_summary(
        axes=validated_axes,
        semantic_profile=semantic_profile,
        intent_tags=intent_tags,
        resource_id=resource_id,
        fallback_pose_id=fallback_pose_id,
        fallback_reasons=fallback_decision.reasons,
        fallback_score=fallback_decision.score,
        fallback_used=fallback_decision.used_default_neutral or not bool(axes),
        matched_candidate_id=fallback_decision.matched_candidate_id,
        repair_added_axes=repair_added_axes,
        repair_replaced_axes=repair_replaced_axes,
    )

    return {
        "schema_version": MOTION_INTENT_V3_SCHEMA_VERSION,
        "profile_id": profile_id,
        "profile_revision": int(semantic_profile.get("revision") or 0),
        "model_id": str(semantic_profile.get("model_id") or "").strip(),
        "mode": "expressive",
        "intent_tags": intent_tags,
        "emotion_label": emotion_label,
        "duration_hint_ms": duration_hint_ms,
        "resource_id": resource_id,
        "fallback_pose_id": fallback_pose_id,
        "axes": validated_axes,
        "summary": summary,
    }, reason


def _validate_motion_resource_id(
    resource_id: Any,
    *,
    candidates: list[dict[str, Any]],
) -> tuple[str, str]:
    normalized = normalize_motion_resource_id(resource_id)
    if not normalized:
        return "", ""
    if validate_motion_resource_id(normalized, candidates=candidates):
        return normalized, "resource_id_validated"
    return "", f"resource_id_rejected:{_sanitize_reason_fragment(normalized)}"


def _normalize_plugin_hint_axes(
    axes: Any,
    semantic_profile: dict[str, Any],
    *,
    emotion_label: str,
) -> dict[str, float] | None:
    if not isinstance(axes, dict) or not axes:
        return None

    prompt_axes = profile_prompt_axes(semantic_profile)
    axis_by_id = {
        str(axis.get("id") or "").strip(): axis
        for axis in prompt_axes
        if str(axis.get("id") or "").strip()
    }
    if not axis_by_id:
        return None

    normalized_axes: dict[str, float] = {}
    for axis_id_raw, axis_value in axes.items():
        axis_id = str(axis_id_raw or "").strip()
        if not axis_id:
            continue
        axis = axis_by_id.get(axis_id)
        if axis is None:
            continue
        if isinstance(axis_value, dict):
            return None
        number = _coerce_finite_number(axis_value)
        if number is None:
            continue

        value = _coerce_plugin_hint_axis_value(number, axis)
        normalized_axes[axis_id] = value

    if not normalized_axes:
        return None

    return normalized_axes


def _coerce_plugin_hint_axis_value(raw_value: float, axis: dict[str, Any]) -> float:
    min_value, max_value = _resolve_axis_value_range(axis)

    clamped = max(min_value, min(max_value, raw_value))
    return round(clamped, 4)


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
    axis_by_id = _build_prompt_axis_lookup(semantic_profile)
    active_groups: set[str] = set()
    max_delta_from_neutral = 0.0
    neutralish_axes: list[str] = []
    expressive_axes: list[str] = []
    outside_soft_range_axes: list[str] = []

    for axis_id, raw_value in axes.items():
        axis = axis_by_id.get(str(axis_id))
        if axis is None:
            continue
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            continue
        delta = abs(_resolve_axis_neutral_delta(value, axis))
        max_delta_from_neutral = max(max_delta_from_neutral, delta)
        group = str(axis.get("semantic_group") or "").strip().lower()
        if group:
            active_groups.add(group)
        if _is_axis_soft_range_neutral(value, axis):
            neutralish_axes.append(str(axis_id))
        else:
            expressive_axes.append(str(axis_id))
            outside_soft_range_axes.append(str(axis_id))

    skeleton_groups = ("head", "body", "gaze")
    covered_skeleton_groups = [group for group in skeleton_groups if group in active_groups]
    missing_skeleton_groups = [group for group in skeleton_groups if group not in active_groups]

    return {
        "axis_count": len(axes),
        "intent_tags": list(intent_tags or []),
        "intent_tag_count": len(intent_tags or []),
        "resource_id": resource_id,
        "fallback_pose_id": fallback_pose_id,
        "fallback_used": fallback_used,
        "fallback_reasons": list(fallback_reasons or []),
        "fallback_score": round(float(fallback_score or 0.0), 4),
        "matched_candidate_id": matched_candidate_id,
        "active_groups": sorted(active_groups),
        "skeleton_groups": covered_skeleton_groups,
        "skeleton_groups_present": covered_skeleton_groups,
        "missing_skeleton_groups": missing_skeleton_groups,
        "max_delta_from_neutral": round(max_delta_from_neutral, 4),
        "neutralish_axis_count": len(neutralish_axes),
        "expressive_axis_count": len(expressive_axes),
        "neutralish_axes": neutralish_axes[:12],
        "expressive_axes": expressive_axes[:12],
        "outside_soft_range_axes": outside_soft_range_axes[:12],
        "pose_descriptors": _describe_fallback_pose_axes(axes, axis_by_id=axis_by_id)[:8],
        "skeleton_repair_added_axes": list(repair_added_axes or []),
        "skeleton_repair_replaced_axes": list(repair_replaced_axes or []),
    }


def _is_axis_soft_range_neutral(value: float, axis: dict[str, Any]) -> bool:
    soft_range = axis.get("soft_range")
    if isinstance(soft_range, (list, tuple)) and len(soft_range) >= 2:
        try:
            return float(soft_range[0]) <= value <= float(soft_range[1])
        except (TypeError, ValueError):
            pass
    try:
        neutral = float(axis.get("neutral", 50))
    except (TypeError, ValueError):
        neutral = 50.0
    return abs(value - neutral) <= 2.0


def _coerce_finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    if not float("-inf") < number < float("inf"):
        return None
    return number


def _resolve_axis_value_range(axis: dict[str, Any]) -> tuple[float, float]:
    value_range = axis.get("value_range")
    if (
        isinstance(value_range, list)
        and len(value_range) == 2
        and isinstance(value_range[0], (int, float))
        and isinstance(value_range[1], (int, float))
        and float(value_range[0]) < float(value_range[1])
    ):
        return float(value_range[0]), float(value_range[1])
    return 0.0, 100.0


def _normalize_duration_hint_ms(value: Any) -> int:
    if value is None:
        return DEFAULT_MOTION_INTENT_DURATION_MS
    try:
        number = float(value)
    except (TypeError, ValueError):
        return DEFAULT_MOTION_INTENT_DURATION_MS
    if not float("-inf") < number < float("inf"):
        return DEFAULT_MOTION_INTENT_DURATION_MS
    return max(320, min(15000, int(round(number))))


def _build_motion_capability_payload(runtime_state: Any) -> dict[str, Any]:
    motion_generation_mode = _resolve_motion_generation_mode(runtime_state)
    capability_payload: dict[str, Any] = {
        "configured_generation_mode": motion_generation_mode,
        "inline_contract_supported": bool(
            getattr(runtime_state, "enable_inline_motion_contract", True)
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

        capability_payload["plugin_hints_format"] = _build_plugin_hints_motion_format(
            profile_payload,
            include_resource_id=bool(capability_payload.get("resource_candidates")),
        )

    return capability_payload


def _build_motion_decision_contract_text(capability_payload: dict[str, Any]) -> str:
    plugin_hints_format = capability_payload.get("plugin_hints_format")
    format_json = "{}"
    if isinstance(plugin_hints_format, dict) and plugin_hints_format:
        import json

        format_json = json.dumps(
            {"plugin_hints": plugin_hints_format},
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
    axis_prompt_text = f"可用动作轴语义：\n{axis_prompt}\n" if axis_prompt else ""
    has_resource_candidates = bool(capability_payload.get("resource_candidates"))
    allowed_fields_text = (
        "允许字段只有 intent_tags、resource_id、duration_hint_ms 和 axes。"
        if has_resource_candidates
        else "允许字段只有 intent_tags、duration_hint_ms 和 axes。"
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

    return (
        "AG99live Motion 负责把本轮回复语义转成可执行动作。"
        "请只在 JSON 的 plugin_hints.ag99live_motion 中输出结果，不要把动作写进普通文本、immediate_spoken_reply 或 core_task_spec。"
        f"{allowed_fields_text}"
        "intent_tags 用 2 到 6 个开放关键词概括本轮语气、姿态和场景，不要输出 emotion_label。"
        f"{resource_field_text}"
        "axes 只能使用当前 schema 里的轴 id，并且每个值都直接写成 number。"
        "axes 是本轮动作目标，不是角色全部参数的状态快照；没有明确方向或表演贡献的轴直接省略。"
        "优先让头部、身体和视线形成可见骨架，再用少量表情轴补充细节。"
        "普通回复也要给轻量姿态；明显转身、强调、回避、惊讶、调侃、开心或疑惑时，动作幅度要更明确。"
        "不要输出 choice、mode、motion_id、catalog、motion3、exp3、关键帧、时间曲线或播放文件引用。"
        "示例只展示结构和数值，不要照抄示例内容。"
        f"{style_text}"
        f"{axis_prompt_text}"
        f"{resource_text}"
        f"{fallback_pose_text}"
        f" 输出形状示例：{format_json}"
    )


def _build_plugin_hints_motion_format(
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
    return {"ag99live_motion": payload}


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
    source = str(item.get("source") or "").strip()
    if pose_id == DEFAULT_FALLBACK_POSE_ID and source == "semantic_axis_profile":
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
    if not isinstance(value, dict):
        return []
    descriptors: list[str] = []
    for axis_id, axis_value in sorted(value.items()):
        if not isinstance(axis_value, (int, float)) or isinstance(axis_value, bool):
            continue
        axis_name = str(axis_id or "").strip()
        if not axis_name:
            continue
        descriptor = _describe_fallback_pose_axis_value(
            axis_name,
            float(axis_value),
            axis=axis_by_id.get(axis_name) if axis_by_id else None,
        )
        if descriptor and descriptor not in descriptors:
            descriptors.append(descriptor)
    return descriptors


def _describe_fallback_pose_axis_value(
    axis_id: str,
    value: float,
    *,
    axis: dict[str, Any] | None = None,
) -> str:
    normalized_axis = axis_id.strip().lower()
    if not float("-inf") < value < float("inf"):
        return ""
    delta = _resolve_axis_neutral_delta(value, axis)
    threshold = _resolve_axis_descriptor_threshold(axis)
    if abs(delta) < threshold:
        return ""

    axis_descriptors = {
        "head_yaw": ("look_left", "look_right"),
        "body_yaw": ("body_turn_left", "body_turn_right"),
        "gaze_yaw": ("gaze_left", "gaze_right"),
        "eye_gaze_x": ("gaze_left", "gaze_right"),
        "head_pitch": ("look_down", "look_up"),
        "body_pitch": ("lean_forward", "lean_back"),
        "gaze_pitch": ("gaze_down", "gaze_up"),
        "eye_gaze_y": ("gaze_down", "gaze_up"),
        "head_roll": ("tilt_left", "tilt_right"),
        "body_roll": ("body_lean_left", "body_lean_right"),
        "eye_open_left": ("left_eye_narrow", "left_eye_open"),
        "eye_open_right": ("right_eye_narrow", "right_eye_open"),
        "eye_smile_left": ("left_eye_relaxed", "left_eye_smile"),
        "eye_smile_right": ("right_eye_relaxed", "right_eye_smile"),
        "mouth_smile": ("mouth_frown", "mouth_smile"),
        "brow_bias": ("brow_down", "brow_raise"),
        "mouth_open": ("mouth_closed", "mouth_open"),
    }
    negative, positive = axis_descriptors.get(
        normalized_axis,
        (f"{normalized_axis}_low", f"{normalized_axis}_high"),
    )
    return positive if delta > 0 else negative


def _build_prompt_axis_lookup(
    semantic_profile: dict[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    if not isinstance(semantic_profile, dict):
        return {}
    return _build_prompt_axis_lookup_from_axes(profile_prompt_axes(semantic_profile))


def _build_prompt_axis_lookup_from_axes(
    prompt_axes: list[dict[str, Any]] | None,
) -> dict[str, dict[str, Any]]:
    if not isinstance(prompt_axes, list):
        return {}
    return {
        str(axis.get("id") or "").strip(): axis
        for axis in prompt_axes
        if isinstance(axis, dict) and str(axis.get("id") or "").strip()
    }


def _resolve_axis_soft_range(axis: dict[str, Any] | None) -> tuple[float, float] | None:
    if not isinstance(axis, dict):
        return None
    soft_range = axis.get("soft_range")
    if (
        isinstance(soft_range, (list, tuple))
        and len(soft_range) >= 2
        and isinstance(soft_range[0], (int, float))
        and isinstance(soft_range[1], (int, float))
    ):
        return float(soft_range[0]), float(soft_range[1])
    return None


def _resolve_axis_neutral_delta(value: float, axis: dict[str, Any] | None) -> float:
    neutral = _resolve_axis_neutral_value(axis or {})
    return float(value) - neutral


def _resolve_axis_descriptor_threshold(axis: dict[str, Any] | None) -> float:
    soft_range = _resolve_axis_soft_range(axis)
    if soft_range is not None:
        soft_min, soft_max = soft_range
        neutral = _resolve_axis_neutral_value(axis or {})
        soft_delta = max(abs(soft_max - neutral), abs(neutral - soft_min))
        if soft_delta > 0:
            return max(soft_delta * 0.6, 2.0)
    return 6.0


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
    neutral = axis.get("neutral")
    if isinstance(neutral, (int, float)):
        min_value, max_value = _resolve_axis_value_range(axis)
        return round(max(min_value, min(max_value, float(neutral))), 4)
    min_value, max_value = _resolve_axis_value_range(axis)
    return round((min_value + max_value) / 2.0, 4)


def _build_motion_runtime_payload(
    event: Any,
    turn_coordinator: Any,
    runtime_state: Any,
    *,
    view: Any,
) -> dict[str, Any]:
    return {
        "configured_generation_mode": _resolve_motion_generation_mode(runtime_state),
        "prompt_purpose": _resolve_prompt_purpose(view),
    }


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
                    "neutral": axis.get("neutral", 50),
                    "value_range": _normalize_axis_range(axis.get("value_range"), [0.0, 100.0]),
                    "soft_range": _normalize_axis_range(axis.get("soft_range"), None),
                    "strong_range": _normalize_axis_range(axis.get("strong_range"), None),
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

    plugin_hints_payload, plugin_hints_reason = _resolve_plugin_hints_motion_payload_with_reason(
        event, bundle.runtime_state, view=view
    )
    _log_plugin_hints_motion_resolution(
        event,
        phase=phase,
        payload=plugin_hints_payload,
        reason=plugin_hints_reason,
        view=view,
    )

    policy = _resolve_motion_schedule_policy(
        event,
        phase=phase,
        motion_generation_mode=motion_generation_mode,
        reply_plan=reply_plan,
    )

    if plugin_hints_payload is not None and policy.should_schedule:
        _call_event_method(event, "set_extra", "ag99live_split_motion_scheduled", True)
        return _MotionScheduleAttempt(
            phase=phase,
            source="plugin_hints",
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
            reason="plugin_hints_motion_client_object",
            assistant_text=assistant_text,
            plugin_hints_motion_payload=plugin_hints_payload,
            plugin_hints_resolution_reason=plugin_hints_reason,
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
            plugin_hints_resolution_reason=plugin_hints_reason,
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
            plugin_hints_resolution_reason=plugin_hints_reason,
        )

    if policy.should_schedule and plugin_hints_payload is None:
        plugin_hints_payload, plugin_hints_reason = _build_default_motion_payload(
            bundle.runtime_state,
            reason=_append_resolution_reason(
                plugin_hints_reason,
                "self_reply_motion_missing"
                if phase == "immediate"
                and reply_plan is not None
                and reply_plan.route_mode == "self_reply"
                else "",
            ),
        )
        if plugin_hints_payload is not None:
            _call_event_method(event, "set_extra", "ag99live_split_motion_scheduled", True)
            return _MotionScheduleAttempt(
                phase=phase,
                source="default_pose",
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
                reason="default_motion_client_object",
                assistant_text=assistant_text,
                plugin_hints_motion_payload=plugin_hints_payload,
                plugin_hints_resolution_reason=plugin_hints_reason,
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
        plugin_hints_resolution_reason=plugin_hints_reason,
    )


def _build_default_motion_payload(
    runtime_state: Any,
    *,
    reason: str,
) -> tuple[dict[str, Any] | None, str]:
    try:
        semantic_profile = resolve_selected_semantic_axis_profile(
            runtime_state=runtime_state
        )
    except Exception as exc:  # noqa: BLE001
        return None, f"{reason}:default_pose_profile_unresolved:{exc}"

    profile_id = str(semantic_profile.get("profile_id") or "").strip()
    model_id = str(semantic_profile.get("model_id") or "").strip()
    if not profile_id or not model_id:
        return None, f"{reason}:default_pose_profile_identity_empty"

    try:
        profile_revision = int(semantic_profile.get("revision") or 0)
    except (TypeError, ValueError):
        profile_revision = 0
    if profile_revision <= 0:
        return None, f"{reason}:default_pose_profile_revision_invalid"

    fallback_pose_id = DEFAULT_FALLBACK_POSE_ID
    axes = resolve_fallback_pose_axes(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
        fallback_pose_id=fallback_pose_id,
    )
    if axes:
        resolved_reason = f"{reason}:default_pose:{fallback_pose_id}"
    else:
        axes = build_default_neutral_pose_axes(semantic_profile)
        resolved_reason = f"{reason}:default_pose_neutral"

    if not axes:
        return None, f"{reason}:default_pose_axes_empty"

    return {
        "schema_version": MOTION_INTENT_V3_SCHEMA_VERSION,
        "profile_id": profile_id,
        "profile_revision": profile_revision,
        "model_id": model_id,
        "mode": "expressive",
        "intent_tags": ["system_fallback"],
        "emotion_label": "system_fallback",
        "duration_hint_ms": DEFAULT_MOTION_INTENT_DURATION_MS,
        "resource_id": "",
        "fallback_pose_id": fallback_pose_id,
        "axes": axes,
        "summary": {"axis_count": len(axes), "intent_tag_count": 1},
    }, resolved_reason


def _log_plugin_hints_motion_resolution(
    event: Any,
    *,
    phase: str,
    payload: dict[str, Any] | None,
    reason: str,
    view: Any = None,
) -> None:
    hints = _extract_plugin_hints_from_view(view) if view is not None else None
    if hints is None:
        hints = _call_event_method(event, "get_extra", "_interaction_plugin_hints")
    hints = _coerce_plugin_hints_mapping(hints)
    hint_keys: list[str] = []
    motion_axes_keys: list[str] = []
    if isinstance(hints, dict):
        hint_keys = sorted(
            str(key).strip()
            for key in hints.keys()
            if str(key).strip()
        )
        motion_hint = hints.get("ag99live_motion")
        if isinstance(motion_hint, dict):
            axes = motion_hint.get("axes")
            if isinstance(axes, dict):
                motion_axes_keys = sorted(
                    str(key).strip()
                    for key in axes.keys()
                    if str(key).strip()
                )

    logger.info(
        "WIRING plugin_hints_motion phase=%s payload_present=%s reason=%s hint_keys=%s motion_axes=%s",
        phase or "",
        payload is not None,
        reason,
        ",".join(hint_keys),
        ",".join(motion_axes_keys),
    )


def _coerce_plugin_hints_mapping(value: Any) -> dict[str, Any] | None:
    hints, _reason = _coerce_plugin_hints_mapping_with_reason(value)
    return hints


def _coerce_plugin_hints_mapping_with_reason(
    value: Any,
) -> tuple[dict[str, Any] | None, str]:
    if isinstance(value, dict):
        return value, "ok"
    if not isinstance(value, str):
        return None, "plugin_hints_missing"

    raw_value = value.strip()
    if not raw_value:
        return None, "plugin_hints_missing"
    parsed, reason = _parse_json_mapping_lenient(raw_value)
    return parsed, reason


def _parse_json_mapping_lenient(raw_value: str) -> tuple[dict[str, Any] | None, str]:
    attempts: list[tuple[str, str]] = [("ok", raw_value)]

    fenced = _extract_fenced_json(raw_value)
    if fenced and fenced != raw_value:
        attempts.append(("plugin_hints_json_repaired:fenced_json", fenced))

    extracted = _extract_first_json_object(raw_value)
    if extracted and extracted not in {raw_value, fenced}:
        attempts.append(("plugin_hints_json_repaired:extracted_object", extracted))

    expanded_attempts: list[tuple[str, str]] = []
    seen: set[str] = set()
    for reason, candidate in attempts:
        if candidate not in seen:
            expanded_attempts.append((reason, candidate))
            seen.add(candidate)
        trailing_fixed = _strip_json_trailing_commas(candidate)
        if trailing_fixed != candidate and trailing_fixed not in seen:
            expanded_attempts.append(
                (
                    _append_resolution_reason(
                        reason,
                        "plugin_hints_json_repaired:trailing_commas",
                    ),
                    trailing_fixed,
                )
            )
            seen.add(trailing_fixed)

    for reason, candidate in expanded_attempts:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        mapping = _unwrap_plugin_hints_mapping(parsed)
        if isinstance(mapping, dict):
            return mapping, reason

    return None, "plugin_hints_json_rejected:json_decode_failed"


def _extract_fenced_json(raw_value: str) -> str | None:
    match = re.search(
        r"```(?:json|JSON)?\s*([\s\S]*?)\s*```",
        raw_value,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    return match.group(1).strip() or None


def _extract_first_json_object(raw_value: str) -> str | None:
    start = raw_value.find("{")
    if start < 0:
        return None
    in_string = False
    escaped = False
    depth = 0
    for index in range(start, len(raw_value)):
        char = raw_value[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            continue
        if char == "{":
            depth += 1
            continue
        if char == "}":
            depth -= 1
            if depth == 0:
                return raw_value[start : index + 1].strip()
    return None


def _strip_json_trailing_commas(value: str) -> str:
    output: list[str] = []
    in_string = False
    escaped = False
    index = 0
    while index < len(value):
        char = value[index]
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
            index += 1
            continue
        if char == ",":
            next_index = index + 1
            while next_index < len(value) and value[next_index].isspace():
                next_index += 1
            if next_index < len(value) and value[next_index] in "}]":
                index += 1
                continue
        output.append(char)
        index += 1
    return "".join(output)


def _unwrap_plugin_hints_mapping(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    if isinstance(value.get("ag99live_motion"), dict):
        return value
    plugin_hints = value.get("plugin_hints")
    if isinstance(plugin_hints, dict):
        if isinstance(plugin_hints.get("ag99live_motion"), dict):
            return plugin_hints
        nested = plugin_hints.get("plugin_hints")
        if isinstance(nested, dict) and isinstance(nested.get("ag99live_motion"), dict):
            return nested
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
    raw_mode = str(
        getattr(runtime_state, "motion_generation_mode", "split_after_reply") or ""
    ).strip()
    if raw_mode in {"inline_first", "split_after_reply"}:
        return raw_mode
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
        if motion_generation_mode == "inline_first":
            return _MotionSchedulePolicy(
                should_schedule=False,
                source=None,
                reason="self_reply_managed_by_inline_compat",
            )
        return _MotionSchedulePolicy(
            should_schedule=True,
            source="interaction_result_immediate",
            reason="schedule_self_reply_immediate",
        )
    if reply_plan.route_mode in {"hybrid", "delegate_to_core"}:
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="immediate_phase_waits_for_core_reply",
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
    if motion_generation_mode != "split_after_reply":
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="final_phase_managed_by_inline_compat",
        )
    if bool(_call_event_method(event, "get_extra", "ag99live_split_motion_scheduled", False)):
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


def _extract_plugin_hints_from_view(view: Any) -> Any:
    """Extract plugin_hints from the AstrBot view, preferring direct attributes.

    Returns a dict or str if found, otherwise None.  Callers must coerce the
    result with ``_coerce_plugin_hints_mapping_with_reason()``.
    """
    hints = getattr(view, "plugin_hints", None)
    if hints is not None:
        return hints

    metadata = getattr(view, "metadata", None)
    if isinstance(metadata, Mapping):
        hints = metadata.get("plugin_hints")
    elif callable(getattr(metadata, "get", None)):
        hints = metadata.get("plugin_hints")
    if hints is not None:
        return hints

    result = getattr(view, "result", None)
    if result is not None:
        hints = getattr(result, "plugin_hints", None)
        if hints is not None:
            return hints

    return None


def _call_event_method(event: Any, method_name: str, *args: Any) -> Any:
    method = getattr(event, method_name, None)
    if callable(method):
        return method(*args)
    return None
