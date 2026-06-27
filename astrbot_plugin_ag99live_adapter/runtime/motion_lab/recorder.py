from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from math import isfinite
from typing import Any
from uuid import uuid4

from astrbot.api import logger

from .raw_event_store import MotionLabRawEventStore


class MotionLabRecorder:
    """Asynchronous, best-effort raw event recorder for motion lab data."""

    def __init__(
        self,
        *,
        store: MotionLabRawEventStore,
        queue_size: int = 1000,
        batch_size: int = 20,
    ) -> None:
        self._store = store
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=max(1, queue_size))
        self._batch_size = max(1, batch_size)
        self._worker_task: asyncio.Task[None] | None = None
        self.dropped_count = 0

    def enqueue(self, event: dict[str, Any]) -> bool:
        snapshot = _normalize_event(event)
        try:
            self._queue.put_nowait(snapshot)
        except asyncio.QueueFull:
            self.dropped_count += 1
            if self.dropped_count == 1 or self.dropped_count % 100 == 0:
                logger.warning(
                    "MotionLab raw event queue full; dropped_count=%s",
                    self.dropped_count,
                )
            return False
        self._ensure_worker()
        return True

    def _ensure_worker(self) -> None:
        task = self._worker_task
        if task is not None and not task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._worker_task = loop.create_task(self._run_worker())

    async def _run_worker(self) -> None:
        while True:
            first = await self._queue.get()
            batch = [first]
            for _ in range(self._batch_size - 1):
                try:
                    batch.append(self._queue.get_nowait())
                except asyncio.QueueEmpty:
                    break
            try:
                await asyncio.to_thread(self._store.insert_events, batch)
            except Exception as exc:  # noqa: BLE001
                logger.warning("MotionLab raw event write failed: %s", exc)
            finally:
                for _event in batch:
                    self._queue.task_done()


def enqueue_motion_lab_raw_event(runtime_state: Any, event: dict[str, Any]) -> bool:
    recorder = getattr(runtime_state, "motion_lab_recorder", None)
    if not isinstance(recorder, MotionLabRecorder):
        return False
    try:
        return recorder.enqueue(event)
    except Exception as exc:  # noqa: BLE001
        logger.warning("MotionLab raw event enqueue failed: %s", exc)
        return False


def _normalize_event(event: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    normalized = _json_safe_snapshot(event)
    snapshot = normalized if isinstance(normalized, dict) else {}
    snapshot["id"] = str(snapshot.get("id") or f"motion-lab-{uuid4().hex}")
    snapshot["created_at"] = str(snapshot.get("created_at") or now)
    snapshot["event_type"] = str(snapshot.get("event_type") or "motion.unknown").strip()
    raw = snapshot.get("raw")
    snapshot["raw"] = raw if isinstance(raw, dict) else {"value": raw}
    return snapshot


def _json_safe_snapshot(value: Any, *, _seen: set[int] | None = None) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if isfinite(value) else str(value)

    seen = _seen if _seen is not None else set()
    value_id = id(value)
    if value_id in seen:
        return "<cycle>"

    if isinstance(value, dict):
        seen.add(value_id)
        try:
            return {
                str(key): _json_safe_snapshot(item, _seen=seen)
                for key, item in value.items()
            }
        finally:
            seen.discard(value_id)

    if isinstance(value, (list, tuple, set)):
        seen.add(value_id)
        try:
            return [_json_safe_snapshot(item, _seen=seen) for item in value]
        finally:
            seen.discard(value_id)

    return str(value)
