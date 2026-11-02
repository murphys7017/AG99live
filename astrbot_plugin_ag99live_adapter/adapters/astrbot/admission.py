"""Optional AstrBot admission API owned by the AstrBot adapter boundary."""

from __future__ import annotations

from typing import Any

try:
    from astrbot.core.plugin_admission import (  # type: ignore[import-not-found]
        build_plugin_admission_snapshot as _build_snapshot,
    )
except ImportError:  # AstrBot versions before runtime observation admission.
    _build_snapshot = None


async def build_plugin_admission_snapshot(*, event: Any) -> bool:
    if _build_snapshot is None:
        return False
    result = _build_snapshot(event=event)
    if hasattr(result, "__await__"):
        await result
    return True


def list_runtime_observation_sensors(context: Any, event: Any) -> list[Any]:
    list_sensors = getattr(context, "list_runtime_observation_sensors", None)
    if not callable(list_sensors):
        return []
    result = list_sensors(event)
    return list(result) if result is not None else []


__all__ = ["build_plugin_admission_snapshot", "list_runtime_observation_sensors"]
