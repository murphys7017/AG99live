from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from astrbot.api import logger

from .compatibility import (
    InteractionResultContribution,
    get_interaction_reply_plan,
)
from .effects import (
    _effect_call_get,
    _extract_ag99live_motion_effect_arguments,
    _extract_effect_calls_for_motion,
    _resolve_persona_effect_motion_payload_with_reason,
)
from .shared import (
    INTERACTION_ROUTE_DECISION_EXTRA_KEY,
    _FrontendIdentitySnapshot,
    _MotionRuntimeBundle,
    _append_resolution_reason,
    _call_event_method,
    _normalize_optional_string,
    _resolve_frontend_identity_snapshot,
    _resolve_motion_runtime_bundle,
    _resolve_result_phase,
    _thaw_snapshot_value,
)
from ...motion.motion_intent import resolve_selected_semantic_axis_profile
from ...motion.observation import record_motion_observation
from ...motion.output_sanitizer import (
    contains_hidden_output_markup,
    sanitize_assistant_output_text,
)


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
    reply_plan_route_mode: str | None
    reply_plan_should_emit_immediate_reply: bool | None
    reply_plan_source: str | None
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
            "reply_plan_route_mode": self.reply_plan_route_mode,
            "reply_plan_should_emit_immediate_reply": self.reply_plan_should_emit_immediate_reply,
            "reply_plan_source": self.reply_plan_source,
            "scheduled": self.scheduled,
            "reason": self.reason,
        }
        if self.motion_resolution_reason:
            metadata["motion_resolution_reason"] = self.motion_resolution_reason
        return metadata

class AG99liveMotionResultContributor:
    plugin_id = "ag99live.motion.result"
    priority = 40

    async def collect(self, event, plugin_context, view):
        del plugin_context
        event.set_extra("_ag99live_pending_performance_curve", None)
        event.set_extra("ag99live_raw_reply_text", None)
        speech_cues = _take_pending_speech_cues(event)

        attempt = await _schedule_motion_from_interaction_result(event, view)
        if attempt is None and not speech_cues:
            return None

        client_objects = []
        raw_assistant_text = _extract_raw_assistant_text(view)
        final_text_override = None
        if raw_assistant_text and contains_hidden_output_markup(raw_assistant_text):
            event.set_extra("ag99live_raw_reply_text", raw_assistant_text)
            final_text_override = sanitize_assistant_output_text(raw_assistant_text)
        if attempt is not None and attempt.motion_payload is not None:
            client_objects.append(
                {
                    "type": "ag99live.motion_payload",
                    "motion_payload": attempt.motion_payload,
                    "mode": "preview",
                    "source": attempt.source or "persona_effect",
                }
            )
            _defer_optional_performance_curve_request(event, attempt=attempt)
        platform_extras = {}
        if speech_cues:
            platform_extras["ag99live_speech_cues"] = speech_cues
        return InteractionResultContribution(
            plugin_id=self.plugin_id,
            platform_extras=platform_extras,
            final_text_override=final_text_override,
            client_objects=client_objects,
            metadata=(
                {"ag99live_motion_schedule": attempt.to_metadata()}
                if attempt is not None
                else {}
            ),
            priority=self.priority,
        )


def _take_pending_speech_cues(event: Any) -> list[dict[str, Any]]:
    value = event.get_extra("_ag99live_pending_speech_cues")
    event.set_extra("_ag99live_pending_speech_cues", None)
    if value is None:
        return []
    if not isinstance(value, list):
        raise TypeError("ag99live_pending_speech_cues_internal_contract_invalid")
    return value


def _defer_optional_performance_curve_request(
    event: Any,
    *,
    attempt: _MotionScheduleAttempt,
) -> None:
    if attempt.motion_payload is None or not attempt.assistant_text:
        return
    event.set_extra(
        "_ag99live_pending_performance_curve",
        {
            "assistant_text": attempt.assistant_text,
            "motion_payload": attempt.motion_payload,
        },
    )

def start_deferred_performance_curve_request(
    event: Any,
    *,
    turn_id: str,
    message_id: str,
    tts_request_id: str,
    external_correlation_id: str | None,
) -> str | None:
    pending = event.get_extra("_ag99live_pending_performance_curve")
    if not isinstance(pending, dict):
        return None
    event.set_extra("_ag99live_pending_performance_curve", None)
    bundle = _resolve_motion_runtime_bundle(event)
    if bundle is None:
        logger.warning(
            "WIRING performance_curve.skipped reason=motion_runtime_unavailable "
            "turn_id=%s message_id=%s tts_request_id=%s",
            external_correlation_id or "<missing>",
            message_id or "<missing>",
            tts_request_id or "<missing>",
        )
        return None
    request_id = bundle.turn_coordinator.start_performance_curve_request(
        turn_id=external_correlation_id,
        tts_turn_id=turn_id,
        message_id=message_id,
        request_id=tts_request_id,
        assistant_text=str(pending.get("assistant_text") or ""),
        motion_payload=pending.get("motion_payload"),
    )
    if request_id:
        logger.info(
            "WIRING performance_curve_started turn_id=%s message_id=%s "
            "tts_request_id=%s",
            turn_id,
            message_id,
            tts_request_id,
        )
    return request_id

