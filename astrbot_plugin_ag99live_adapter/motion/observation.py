from __future__ import annotations

from collections.abc import Mapping
from uuid import NAMESPACE_URL, uuid5
from typing import Any, Callable, Protocol

from astrbot.api import logger

from ..runtime.adapter_event_context import resolve_adapter_event_context
from ..runtime.persona_lifecycle import PersonaTurnIdentity


class MotionObservationPort(Protocol):
    def enqueue(
        self,
        event: dict[str, Any],
        *,
        on_persisted: Callable[[], None] | None = None,
    ) -> bool: ...


PERSONA_MOTION_SAMPLE_SCHEMA = "ag99live.persona_motion_sample.v1"
PERSONA_MOTION_SOURCE_ROUTE_EXTRA_KEY = "_ag99live_persona_motion_source_route"


def resolve_persona_motion_source_route(
    event: Any,
    runtime_state: Any,
    *,
    capture_if_missing: bool = False,
) -> str | None:
    """Return the route latched for this event, optionally capturing it once."""
    event_context = resolve_adapter_event_context(event)
    existing = event_context.persona_motion_source_route
    if existing in {"persona_effect", "independent_motion"}:
        return existing
    if not capture_if_missing:
        return None

    source_route = (
        "independent_motion"
        if bool(getattr(runtime_state, "independent_motion_enabled", False))
        else "persona_effect"
    )
    event_context.set_persona_motion_source_route(event, source_route)
    return source_route


def resolve_persona_delivery_mode(event: Any) -> str:
    """Resolve the actual Persona delivery path from Adapter-owned state."""
    event_context = resolve_adapter_event_context(event)
    if not event_context.persona_segment_stream_active:
        return "M0_nonstreaming"
    adapter = getattr(event, "adapter", None)
    runtime_state = getattr(adapter, "runtime_state", None)
    sessions = getattr(runtime_state, "persona_sessions", None)
    turn_id = event_context.core_turn_id
    if (
        sessions is not None
        and turn_id
        and sessions.get_active_result(PersonaTurnIdentity(turn_id)) is not None
    ):
        return "M2_olv_incremental"
    return "M1_persona_segment_stream"


def resolve_persona_core_turn_id(event: Any) -> str | None:
    event_context = resolve_adapter_event_context(event)
    adapter = getattr(event, "adapter", None)
    sessions = getattr(getattr(adapter, "runtime_state", None), "persona_sessions", None)
    turn_id = event_context.core_turn_id
    result = (
        sessions.get_active_result(PersonaTurnIdentity(turn_id))
        if sessions is not None and turn_id
        else None
    )
    writer = result.writer if result is not None else None
    core_turn_id = str(getattr(writer, "core_turn_id", "") or "").strip()
    return core_turn_id or None


def record_persona_motion_sample(
    recorder: MotionObservationPort | None,
    *,
    turn_id: str,
    core_turn_id: str | None = None,
    persona_result_id: str | None,
    segment_index: int,
    segment_count: int | None,
    segment_message_id: str | None,
    source_route: str,
    delivery_mode: str,
    record_stage: str,
    record_key: str,
    input_context: Mapping[str, Any],
    persona_segment: Mapping[str, Any],
    motion: Mapping[str, Any],
) -> bool:
    normalized_turn_id = str(turn_id or "").strip()
    normalized_source = str(source_route or "").strip()
    normalized_stage = str(record_stage or "").strip()
    normalized_record_key = str(record_key or "").strip()
    if (
        recorder is None
        or not normalized_turn_id
        or normalized_turn_id == "<missing>"
        or not normalized_source
        or type(segment_index) is not int
        or segment_index < 0
        or not normalized_stage
        or not normalized_record_key
    ):
        return False

    normalized_result_id = str(persona_result_id or "").strip()
    identity_key = "|".join(
        (
            normalized_turn_id,
            normalized_result_id,
            str(segment_index),
            normalized_source,
        )
    )
    sample_id = f"persona-motion-{uuid5(NAMESPACE_URL, identity_key).hex}"
    event_key = "|".join((sample_id, normalized_stage, normalized_record_key))
    event_id = f"motion-lab-{uuid5(NAMESPACE_URL, event_key).hex}"
    input_snapshot = dict(input_context)
    segment_snapshot = dict(persona_segment)
    motion_snapshot = dict(motion)
    raw = {
        "sample_schema": PERSONA_MOTION_SAMPLE_SCHEMA,
        "sample_id": sample_id,
        "record_stage": normalized_stage,
        "identity": {
            "turn_id": normalized_turn_id,
            "core_turn_id": str(core_turn_id or "").strip() or None,
            "persona_result_id": normalized_result_id or None,
            "segment_index": segment_index,
            "segment_count": segment_count,
            "segment_message_id": str(segment_message_id or "").strip() or None,
        },
        "delivery": {
            "mode": str(delivery_mode or "unknown"),
        },
        "input": input_snapshot,
        "persona_segment": segment_snapshot,
        "motion": motion_snapshot,
    }
    user_text = input_snapshot.get("user_text")
    speech = segment_snapshot.get("speech")
    return record_motion_observation(
        recorder,
        event_type="motion.persona_sample.v1",
        event_id=event_id,
        conversation_uid=normalized_turn_id,
        turn_id=normalized_turn_id,
        frontend_turn_id=normalized_turn_id,
        message_id=str(segment_message_id or "").strip() or None,
        source_route=normalized_source,
        phase=normalized_stage,
        user_text=str(user_text) if isinstance(user_text, str) else "",
        assistant_text=str(speech) if isinstance(speech, str) else "",
        payload_kind=PERSONA_MOTION_SAMPLE_SCHEMA,
        raw=raw,
    )


def record_motion_observation(
    recorder: MotionObservationPort | None,
    *,
    event_type: str,
    raw: dict[str, Any],
    event_id: str = "",
    conversation_uid: str | None = None,
    turn_id: str | None = None,
    frontend_turn_id: str | None = None,
    message_id: str | None = None,
    source_route: str = "",
    phase: str = "",
    model_name: str = "",
    profile_id: str = "",
    profile_revision: int | None = None,
    user_text: str = "",
    assistant_text: str = "",
    payload_kind: str = "",
    on_persisted: Callable[[], None] | None = None,
) -> bool:
    if recorder is None:
        return False
    event = {
        "event_type": event_type,
        "conversation_uid": conversation_uid,
        "turn_id": turn_id,
        "frontend_turn_id": frontend_turn_id,
        "message_id": message_id,
        "source_route": source_route,
        "phase": phase,
        "model_name": model_name,
        "profile_id": profile_id,
        "profile_revision": profile_revision,
        "user_text": user_text,
        "assistant_text": assistant_text,
        "payload_kind": payload_kind,
        "raw": raw,
    }
    if event_id:
        event["id"] = event_id
    try:
        return recorder.enqueue(event, on_persisted=on_persisted)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Motion observation port rejected event: %s", exc)
        return False
