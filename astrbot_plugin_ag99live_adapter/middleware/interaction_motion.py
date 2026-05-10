from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from astrbot.api import logger

from ..motion.output_sanitizer import sanitize_assistant_output_text
from ..motion.realtime_motion_plan import resolve_selected_semantic_axis_profile
from ..prompts.motion_selector import (
    profile_prompt_axes,
    resolve_motion_prompt_instruction,
)

try:
    from astrbot.core.interaction import (
        InteractionResultContribution,
        get_interaction_decision,
    )
except Exception:  # pragma: no cover - compatibility with older AstrBot builds
    InteractionResultContribution = None
    get_interaction_decision = None

try:
    from astrbot.core.prompt import PromptExtension
except Exception:  # pragma: no cover - compatibility with older AstrBot builds
    PromptExtension = None


@dataclass(slots=True)
class _MotionRuntimeBundle:
    adapter: Any
    turn_coordinator: Any
    runtime_state: Any


@dataclass(slots=True)
class _FrontendIdentitySnapshot:
    event_frontend_turn_id: str | None
    event_frontend_orchestration_id: str | None
    active_frontend_turn_id: str | None
    active_frontend_orchestration_id: str | None

    @property
    def scheduled_frontend_turn_id(self) -> str | None:
        return self.event_frontend_turn_id or self.active_frontend_turn_id

    @property
    def scheduled_frontend_orchestration_id(self) -> str | None:
        return (
            self.event_frontend_orchestration_id
            or self.active_frontend_orchestration_id
        )


@dataclass(slots=True)
class _InteractionDecisionSnapshot:
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
    scheduled_frontend_orchestration_id: str | None
    event_frontend_turn_id: str | None
    event_frontend_orchestration_id: str | None
    active_frontend_turn_id: str | None
    active_frontend_orchestration_id: str | None
    decision_route_mode: str | None
    decision_should_emit_immediate_reply: bool | None
    decision_source: str | None
    motion_generation_mode: str
    scheduled: bool
    reason: str
    assistant_text: str

    def to_metadata(self) -> dict[str, Any]:
        return {
            "phase": self.phase,
            "source": self.source,
            "scheduled_frontend_turn_id": self.scheduled_frontend_turn_id,
            "scheduled_frontend_orchestration_id": self.scheduled_frontend_orchestration_id,
            "event_frontend_turn_id": self.event_frontend_turn_id,
            "event_frontend_orchestration_id": self.event_frontend_orchestration_id,
            "active_frontend_turn_id": self.active_frontend_turn_id,
            "active_frontend_orchestration_id": self.active_frontend_orchestration_id,
            "decision_route_mode": self.decision_route_mode,
            "decision_should_emit_immediate_reply": self.decision_should_emit_immediate_reply,
            "decision_source": self.decision_source,
            "motion_generation_mode": self.motion_generation_mode,
            "scheduled": self.scheduled,
            "reason": self.reason,
        }


