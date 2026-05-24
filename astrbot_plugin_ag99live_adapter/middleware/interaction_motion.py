from __future__ import annotations

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
    resolve_selected_semantic_axis_profile,
)
from ..prompts.motion_selector import (
    resolve_motion_prompt_instruction,
)
from ..prompts.semantic_axis_prompt import profile_prompt_axes

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

    def to_metadata(self) -> dict[str, Any]:
        return {
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
                    "source": "plugin_hints",
                }
            )
        platform_extras = {"client_objects": client_objects} if client_objects else {}
        return InteractionResultContribution(
            plugin_id=self.plugin_id,
            platform_extras=platform_extras,
            client_objects=client_objects,
            metadata={"ag99live_motion_schedule": attempt.to_metadata()},
            priority=self.priority,
        )


def register_ag99live_interaction_contributors(context: Any) -> None:
    remove_prompt = getattr(
        context,
        "remove_interaction_prompt_contributors_by_module_prefix",
        None,
    )
    if callable(remove_prompt):
        remove_prompt("astrbot_plugin_ag99live_adapter.middleware")

    remove_result = getattr(
        context,
        "remove_interaction_result_contributors_by_module_prefix",
        None,
    )
    if callable(remove_result):
        remove_result("astrbot_plugin_ag99live_adapter.middleware")

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
    hints = _call_event_method(event, "get_extra", "_interaction_plugin_hints")
    if not isinstance(hints, dict):
        return None

    motion_hint = hints.get("ag99live_motion")
    if not isinstance(motion_hint, dict):
        return None

    mode = str(motion_hint.get("mode") or "").strip()
    if mode not in {"idle", "expressive"}:
        return None

    try:
        semantic_profile = resolve_selected_semantic_axis_profile(
            runtime_state=runtime_state
        )
    except Exception:
        return None

    axes = motion_hint.get("axes")
    validated_axes = _normalize_plugin_hint_axes(
        axes,
        semantic_profile,
        mode=mode,
        emotion_label=str(motion_hint.get("emotion_label") or "").strip() or "neutral",
    )
    if not validated_axes:
        return None

    profile_id = str(semantic_profile.get("profile_id") or "").strip()
    if not profile_id:
        return None

    emotion_label = str(motion_hint.get("emotion_label") or "").strip()
    if not emotion_label:
        emotion_label = "neutral"

    duration_hint_ms = motion_hint.get("duration_hint_ms")
    if duration_hint_ms is not None:
        try:
            duration_hint_ms = int(duration_hint_ms)
            duration_hint_ms = max(320, min(15000, duration_hint_ms))
        except (TypeError, ValueError):
            duration_hint_ms = None

    return {
        "schema_version": "engine.motion_intent.v2",
        "profile_id": profile_id,
        "profile_revision": int(semantic_profile.get("revision") or 0),
        "model_id": str(semantic_profile.get("model_id") or "").strip(),
        "mode": mode,
        "emotion_label": emotion_label,
        "duration_hint_ms": duration_hint_ms,
        "axes": validated_axes,
        "summary": {"axis_count": len(validated_axes)},
    }


def _normalize_plugin_hint_axes(
    axes: Any,
    semantic_profile: dict[str, Any],
    *,
    mode: str,
    emotion_label: str,
) -> dict[str, dict[str, float]] | None:
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

    normalized_axes: dict[str, dict[str, float]] = {}
    for axis_id_raw, axis_value in axes.items():
        axis_id = str(axis_id_raw or "").strip()
        if not axis_id:
            continue
        axis = axis_by_id.get(axis_id)
        if axis is None:
            continue
        if not isinstance(axis_value, dict):
            continue
        raw_value = axis_value.get("value")
        if not isinstance(raw_value, (int, float)):
            continue

        value = _coerce_plugin_hint_axis_value(float(raw_value), axis)
        normalized_axes[axis_id] = {"value": value}

    if not normalized_axes:
        return None

    if mode == "expressive":
        expressive_axes = _apply_expressive_floor_v2(
            axes={axis_id: axis_payload["value"] for axis_id, axis_payload in normalized_axes.items()},
            emotion=emotion_label,
            semantic_profile=semantic_profile,
        )
        normalized_axes = {
            axis_id: {"value": value}
            for axis_id, value in expressive_axes.items()
        }

    return normalized_axes


def _coerce_plugin_hint_axis_value(raw_value: float, axis: dict[str, Any]) -> float:
    min_value, max_value = _resolve_axis_value_range(axis)

    clamped = max(min_value, min(max_value, raw_value))
    return round(clamped, 4)


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

    profile_payload, _profile_error = _summarize_semantic_profile(runtime_state)
    if profile_payload is not None:
        capability_payload["semantic_profile"] = profile_payload
        capability_payload["plugin_hints_format"] = _build_plugin_hints_motion_format(profile_payload)

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

    return (
        "AG99live Motion 是当前桌宠前端的主动作通道。"
        "每次 interaction decision 都必须在 JSON 输出的 plugin_hints 中写入 ag99live_motion；"
        "不要把动作写进 immediate_spoken_reply、core_task_spec 或普通文本。"
        "ag99live_motion.mode 只能是 idle 或 expressive；axes 只能使用下方 schema 中已有的轴 id，"
        "每个轴值必须写成 {\"value\": number}。"
        "如果用户只是普通说话，也要给一个轻量 idle 或 expressive 动作。"
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
        axis_schema[axis_id] = {"value": _resolve_axis_neutral_value(axis)}

    return {
        "ag99live_motion": {
            "mode": "idle | expressive",
            "emotion_label": "neutral",
            "duration_hint_ms": 1500,
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
            "prompt_axes": [
                {
                    "id": str(axis.get("id") or "").strip(),
                    "label": str(axis.get("label") or axis.get("id") or "").strip(),
                    "control_role": str(axis.get("control_role") or "").strip(),
                }
                for axis in prompt_axes
                if str(axis.get("id") or "").strip()
            ],
        },
        None,
    )


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

    plugin_hints_payload = _resolve_plugin_hints_motion_payload(
        event, bundle.runtime_state
    )
    if plugin_hints_payload is not None:
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
        )

    policy = _resolve_motion_schedule_policy(
        event,
        phase=phase,
        motion_generation_mode=motion_generation_mode,
        reply_plan=reply_plan,
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
    )


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
        should_schedule=False,
        source=None,
        reason="plugin_hints_motion_missing",
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
