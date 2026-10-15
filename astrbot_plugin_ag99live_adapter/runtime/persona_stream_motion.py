"""Own cross-task Persona motion work outside request-local event extras."""

from __future__ import annotations

import asyncio
from typing import Any


class PersonaStreamMotionRegistry:
    def __init__(self) -> None:
        self._works: dict[str, dict[str, Any]] = {}

    def get(self, turn_id: str) -> dict[str, Any] | None:
        return self._works.get(turn_id)

    def register(self, turn_id: str, work: dict[str, Any]) -> None:
        if turn_id in self._works:
            raise RuntimeError("persona_stream_motion_work_already_registered")
        self._works[turn_id] = work

    def reset(self) -> None:
        for turn_id in tuple(self._works):
            self.clear(turn_id)

    def clear(
        self,
        turn_id: str,
        *,
        persona_result_id: str | None = None,
        parent_message_id: str | None = None,
    ) -> None:
        work = self._works.get(turn_id)
        if work is None or (
            persona_result_id is not None
            and work.get("persona_result_id") != persona_result_id
        ) or (
            parent_message_id is not None
            and work.get("parent_message_id") != parent_message_id
        ):
            return
        self._works.pop(turn_id)
        tasks = set(work.get("tasks", ()))
        tasks.add(work.get("context_task"))
        for task in tasks:
            if isinstance(task, asyncio.Task) and not task.done():
                task.cancel()
        for future in work.get("segment_result_futures", {}).values():
            if isinstance(future, asyncio.Future) and not future.done():
                future.cancel()

