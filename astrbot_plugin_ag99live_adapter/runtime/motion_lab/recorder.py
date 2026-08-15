from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from math import isfinite
from typing import Any, Callable
from uuid import uuid4

from astrbot.api import logger

from .raw_event_store import MotionLabRawEventStore


class MotionLabRecorder:
    """Asynchronously persists raw events without hiding persistence failures."""

    def __init__(
        self,
        *,
        store: MotionLabRawEventStore,
        batch_size: int = 20,
        max_queue_size: int = 500,
        max_retry_attempts: int = 5,
    ) -> None:
        self._store = store
        self._queue: asyncio.Queue[
            tuple[dict[str, Any], Callable[[], None] | None]
        ] = asyncio.Queue(maxsize=max(1, max_queue_size))
        self._batch_size = max(1, batch_size)
        self._max_retry_attempts = max(1, max_retry_attempts)
        self._worker_task: asyncio.Task[None] | None = None
        self._closed = False
        self._healthy = True
        self._failure_reason = ""

    def enqueue(
        self,
        event: dict[str, Any],
        *,
        on_persisted: Callable[[], None] | None = None,
    ) -> bool:
        if self._closed or not self._healthy:
            logger.error(
                "MotionLab raw event rejected: recorder is unavailable (%s).",
                self._failure_reason or "closed",
            )
            return False
        if not self._ensure_worker():
            logger.error("MotionLab raw event rejected: no running event loop.")
            return False
        snapshot = _normalize_event(event)
        try:
            self._queue.put_nowait((snapshot, on_persisted))
        except asyncio.QueueFull:
            logger.error(
                "MotionLab raw event rejected: recorder queue is full (%s events).",
                self._queue.maxsize,
            )
            return False
        return True

    def get_turn_context(
        self,
        *,
        turn_id: str,
        message_id: str,
    ) -> dict[str, str] | None:
        return self._store.get_turn_context(
            turn_id=turn_id,
            message_id=message_id,
        )

    def _ensure_worker(self) -> bool:
        task = self._worker_task
        if task is not None and not task.done():
            return True
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return False
        self._worker_task = loop.create_task(self._run_worker())
        return True

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
            persisted = False
            for attempt in range(1, self._max_retry_attempts + 1):
                try:
                    await asyncio.to_thread(
                        self._store.insert_events,
                        [event for event, _callback in batch],
                    )
                    persisted = True
                    break
                except Exception as exc:  # noqa: BLE001
                    if attempt == self._max_retry_attempts:
                        logger.exception(
                            "MotionLab raw event write failed after %s attempts",
                            attempt,
                        )
                        self._mark_unhealthy(
                            f"database_write_failed_after_{attempt}_attempts:{exc}"
                        )
                        break
                    logger.warning(
                        "MotionLab raw event write failed (%s/%s); retrying in %.1fs: %s",
                        attempt,
                        self._max_retry_attempts,
                        retry_delay_seconds,
                        exc,
                    )
                    await asyncio.sleep(retry_delay_seconds)
                    retry_delay_seconds = min(retry_delay_seconds * 2, 5.0)
            if not persisted:
                for _event, _callback in batch:
                    self._queue.task_done()
                self._discard_queued_events_after_failure()
                return
            for _event, callback in batch:
                if callback is not None:
                    try:
                        callback()
                    except Exception as exc:  # noqa: BLE001
                        logger.exception("MotionLab persistence callback failed: %s", exc)
                self._queue.task_done()

    def _mark_unhealthy(self, reason: str) -> None:
        self._healthy = False
        self._failure_reason = reason
        logger.error("MotionLab recorder became unhealthy: %s", reason)

    def _discard_queued_events_after_failure(self) -> None:
        discarded_count = 0
        while True:
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                if discarded_count:
                    logger.error(
                        "MotionLab discarded %s queued events after recorder failure.",
                        discarded_count,
                    )
                return
            self._queue.task_done()
            discarded_count += 1

    async def close(self, *, timeout_seconds: float = 5.0) -> None:
        if self._closed:
            return
        self._closed = True
        if not self._healthy:
            raise RuntimeError(f"MotionLab recorder is unhealthy: {self._failure_reason}")
        if not self._queue.empty() and not self._ensure_worker():
            raise RuntimeError("MotionLab recorder close requires a running event loop.")
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