class AG99liveMotionPromptContributor:
    plugin_id = "ag99live.motion.prompt"
    priority = 40

    async def collect(self, event, plugin_context, view):
        del plugin_context

        if PromptExtension is None:
            return None

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
        if attempt is None or InteractionResultContribution is None:
            return None

        return InteractionResultContribution(
            plugin_id=self.plugin_id,
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
    if callable(register_prompt) and PromptExtension is not None:
        register_prompt(AG99liveMotionPromptContributor())
    elif callable(register_prompt):
        logger.warning(
            "AG99live interaction prompt contributor skipped because PromptExtension is unavailable."
        )

    register_result = getattr(context, "register_interaction_result_contributor", None)
    if callable(register_result) and InteractionResultContribution is not None:
        register_result(AG99liveMotionResultContributor())
    elif callable(register_result):
        logger.warning(
            "AG99live interaction result contributor skipped because InteractionResultContribution is unavailable."
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


def _build_motion_capability_payload(runtime_state: Any) -> dict[str, Any]:
    motion_generation_mode = _resolve_motion_generation_mode(runtime_state)
    capability_payload: dict[str, Any] = {
        "motion_output_supported": True,
        "configured_generation_mode": motion_generation_mode,
        "supported_generation_modes": [
            "inline_first",
            "split_after_reply",
            "text_only",
        ],
        "default_motion_schema": "engine.motion_intent.v2",
        "supported_engine_message_types": [
            "engine.motion_intent",
            "engine.motion_plan",
        ],
        "inline_contract_supported": bool(
            getattr(runtime_state, "enable_inline_motion_contract", True)
        ),
        "realtime_motion_enabled": bool(
            getattr(runtime_state, "enable_realtime_motion_plan", True)
        ),
        "motion_instruction": resolve_motion_prompt_instruction(
            runtime_state=runtime_state
        ),
    }

    selected_model = _resolve_selected_model_name(runtime_state)
    if selected_model:
        capability_payload["selected_model"] = selected_model

    profile_payload, profile_error = _summarize_semantic_profile(runtime_state)
    capability_payload["profile_available"] = profile_payload is not None
    if profile_payload is not None:
        capability_payload["semantic_profile"] = profile_payload
    if profile_error:
        capability_payload["profile_error"] = profile_error

    return capability_payload


def _build_motion_runtime_payload(
    event: Any,
    turn_coordinator: Any,
    runtime_state: Any,
    *,
    view: Any,
) -> dict[str, Any]:
    identity = _resolve_frontend_identity_snapshot(event, turn_coordinator)
    runtime_payload: dict[str, Any] = {
        "interaction_turn_id": _normalize_optional_string(getattr(view, "turn_id", None)),
        "event_frontend_turn_id": identity.event_frontend_turn_id,
        "event_frontend_orchestration_id": identity.event_frontend_orchestration_id,
        "active_frontend_turn_id": identity.active_frontend_turn_id,
        "active_frontend_orchestration_id": identity.active_frontend_orchestration_id,
        "configured_generation_mode": _resolve_motion_generation_mode(runtime_state),
        "realtime_motion_enabled": bool(
            getattr(runtime_state, "enable_realtime_motion_plan", True)
        ),
    }

    selected_model = _resolve_selected_model_name(runtime_state)
    if selected_model:
        runtime_payload["selected_model"] = selected_model

    return {key: value for key, value in runtime_payload.items() if value is not None}


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
    decision = _resolve_interaction_decision_snapshot(event, view)
    policy = _resolve_motion_schedule_policy(
        event,
        phase=phase,
        motion_generation_mode=motion_generation_mode,
        decision=decision,
    )

    if motion_generation_mode == "text_only":
        return _MotionScheduleAttempt(
            phase=phase,
            source=None,
            scheduled_frontend_turn_id=identity.scheduled_frontend_turn_id,
            scheduled_frontend_orchestration_id=identity.scheduled_frontend_orchestration_id,
            event_frontend_turn_id=identity.event_frontend_turn_id,
            event_frontend_orchestration_id=identity.event_frontend_orchestration_id,
            active_frontend_turn_id=identity.active_frontend_turn_id,
            active_frontend_orchestration_id=identity.active_frontend_orchestration_id,
            decision_route_mode=decision.route_mode if decision is not None else None,
            decision_should_emit_immediate_reply=(
                decision.should_emit_immediate_reply if decision is not None else None
            ),
            decision_source=decision.source if decision is not None else None,
            motion_generation_mode=motion_generation_mode,
            scheduled=False,
            reason="motion_generation_disabled",
            assistant_text=assistant_text,
        )

    if not assistant_text:
        return _MotionScheduleAttempt(
            phase=phase,
            source=None,
            scheduled_frontend_turn_id=identity.scheduled_frontend_turn_id,
            scheduled_frontend_orchestration_id=identity.scheduled_frontend_orchestration_id,
            event_frontend_turn_id=identity.event_frontend_turn_id,
            event_frontend_orchestration_id=identity.event_frontend_orchestration_id,
            active_frontend_turn_id=identity.active_frontend_turn_id,
            active_frontend_orchestration_id=identity.active_frontend_orchestration_id,
            decision_route_mode=decision.route_mode if decision is not None else None,
            decision_should_emit_immediate_reply=(
                decision.should_emit_immediate_reply if decision is not None else None
            ),
            decision_source=decision.source if decision is not None else None,
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
            scheduled_frontend_orchestration_id=identity.scheduled_frontend_orchestration_id,
            event_frontend_turn_id=identity.event_frontend_turn_id,
            event_frontend_orchestration_id=identity.event_frontend_orchestration_id,
            active_frontend_turn_id=identity.active_frontend_turn_id,
            active_frontend_orchestration_id=identity.active_frontend_orchestration_id,
            decision_route_mode=decision.route_mode if decision is not None else None,
            decision_should_emit_immediate_reply=(
                decision.should_emit_immediate_reply if decision is not None else None
            ),
            decision_source=decision.source if decision is not None else None,
            motion_generation_mode=motion_generation_mode,
            scheduled=False,
            reason=policy.reason,
            assistant_text=assistant_text,
        )

    scheduled = bool(
        bundle.turn_coordinator.schedule_motion_after_reply(
            assistant_text=assistant_text,
            origin_turn_id=identity.scheduled_frontend_turn_id,
            source=policy.source,
        )
    )
    if scheduled and motion_generation_mode == "split_after_reply":
        _call_event_method(event, "set_extra", "ag99live_split_motion_scheduled", True)

    return _MotionScheduleAttempt(
        phase=phase,
        source=policy.source,
        scheduled_frontend_turn_id=identity.scheduled_frontend_turn_id,
        scheduled_frontend_orchestration_id=identity.scheduled_frontend_orchestration_id,
        event_frontend_turn_id=identity.event_frontend_turn_id,
        event_frontend_orchestration_id=identity.event_frontend_orchestration_id,
        active_frontend_turn_id=identity.active_frontend_turn_id,
        active_frontend_orchestration_id=identity.active_frontend_orchestration_id,
        decision_route_mode=decision.route_mode if decision is not None else None,
        decision_should_emit_immediate_reply=(
            decision.should_emit_immediate_reply if decision is not None else None
        ),
        decision_source=decision.source if decision is not None else None,
        motion_generation_mode=motion_generation_mode,
        scheduled=scheduled,
        reason="scheduled" if scheduled else "deduped_or_rejected",
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


def _resolve_selected_model_name(runtime_state: Any) -> str | None:
    model_info = getattr(runtime_state, "model_info", None)
    if not isinstance(model_info, dict):
        return None
    return _normalize_optional_string(model_info.get("selected_model"))


def _resolve_motion_generation_mode(runtime_state: Any) -> str:
    raw_mode = str(
        getattr(runtime_state, "motion_generation_mode", "split_after_reply") or ""
    ).strip()
    if raw_mode in {"inline_first", "split_after_reply", "text_only"}:
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
    decision: _InteractionDecisionSnapshot | None,
) -> _MotionSchedulePolicy:
    if phase == "immediate":
        return _resolve_immediate_phase_policy(decision)
    if phase == "final":
        return _resolve_final_phase_policy(
            event,
            motion_generation_mode=motion_generation_mode,
            decision=decision,
        )
    return _MotionSchedulePolicy(
        should_schedule=False,
        source=None,
        reason="unsupported_phase",
    )


def _resolve_immediate_phase_policy(
    decision: _InteractionDecisionSnapshot | None,
) -> _MotionSchedulePolicy:
    if decision is None:
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="immediate_phase_decision_unresolved",
        )
    if decision.route_mode == "self_reply":
        return _MotionSchedulePolicy(
            should_schedule=True,
            source="interaction_result_immediate",
            reason="schedule_self_reply_immediate",
        )
    if decision.route_mode in {"hybrid", "delegate_to_core"}:
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="immediate_phase_waits_for_core_reply",
        )
    if decision.route_mode:
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="immediate_phase_route_unresolved",
        )
    return _MotionSchedulePolicy(
        should_schedule=False,
        source=None,
        reason="immediate_phase_decision_unresolved",
    )


