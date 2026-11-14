"""AG99live-owned desktop frame producer.

The Adapter schedules capture and submits results to the Core SnapshotHub.
Observation consumers read the Core projection and its frame attachment.
"""

from __future__ import annotations

import asyncio
import math
from typing import Any

from astrbot.api import logger

from .plugin_runtime import get_plugin_config_snapshot, reconcile_control_platforms


def _bounded_interval(settings: dict[str, Any]) -> float:
    value = float(settings.get("interval_seconds", 30) or 30)
    if not math.isfinite(value):
        raise ValueError("desktop_capture_interval_invalid")
    return max(10.0, min(3600.0, value))


class DesktopCaptureRuntime:
    """Maintain the latest desktop frame for connected AG99live clients."""

    def __init__(self, context: Any) -> None:
        self.context = context
        self._task: asyncio.Task | None = None
        self._workers: dict[str, tuple[object, tuple[Any, ...], asyncio.Task]] = {}

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(
                self._run(), name="ag99live.desktop_capture"
            )

    async def stop(self) -> None:
        tasks = [worker[2] for worker in self._workers.values()]
        if self._task is not None:
            tasks.append(self._task)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._task = None
        self._workers.clear()

    async def _run(self) -> None:
        while True:
            try:
                settings = get_plugin_config_snapshot().config.get(
                    "desktop_observation", {}
                )
                enabled = isinstance(settings, dict) and bool(
                    settings.get("enabled", False)
                )
                interval = _bounded_interval(settings if isinstance(settings, dict) else {})
                active = {
                    platform.platform_id: platform
                    for platform in reconcile_control_platforms(self.context)
                    if enabled
                    and platform.desktop_observation.supported
                    and platform.transport._ws_client is not None
                }
                for key, (owner, previous, task) in list(self._workers.items()):
                    current = (
                        interval,
                        owner.desktop_observation.generation,
                        owner.client_uid,
                    )
                    if (
                        active.get(key) is not owner
                        or previous != current
                        or task.done()
                    ):
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                        del self._workers[key]
                for key, platform in active.items():
                    if key in self._workers:
                        continue
                    signature = (
                        interval,
                        platform.desktop_observation.generation,
                        platform.client_uid,
                    )
                    task = asyncio.create_task(
                        self._capture(platform, interval),
                        name=f"ag99live.desktop_capture:{key}",
                    )
                    self._workers[key] = (platform, signature, task)
            except Exception as exc:
                logger.warning(
                    "Desktop capture scheduler failed: %s", type(exc).__name__
                )
                for _, _, task in self._workers.values():
                    task.cancel()
                await asyncio.gather(
                    *(worker[2] for worker in self._workers.values()),
                    return_exceptions=True,
                )
                self._workers.clear()
            await asyncio.sleep(2)

    async def _capture(self, platform: Any, interval: float) -> None:
        broker = platform.desktop_observation
        while True:
            try:
                await broker.capture()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.debug(
                    "Desktop frame capture unavailable platform=%s error=%s",
                    platform.platform_id,
                    type(exc).__name__,
                )
            await asyncio.sleep(interval)


__all__ = ["DesktopCaptureRuntime"]
