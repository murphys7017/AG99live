"""Connection-owned late motion delivery for complete file-audio segments."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from astrbot.api import logger

from ..protocol.parser import build_message_envelope
from ..protocol.schema_versions import OUTPUT_SEGMENT_SCHEMA_VERSION


@dataclass
class _Delivery:
    sent: asyncio.Event
    task: asyncio.Task | None = None


class DeferredMotionDelivery:
    def __init__(self, *, send_json, is_turn_terminal) -> None:
        self._send = send_json
        self._is_terminal = is_turn_terminal
        self._entries: dict[tuple[str, str], _Delivery] = {}

    def contains(self, turn_id: str, message_id: str) -> bool:
        return (turn_id, message_id) in self._entries

    def register(
        self, turn_id: str, message_id: str,
        resolve: Callable[[], Awaitable[dict[str, Any]]],
        timeout_seconds: float = 30,
    ) -> None:
        key = (turn_id, message_id)
        if key in self._entries or self._is_terminal(turn_id):
            raise ValueError("deferred_motion_registration_invalid")
        if len(self._entries) >= 64:
            raise ValueError("deferred_motion_capacity_exceeded")
        entry = _Delivery(sent=asyncio.Event())
        self._entries[key] = entry
        entry.task = asyncio.create_task(self._deliver(key, entry, resolve, timeout_seconds))
        entry.task.add_done_callback(lambda task: None if task.cancelled() else task.exception())

    async def _deliver(self, key, entry, resolve, timeout_seconds) -> None:
        turn_id, message_id = key
        try:
            async with asyncio.timeout(min(30, max(1, timeout_seconds))):
                slot = await resolve()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Deferred motion failed: turn_id=%s message_id=%s error=%s", turn_id, message_id, exc)
            slot = {"state": "failed", "reason": "deferred_motion_generation_failed"}
        async with asyncio.timeout(30):
            await entry.sent.wait()
        if self._entries.get(key) is not entry or self._is_terminal(turn_id):
            return
        sent = await self._send(build_message_envelope(
            "output.segment_motion", source="adapter", turn_id=turn_id,
            message_id=message_id,
            payload={"schema_version": OUTPUT_SEGMENT_SCHEMA_VERSION, "motion": slot},
        ))
        if not sent:
            raise RuntimeError("deferred_motion_send_failed")

    def mark_sent(self, turn_id: str, message_id: str) -> None:
        entry = self._entries.get((turn_id, message_id))
        if entry is not None:
            entry.sent.set()

    async def drain(self, turn_id: str) -> None:
        tasks = [entry.task for key, entry in self._entries.items() if key[0] == turn_id and entry.task]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        if self._is_terminal(turn_id):
            return
        for result in results:
            if isinstance(result, BaseException):
                raise RuntimeError("deferred_motion_delivery_incomplete") from result

    def clear(self, turn_id: str | None = None) -> None:
        for key, entry in tuple(self._entries.items()):
            if turn_id is None or key[0] == turn_id:
                self._entries.pop(key)
                if entry.task is not None:
                    entry.task.cancel()
