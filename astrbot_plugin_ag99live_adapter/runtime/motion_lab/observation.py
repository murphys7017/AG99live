from __future__ import annotations

from typing import Any, Callable

from .recorder import enqueue_motion_lab_raw_event


def record_motion_lab_observation(
    runtime_state: Any,
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
    """Write one normalized Motion Lab observation through the async recorder port."""
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
    return enqueue_motion_lab_raw_event(
        runtime_state,
        event,
        on_persisted=on_persisted,
    )