async def _schedule_motion_from_interaction_result(
    event: Any,
    view: Any,
) -> _MotionScheduleAttempt | None:
    bundle = _resolve_motion_runtime_bundle(event)
    if bundle is None:
        return None

    phase = _resolve_result_phase(view)
    assistant_text = _extract_assistant_text(view)
    identity = _resolve_frontend_identity_snapshot(event)
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
        reply_plan=reply_plan,
    )

    if motion_payload is not None and policy.should_schedule:
        _call_event_method(event, "set_extra", "ag99live_split_motion_scheduled", True)
        return _MotionScheduleAttempt(
            phase=phase,
            source="persona_effect",
            scheduled_frontend_turn_id=identity.scheduled_frontend_turn_id,
            event_frontend_turn_id=identity.event_frontend_turn_id,
            reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
            reply_plan_should_emit_immediate_reply=(
                reply_plan.should_emit_immediate_reply if reply_plan is not None else None
            ),
            reply_plan_source=reply_plan.source if reply_plan is not None else None,
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
            reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
            reply_plan_should_emit_immediate_reply=(
                reply_plan.should_emit_immediate_reply if reply_plan is not None else None
            ),
            reply_plan_source=reply_plan.source if reply_plan is not None else None,
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
            reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
            reply_plan_should_emit_immediate_reply=(
                reply_plan.should_emit_immediate_reply if reply_plan is not None else None
            ),
            reply_plan_source=reply_plan.source if reply_plan is not None else None,
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
            reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
            reply_plan_should_emit_immediate_reply=(
                reply_plan.should_emit_immediate_reply if reply_plan is not None else None
            ),
            reply_plan_source=reply_plan.source if reply_plan is not None else None,
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
        reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
        reply_plan_should_emit_immediate_reply=(
            reply_plan.should_emit_immediate_reply if reply_plan is not None else None
        ),
        reply_plan_source=reply_plan.source if reply_plan is not None else None,
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
        logger.exception("MotionLab interaction profile resolution failed")
        profile = None
    effect_calls = [_thaw_snapshot_value(item) for item in _extract_effect_calls_for_motion(event, view)]
    turn_id = identity.scheduled_frontend_turn_id
    observation_context = {
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
    record_motion_observation(
        getattr(bundle.runtime_state, "motion_lab_recorder", None),
        **observation_context,
        event_type="motion.persona_effect_received",
        payload_kind="effect_calls",
        raw={
            "effect_calls": effect_calls,
            "effect_summary": _summarize_ag99live_motion_effect_arguments(event, view),
            "view_metadata": _thaw_snapshot_value(getattr(view, "metadata", None)),
            "reply_plan": _thaw_snapshot_value(get_interaction_reply_plan(event)),
            "original_user_text": _call_event_method(event, "get_extra", "ag99live_original_message_str", ""),
        },
    )
    record_motion_observation(
        getattr(bundle.runtime_state, "motion_lab_recorder", None),
        **observation_context,
        event_type="motion.intent_resolved",
        payload_kind=(
            str(motion_payload.get("schema_version") or "").strip()
            if isinstance(motion_payload, dict)
            else ""
        ),
        raw={
            "motion_payload": motion_payload,
            "motion_reason": motion_reason,
            "effect_calls": effect_calls,
            "assistant_text": assistant_text,
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

def _extract_assistant_text(view: Any) -> str:
    return sanitize_assistant_output_text(_extract_raw_assistant_text(view)).strip()

def _extract_raw_assistant_text(view: Any) -> str:
    for value in (
        getattr(view, "final_result", None),
        getattr(view, "core_result", None),
        getattr(view, "immediate_reply", None),
    ):
        text = str(value or "").strip()
        if text:
            return text
    return ""

def _resolve_motion_schedule_policy(
    event: Any,
    *,
    phase: str,
    reply_plan: _InteractionReplyPlanSnapshot | None,
) -> _MotionSchedulePolicy:
    if phase == "immediate":
        return _resolve_immediate_phase_policy()
    if phase == "final":
        return _resolve_final_phase_policy(
            event,
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
