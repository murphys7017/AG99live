"""Connection-owned late motion delivery for complete file-audio segments."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from astrbot.api import logger

from ..protocol.parser import build_message_envelope
from ..protocol.schema_versions import OUTPUT_SEGMENT_SCHEMA_VERSION

_DEFERRED_MOTION_MAX_ENTRIES = 64
_DEFERRED_MOTION_SEND_MAX_ATTEMPTS = 4
_DEFERRED_MOTION_SEND_INITIAL_RETRY_SECONDS = 0.25
_DEFERRED_MOTION_SEND_MAX_RETRY_SECONDS = 2.0
_DEFERRED_MOTION_SEND_WINDOW_SECONDS = 30.0


@dataclass
class _Delivery:
    sent: asyncio.Event
    ready: asyncio.Event
    task: asyncio.Task | None = None
    slot: dict[str, Any] | None = None
    inline: bool = False


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
    ) -> bool:
        key = (turn_id, message_id)
        if key in self._entries or self._is_terminal(turn_id):
            raise ValueError("deferred_motion_registration_invalid")
        if len(self._entries) >= _DEFERRED_MOTION_MAX_ENTRIES:
            logger.warning(
                "Deferred motion registration degraded: capacity exceeded "
                "turn_id=%s message_id=%s capacity=%s",
                turn_id,
                message_id,
                _DEFERRED_MOTION_MAX_ENTRIES,
            )
            return False
        entry = _Delivery(sent=asyncio.Event(), ready=asyncio.Event())
        self._entries[key] = entry
        entry.task = asyncio.create_task(self._deliver(key, entry, resolve, timeout_seconds))
        entry.task.add_done_callback(lambda task: None if task.cancelled() else task.exception())
        return True

    async def _deliver(self, key, entry, resolve, timeout_seconds) -> None:
        turn_id, message_id = key
        try:
            async with asyncio.timeout(
                min(_DEFERRED_MOTION_SEND_WINDOW_SECONDS, max(1, timeout_seconds))
            ):
                slot = await resolve()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Deferred motion failed: turn_id=%s message_id=%s error=%s", turn_id, message_id, exc)
            slot = {"state": "failed", "reason": "deferred_motion_generation_failed"}
        entry.slot = slot
        entry.ready.set()
        try:
            deadline = asyncio.get_running_loop().time() + _DEFERRED_MOTION_SEND_WINDOW_SECONDS
            while not entry.sent.is_set():
                if self._is_terminal(turn_id):
                    return
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    logger.info(
                        "Deferred motion send window expired before segment delivery: "
                        "turn_id=%s message_id=%s",
                        turn_id,
                        message_id,
                    )
                    return
                try:
                    await asyncio.wait_for(
                        asyncio.shield(entry.sent.wait()),
                        timeout=min(0.25, remaining),
                    )
                except asyncio.TimeoutError:
                    continue
            if self._entries.get(key) is not entry or self._is_terminal(turn_id):
                return
            if entry.inline:
                return
            await self._send_with_retry(
                key,
                entry,
                slot,
                deadline=deadline,
            )
        finally:
            if self._entries.get(key) is entry:
                self._entries.pop(key, None)

    async def _send_with_retry(
        self,
        key: tuple[str, str],
        entry: _Delivery,
        slot: dict[str, Any],
        *,
        deadline: float,
    ) -> bool:
        turn_id, message_id = key
        retry_delay = _DEFERRED_MOTION_SEND_INITIAL_RETRY_SECONDS
        payload = build_message_envelope(
            "output.segment_motion", source="adapter", turn_id=turn_id,
            message_id=message_id,
            payload={"schema_version": OUTPUT_SEGMENT_SCHEMA_VERSION, "motion": slot},
        )
        for attempt in range(1, _DEFERRED_MOTION_SEND_MAX_ATTEMPTS + 1):
            if self._entries.get(key) is not entry or self._is_terminal(turn_id):
                return False
            try:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    break
                if await asyncio.wait_for(self._send(payload), timeout=remaining):
                    if attempt > 1:
                        logger.info(
                            "Deferred motion delivery recovered after retry: "
                            "turn_id=%s message_id=%s attempt=%s",
                            turn_id,
                            message_id,
                            attempt,
                        )
                    return True
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Deferred motion send raised: turn_id=%s message_id=%s "
                    "attempt=%s error=%s",
                    turn_id,
                    message_id,
                    attempt,
                    exc,
                )
            if attempt >= _DEFERRED_MOTION_SEND_MAX_ATTEMPTS:
                break
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            await asyncio.sleep(min(retry_delay, remaining))
            retry_delay = min(
                retry_delay * 2,
                _DEFERRED_MOTION_SEND_MAX_RETRY_SECONDS,
            )
        logger.warning(
            "Deferred motion delivery exhausted retries: turn_id=%s "
            "message_id=%s attempts=%s",
            turn_id,
            message_id,
            _DEFERRED_MOTION_SEND_MAX_ATTEMPTS,
        )
        return False

    def mark_sent(self, turn_id: str, message_id: str) -> None:
        entry = self._entries.get((turn_id, message_id))
        if entry is not None:
            entry.sent.set()

    async def wait_ready(
        self,
        turn_id: str,
        message_id: str,
        *,
        timeout_seconds: float,
    ) -> dict[str, Any] | None:
        entry = self._entries.get((turn_id, message_id))
        if entry is None:
            return None
        try:
            await asyncio.wait_for(
                asyncio.shield(entry.ready.wait()),
                timeout=max(0.0, timeout_seconds),
            )
        except asyncio.TimeoutError:
            return None
        return dict(entry.slot) if isinstance(entry.slot, dict) else None

    def mark_inline(self, turn_id: str, message_id: str) -> None:
        entry = self._entries.get((turn_id, message_id))
        if entry is not None:
            entry.inline = True

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
