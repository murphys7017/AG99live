from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

AG99LIVE_PLUGIN_ID = "astrbot_plugin_ag99live_adapter"
AG99LIVE_MOTION_EFFECT_NAME = "ag99live.motion"
INTERACTION_ROUTE_DECISION_EXTRA_KEY = "_interaction_route_decision"

@dataclass(slots=True)
class _MotionRuntimeBundle:
    adapter: Any
    turn_coordinator: Any
    runtime_state: Any

@dataclass(slots=True)
class _FrontendIdentitySnapshot:
    event_frontend_turn_id: str | None

    @property
    def scheduled_frontend_turn_id(self) -> str | None:
        return self.event_frontend_turn_id

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

def _sanitize_reason_fragment(value: Any) -> str:
    fragment = re.sub(r"[^0-9A-Za-z_.:-]+", "_", str(value or "").strip())
    return fragment[:80] or "unknown"

def _resolve_result_phase(view: Any) -> str:
    metadata = getattr(view, "metadata", None)
    if isinstance(metadata, Mapping):
        return str(metadata.get("phase") or "").strip()
    getter = getattr(metadata, "get", None)
    if callable(getter):
        return str(getter("phase") or "").strip()
    return ""

def _resolve_frontend_identity_snapshot(
    event: Any,
) -> _FrontendIdentitySnapshot:
    raw_message = getattr(getattr(event, "message_obj", None), "raw_message", None)
    event_frontend_turn_id = None
    if isinstance(raw_message, dict):
        event_frontend_turn_id = _normalize_optional_string(raw_message.get("turn_id"))
    return _FrontendIdentitySnapshot(
        event_frontend_turn_id=event_frontend_turn_id,
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
