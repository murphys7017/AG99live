"""Adapter-owned event context with a narrow AstrBot extra boundary."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

_KNOWN_EXTRA_KEYS = (
    "_interaction_plugin_runtime_target_overrides",
    "_interaction_persona_segment_stream_requested",
    "_interaction_incremental_output_requested",
    "_interaction_wait_for_motion_execution_ack",
    "_interaction_incremental_motion_states",
    "_interaction_persona_segment_stream_active",
    "_ag99live_pending_performance_curve",
    "_ag99live_persona_motion_source_route",
    "_turn_id",
    "output_correlation_id",
    "agent_stop_requested",
    "ag99live_raw_reply_text",
)


@dataclass(slots=True)
class AdapterEventContext:
    """Mutable Adapter state mirrored to AstrBot extras only at the boundary."""

    plugin_runtime_target_overrides: dict[str, str] = field(default_factory=dict)
    persona_segment_stream_requested: bool = False
    incremental_output_requested: bool = False
    wait_for_motion_execution_ack: bool = False
    incremental_motion_states: dict[str, Any] = field(default_factory=dict)
    persona_segment_stream_active: bool = False
    pending_performance_curve: dict[str, Any] | None = None
    persona_motion_source_route: str | None = None
    core_turn_id: str = ""
    delivery_turn_id: str = ""
    agent_stop_requested: bool = False
    raw_reply_text: str = ""

    def observe_extra(self, key: str, value: Any) -> None:
        if key == "_interaction_plugin_runtime_target_overrides":
            self.plugin_runtime_target_overrides = (
                dict(value) if isinstance(value, dict) else {}
            )
        elif key == "_interaction_persona_segment_stream_requested":
            self.persona_segment_stream_requested = value is True
        elif key == "_interaction_incremental_output_requested":
            self.incremental_output_requested = value is True
        elif key == "_interaction_wait_for_motion_execution_ack":
            self.wait_for_motion_execution_ack = value is True
        elif key == "_interaction_incremental_motion_states":
            self.incremental_motion_states = (
                dict(value) if isinstance(value, dict) else {}
            )
        elif key == "_interaction_persona_segment_stream_active":
            self.persona_segment_stream_active = value is True
        elif key == "_ag99live_pending_performance_curve":
            self.pending_performance_curve = (
                dict(value) if isinstance(value, dict) else None
            )
        elif key == "_ag99live_persona_motion_source_route":
            normalized = str(value or "").strip()
            self.persona_motion_source_route = normalized or None
        elif key == "_turn_id":
            self.core_turn_id = str(value or "").strip()
        elif key == "output_correlation_id":
            self.delivery_turn_id = str(value or "").strip()
        elif key == "agent_stop_requested":
            self.agent_stop_requested = value is True
        elif key == "ag99live_raw_reply_text":
            self.raw_reply_text = str(value or "")

    def mirror_extra(self, event: Any, key: str, value: Any) -> None:
        self.observe_extra(key, value)
        setter = getattr(event, "set_extra", None)
        if callable(setter):
            setter(key, value)

    def set_pending_performance_curve(
        self,
        event: Any,
        value: dict[str, Any] | None,
    ) -> None:
        self.mirror_extra(event, "_ag99live_pending_performance_curve", value)

    def set_raw_reply_text(self, event: Any, value: Any) -> None:
        self.mirror_extra(event, "ag99live_raw_reply_text", value)

    def set_persona_motion_source_route(self, event: Any, value: str) -> None:
        self.mirror_extra(event, "_ag99live_persona_motion_source_route", value)

    def set_turn_identity(
        self,
        event: Any,
        *,
        core_turn_id: str,
        delivery_turn_id: str,
    ) -> None:
        self.mirror_extra(event, "_turn_id", core_turn_id)
        self.mirror_extra(event, "output_correlation_id", delivery_turn_id)

    def set_agent_stop_requested(self, event: Any, value: bool = True) -> None:
        self.mirror_extra(event, "agent_stop_requested", value is True)


def resolve_adapter_event_context(event: Any) -> AdapterEventContext:
    """Return the Adapter context, refreshing it from legacy extras."""

    context = getattr(event, "_adapter_internal_state", None)
    if isinstance(context, AdapterEventContext):
        return context

    context = getattr(event, "_adapter_event_context", None)
    if not isinstance(context, AdapterEventContext):
        context = AdapterEventContext()
        setattr(event, "_adapter_event_context", context)

    getter = getattr(event, "get_extra", None)
    if callable(getter):
        missing = object()
        for key in _KNOWN_EXTRA_KEYS:
            try:
                value = getter(key, missing)
            except TypeError:
                value = getter(key)
            if value is not missing:
                context.observe_extra(key, value)
    return context


__all__ = ["AdapterEventContext", "resolve_adapter_event_context"]
