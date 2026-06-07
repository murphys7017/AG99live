from __future__ import annotations

import json
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
from ..motion.realtime_motion_plan import (
    _apply_expressive_floor_v2,
    DEFAULT_MOTION_INTENT_DURATION_MS,
    MOTION_INTENT_V3_SCHEMA_VERSION,
    resolve_selected_semantic_axis_profile,
)
from ..motion.fallback_pose import (
    DEFAULT_FALLBACK_POSE_ID,
    build_default_neutral_pose_axes,
    build_fallback_pose_candidates,
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

        attempt = _schedule_motion_from_interaction_result(event, view)
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
) -> dict[str, Any] | None:
    payload, _reason = _resolve_plugin_hints_motion_payload_with_reason(
        event,
        runtime_state,
    )
    return payload


def _resolve_plugin_hints_motion_payload_with_reason(
    event: Any,
    runtime_state: Any,
) -> tuple[dict[str, Any] | None, str]:
    hints = _coerce_plugin_hints_mapping(
        _call_event_method(event, "get_extra", "_interaction_plugin_hints")
    )
    if not isinstance(hints, dict):
        return None, "plugin_hints_missing"

    motion_hint = hints.get("ag99live_motion")
    if not isinstance(motion_hint, dict):
        return None, "ag99live_motion_missing"

    forbidden_fields = [
        key
        for key in ("choice", "mode", "motion_id", "catalog_motion", "motion3", "exp3")
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

    emotion_label = str(motion_hint.get("emotion_label") or "").strip()
    if not emotion_label:
        emotion_label = "neutral"

    fallback_pose_id = str(motion_hint.get("fallback_pose_id") or "").strip()
    axes = motion_hint.get("axes")
    validated_axes = None
    reason = "ok"
    if forbidden_fields:
        reason = "forbidden_fields:" + ",".join(forbidden_fields)
    else:
        validated_axes = _normalize_plugin_hint_axes(
            axes,
            semantic_profile,
            emotion_label=emotion_label,
        )
        if not validated_axes:
            reason = "axes_empty_or_invalid"

    if not validated_axes:
        fallback_axes = resolve_fallback_pose_axes(
            runtime_state=runtime_state,
            semantic_profile=semantic_profile,
            fallback_pose_id=fallback_pose_id,
        )
        if fallback_axes:
            validated_axes = fallback_axes
            reason = f"{reason}:fallback_pose:{fallback_pose_id}"
        else:
            validated_axes = build_default_neutral_pose_axes(semantic_profile)
            fallback_pose_id = DEFAULT_FALLBACK_POSE_ID
            reason = f"{reason}:fallback_pose_default:{DEFAULT_FALLBACK_POSE_ID}"

    if not validated_axes:
        return None, reason

    duration_hint_ms = _normalize_duration_hint_ms(motion_hint.get("duration_hint_ms"))

    return {
        "schema_version": MOTION_INTENT_V3_SCHEMA_VERSION,
        "profile_id": profile_id,
        "profile_revision": int(semantic_profile.get("revision") or 0),
        "model_id": str(semantic_profile.get("model_id") or "").strip(),
        "mode": "expressive",
        "emotion_label": emotion_label,
        "duration_hint_ms": duration_hint_ms,
        "fallback_pose_id": fallback_pose_id,
        "axes": validated_axes,
        "summary": {"axis_count": len(validated_axes)},
    }, reason


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

    normalized_axes = _apply_expressive_floor_v2(
        axes=normalized_axes,
        emotion=emotion_label,
        semantic_profile=semantic_profile,
    )

    return normalized_axes


def _coerce_plugin_hint_axis_value(raw_value: float, axis: dict[str, Any]) -> float:
    min_value, max_value = _resolve_axis_value_range(axis)

    clamped = max(min_value, min(max_value, raw_value))
    return round(clamped, 4)


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
        capability_payload["plugin_hints_format"] = _build_plugin_hints_motion_format(profile_payload)
        if isinstance(raw_profile, dict):
            fallback_candidates = build_fallback_pose_candidates(
                runtime_state=runtime_state,
                semantic_profile=raw_profile,
                limit=12,
            )
            if fallback_candidates:
                capability_payload["fallback_pose_candidates"] = [
                    {
                        "id": str(item.get("id") or "").strip(),
                        "label": str(item.get("label") or item.get("id") or "").strip(),
                        "emotion_label": str(item.get("emotion_label") or "").strip(),
                        "source": str(item.get("source") or "").strip(),
                    }
                    for item in fallback_candidates
                    if str(item.get("id") or "").strip()
                ]

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
    fallback_pose_text = ""
    fallback_candidates = capability_payload.get("fallback_pose_candidates")
    if isinstance(fallback_candidates, list) and fallback_candidates:
        lines = ["可用 fallback_pose_id："]
        for item in fallback_candidates:
            if not isinstance(item, dict):
                continue
            pose_id = str(item.get("id") or "").strip()
            if not pose_id:
                continue
            label = str(item.get("label") or pose_id).strip()
            source = str(item.get("source") or "").strip()
            lines.append(f"- {pose_id}: {label}" + (f" ({source})" if source else ""))
        fallback_pose_text = "\n".join(lines) + "\n"

    return (
        "AG99live Motion 是当前桌宠前端的主动作通道。"
        "每次 interaction decision 都必须在 JSON 输出的 plugin_hints 中写入 ag99live_motion；"
        "不要把动作写进 immediate_spoken_reply、core_task_spec 或普通文本。"
        "ag99live_motion 只允许 emotion_label、duration_hint_ms、fallback_pose_id、axes 四类动作字段。"
        "不要输出 choice、mode、motion_id、catalog、motion3、exp3 或任何播放文件引用。"
        "axes 只能使用下方 schema 中已有的轴 id，每个轴值必须直接写成 number，例如 \"head_yaw\": 62。"
        "不要生成关键帧、时间曲线、随机抖动或来回摆动。"
        "fallback_pose_id 必须从候选中选择；它只是解析失败时的语义姿态兜底，不是播放表情文件。"
        "如果用户只是普通说话，也要给一个轻量语义姿态。"
        "不要把输出形状或情绪名称当成封闭动作模板；先理解本轮对话语气，再自由组合相关轴。"
        "避免连续复用同一组轴和值；平静语气也要在头部朝向、身体跟随、视线和眼部之间做轻微语义变化。"
        "明确转身、强调、回避、惊讶、调侃、开心或疑惑时，优先用 head_yaw/head_roll/head_pitch "
        "配合 body_yaw/body_roll/body_pitch 建立可见动作骨架，再少量补眼部和表情细节。"
        "输出形状示例只展示 JSON 结构和可用轴，里面的中位值不是推荐动作；实际输出应保留本轮有语义贡献的轴。"
        f"{style_text}"
        f"{axis_prompt_text}"
        f"{fallback_pose_text}"
        f" 输出形状示例：{format_json}"
    )


def _build_plugin_hints_motion_format(profile_payload: dict[str, Any]) -> dict[str, Any]:
    prompt_axes = profile_payload.get("prompt_axes")
    if not isinstance(prompt_axes, list) or not prompt_axes:
        return {}

    axis_schema: dict[str, Any] = {}
    for axis in prompt_axes:
        if not isinstance(axis, dict):
            continue
        axis_id = str(axis.get("id") or "").strip()
        if not axis_id:
            continue
        axis_schema[axis_id] = _resolve_axis_neutral_value(axis)

    return {
        "ag99live_motion": {
            "emotion_label": "neutral",
            "duration_hint_ms": DEFAULT_MOTION_INTENT_DURATION_MS,
            "fallback_pose_id": DEFAULT_FALLBACK_POSE_ID,
            "axes": axis_schema,
        },
    }


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
    del event, turn_coordinator, view
    return {
        "configured_generation_mode": _resolve_motion_generation_mode(runtime_state),
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
    if not isinstance(value, list):
        return []
    return [
        _truncate_text(str(item).strip(), 48)
        for item in value
        if str(item).strip()
    ]


def _normalize_axis_range(value: Any, fallback: list[float] | None) -> list[float] | None:
    if (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], (int, float))
        and isinstance(value[1], (int, float))
    ):
        return [float(value[0]), float(value[1])]
    return fallback


def _schedule_motion_from_interaction_result(
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
        event, bundle.runtime_state
    )
    _log_plugin_hints_motion_resolution(
        event,
        phase=phase,
        payload=plugin_hints_payload,
        reason=plugin_hints_reason,
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
            reason=plugin_hints_reason,
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
        "emotion_label": "neutral",
        "duration_hint_ms": DEFAULT_MOTION_INTENT_DURATION_MS,
        "fallback_pose_id": fallback_pose_id,
        "axes": axes,
        "summary": {"axis_count": len(axes)},
    }, resolved_reason


def _log_plugin_hints_motion_resolution(
    event: Any,
    *,
    phase: str,
    payload: dict[str, Any] | None,
    reason: str,
) -> None:
    hints = _coerce_plugin_hints_mapping(
        _call_event_method(event, "get_extra", "_interaction_plugin_hints")
    )
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
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None

    raw_value = value.strip()
    if not raw_value:
        return None
    try:
        parsed = json.loads(raw_value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


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


def _call_event_method(event: Any, method_name: str, *args: Any) -> Any:
    method = getattr(event, method_name, None)
    if callable(method):
        return method(*args)
    return None
