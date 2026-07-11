from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from math import isfinite
from typing import Any, Callable
from uuid import uuid4

from astrbot.api import logger

from .raw_event_store import MotionLabRawEventStore


class MotionLabRecorder:
    """Asynchronous raw event recorder that drains accepted events on close."""

    def __init__(
        self,
        *,
        store: MotionLabRawEventStore,
        batch_size: int = 20,
    ) -> None:
        self._store = store
        self._queue: asyncio.Queue[
            tuple[dict[str, Any], Callable[[], None] | None]
        ] = asyncio.Queue()
        self._batch_size = max(1, batch_size)
        self._worker_task: asyncio.Task[None] | None = None
        self._closed = False

    def enqueue(
        self,
        event: dict[str, Any],
        *,
        on_persisted: Callable[[], None] | None = None,
    ) -> bool:
        if self._closed:
            logger.error("MotionLab raw event rejected after recorder close.")
            return False
        snapshot = _normalize_event(event)
        self._queue.put_nowait((snapshot, on_persisted))
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
            retry_delay_seconds = 0.1
            while True:
                try:
                    await asyncio.to_thread(
                        self._store.insert_events,
                        [event for event, _callback in batch],
                    )
                    break
                except Exception as exc:  # noqa: BLE001
                    logger.error(
                        "MotionLab raw event write failed; retrying in %.1fs: %s",
                        retry_delay_seconds,
                        exc,
                    )
                    await asyncio.sleep(retry_delay_seconds)
                    retry_delay_seconds = min(retry_delay_seconds * 2, 5.0)
            for _event, callback in batch:
                if callback is not None:
                    try:
                        callback()
                    except Exception as exc:  # noqa: BLE001
                        logger.error("MotionLab persistence callback failed: %s", exc)
                self._queue.task_done()

    async def close(self, *, timeout_seconds: float = 5.0) -> None:
        if self._closed:
            return
        self._closed = True
        if not self._queue.empty():
            self._ensure_worker()
        task = self._worker_task
        try:
            await asyncio.wait_for(
                self._queue.join(),
                timeout=max(float(timeout_seconds), 0.1),
            )
        except TimeoutError:
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            self._worker_task = None
            raise RuntimeError(
                f"MotionLab recorder close timed out with {self._queue.qsize()} queued events."
            ) from None
        self._worker_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


def enqueue_motion_lab_raw_event(
    runtime_state: Any,
    event: dict[str, Any],
    *,
    on_persisted: Callable[[], None] | None = None,
) -> bool:
    recorder = getattr(runtime_state, "motion_lab_recorder", None)
    if not isinstance(recorder, MotionLabRecorder):
        return False
    try:
        return recorder.enqueue(event, on_persisted=on_persisted)
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
