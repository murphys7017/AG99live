"""Project one NeuroBrain reading for every motion consumer of a desktop turn."""
from __future__ import annotations

import math
from collections.abc import Mapping
from copy import deepcopy
from typing import Any

from astrbot.api import logger


_EMOTION_KEYS = (
    "joy",
    "trust",
    "fear",
    "surprise",
    "sadness",
    "disgust",
    "anger",
    "anticipation",
)
_BEHAVIOR_KEYS = (
    "engagement",
    "avoidance",
    "expression",
    "exploration",
    "initiative",
    "activation",
)


def _project_neurobrain_state(snapshot: Any) -> dict[str, Any] | None:
    if not isinstance(snapshot, Mapping):
        return None

    def unit_values(value: Any, keys: tuple[str, ...]) -> dict[str, float]:
        if not isinstance(value, Mapping):
            return {}
        result: dict[str, float] = {}
        for key in keys:
            raw = value.get(key)
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                continue
            number = float(raw)
            if math.isfinite(number):
                result[key] = max(0.0, min(1.0, number))
        return result

    emotion = unit_values(snapshot.get("emotion"), _EMOTION_KEYS)
    behavior = unit_values(snapshot.get("behavior"), _BEHAVIOR_KEYS)
    if not emotion and not behavior:
        return None
    result = {"emotion": emotion, "behavior": behavior}
    if isinstance(snapshot.get("updated_at"), str):
        result["updated_at"] = snapshot["updated_at"]
    if type(snapshot.get("revision")) is int:
        result["revision"] = snapshot["revision"]
    return result


class MotionEmotionSnapshots:
    def __init__(self, context: Any) -> None:
        self.context = context
        self._by_turn: dict[str, dict] = {}

    def read(self, turn_id: str | None = None) -> dict | None:
        if turn_id and turn_id in self._by_turn:
            return deepcopy(self._by_turn[turn_id])
        try:
            metadata = self.context.get_registered_star("astrbot_plugin_neurobrain")
            plugin = getattr(metadata, "star_cls", None)
            if not plugin or not getattr(plugin, "enabled", True):
                return None
            state = _project_neurobrain_state(plugin.readonly_api.get_state())
        except Exception as exc:
            logger.debug("Motion emotion unavailable: %s", exc)
            return None
        if turn_id and state is not None:
            if len(self._by_turn) >= 128:
                del self._by_turn[next(iter(self._by_turn))]
            self._by_turn[turn_id] = deepcopy(state)
        return state


def read_motion_emotion(state: Any, turn_id: str | None = None) -> dict | None:
    snapshots = getattr(state, "motion_emotion", None)
    if snapshots is None:
        context = getattr(state, "plugin_context", None)
        if context is None:
            return None
        snapshots = state.motion_emotion = MotionEmotionSnapshots(context)
    return snapshots.read(turn_id)