def _resolve_final_phase_policy(
    event: Any,
    *,
    motion_generation_mode: str,
    decision: _InteractionDecisionSnapshot | None,
) -> _MotionSchedulePolicy:
    if decision is not None and decision.route_mode == "self_reply":
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="self_reply_does_not_use_final_phase",
        )
    if motion_generation_mode != "split_after_reply":
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="final_phase_managed_by_primary_reply_chain",
        )
    if bool(_call_event_method(event, "get_extra", "ag99live_split_motion_scheduled", False)):
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="already_scheduled_by_primary_reply_chain",
        )
    return _MotionSchedulePolicy(
        should_schedule=True,
        source="interaction_result_final_fallback",
        reason="schedule_split_reply_fallback",
    )


def _resolve_interaction_decision_snapshot(
    event: Any,
    view: Any,
) -> _InteractionDecisionSnapshot | None:
    if callable(get_interaction_decision):
        try:
            decision = get_interaction_decision(event)
        except Exception:  # pragma: no cover - compatibility fallback
            decision = None
        snapshot = _coerce_interaction_decision_snapshot(
            decision,
            source="event_turn_state",
        )
        if snapshot is not None:
            return snapshot

    snapshot = _coerce_interaction_decision_snapshot(
        _call_event_method(event, "get_extra", "_interaction_decision", None),
        source="event_extra",
    )
    if snapshot is not None:
        return snapshot

    return _coerce_interaction_decision_snapshot(
        getattr(view, "decision", None),
        source="view",
    )


def _coerce_interaction_decision_snapshot(
    value: Any,
    *,
    source: str,
) -> _InteractionDecisionSnapshot | None:
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
    return _InteractionDecisionSnapshot(
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
    event_frontend_orchestration_id = None
    if isinstance(raw_message, dict):
        event_frontend_turn_id = _normalize_optional_string(raw_message.get("turn_id"))
        event_frontend_orchestration_id = _normalize_optional_string(
            raw_message.get("orchestration_id")
        )
    session_state = getattr(turn_coordinator, "session_state", None)
    return _FrontendIdentitySnapshot(
        event_frontend_turn_id=event_frontend_turn_id,
        event_frontend_orchestration_id=event_frontend_orchestration_id,
        active_frontend_turn_id=_normalize_optional_string(
            getattr(session_state, "current_turn_id", None)
        ),
        active_frontend_orchestration_id=_normalize_optional_string(
            getattr(session_state, "current_orchestration_id", None)
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
