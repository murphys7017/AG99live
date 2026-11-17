"""AG99live-owned desktop presence producer."""

from __future__ import annotations

import asyncio
import math
from time import monotonic
from typing import Any
from uuid import uuid4

from astrbot.api import logger

from .plugin_runtime import get_plugin_config_snapshot, reconcile_control_platforms


def _bounded_number(
    settings: dict[str, Any],
    key: str,
    default: float,
    minimum: float,
    maximum: float,
    *,
    integer: bool = False,
) -> int | float:
    raw = settings.get(key, default)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = default
    if not math.isfinite(value):
        value = default
    value = min(max(value, minimum), maximum)
    return int(value) if integer else value


def _presence_settings(config: dict[str, Any]) -> tuple[dict[str, int], float, bool]:
    enabled = bool(config.get("enabled", False))
    settings = {
        "idle_after_seconds": _bounded_number(
            config, "idle_after_seconds", 300, 30, 3600, integer=True
        ),
        "minimum_away_seconds": _bounded_number(
            config, "minimum_away_seconds", 60, 10, 3600, integer=True
        ),
        "confirmation_seconds": _bounded_number(
            config, "confirmation_seconds", 3, 3, 10, integer=True
        ),
    }
    interval = float(_bounded_number(config, "poll_interval_seconds", 1, 1, 10))
    return settings, interval, enabled


class DesktopPresenceCaptureRuntime:
    """Poll frontend Presence and publish it through DesktopStateStore."""

    def __init__(self, context: Any) -> None:
        self.context = context
        self._task: asyncio.Task | None = None
        self._workers: dict[str, tuple[object, tuple[Any, ...], asyncio.Task]] = {}
        self._last_scheduler_error: tuple[Any, ...] | None = None
        self._last_scheduler_error_at = 0.0
        self._incomplete_platforms: dict[str, tuple[str, ...]] = {}

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(
                self._run(), name="ag99live.desktop_presence_capture"
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
        self._incomplete_platforms.clear()

    async def _run(self) -> None:
        while True:
            stage = "config"
            platform_id = "<none>"
            try:
                raw_config = get_plugin_config_snapshot().config.get(
                    "desktop_presence_capture", {}
                )
                config = raw_config if isinstance(raw_config, dict) else {}
                settings, interval, enabled = _presence_settings(config)
                active: dict[str, Any] = {}
                if enabled:
                    stage = "platform_discovery"
                    for platform in reconcile_control_platforms(self.context):
                        platform_id = str(
                            getattr(platform, "platform_id", "") or ""
                        ).strip()
                        presence = getattr(platform, "desktop_presence", None)
                        transport = getattr(platform, "transport", None)
                        missing = tuple(
                            name
                            for name, valid in (
                                ("platform_id", bool(platform_id)),
                                ("desktop_presence", presence is not None),
                                (
                                    "desktop_presence.supported",
                                    hasattr(presence, "supported"),
                                ),
                                (
                                    "desktop_presence.generation",
                                    hasattr(presence, "generation"),
                                ),
                                (
                                    "desktop_presence.read",
                                    callable(getattr(presence, "read", None)),
                                ),
                                (
                                    "transport._ws_client",
                                    hasattr(transport, "_ws_client"),
                                ),
                                ("client_uid", hasattr(platform, "client_uid")),
                            )
                            if not valid
                        )
                        if missing:
                            if self._incomplete_platforms.get(platform_id) != missing:
                                logger.warning(
                                    "Desktop presence platform contract incomplete: "
                                    "platform=%s type=%s missing=%s; presence capture is inactive",
                                    platform_id,
                                    type(platform).__qualname__,
                                    ",".join(missing),
                                )
                            self._incomplete_platforms[platform_id] = missing
                            continue
                        if (
                            self._incomplete_platforms.pop(platform_id, None)
                            is not None
                        ):
                            logger.info(
                                "Desktop presence platform contract recovered: platform=%s",
                                platform_id,
                            )
                        if (
                            not platform_id
                            or presence is None
                            or not bool(getattr(presence, "supported", False))
                            or getattr(transport, "_ws_client", None) is None
                        ):
                            continue
                        active[platform_id] = platform
                signature_tail = (
                    interval,
                    tuple(settings.items()),
                )
                stage = "worker_reconciliation"
                for key, (owner, previous, task) in list(self._workers.items()):
                    owner_presence = getattr(owner, "desktop_presence", None)
                    current = (
                        *signature_tail,
                        getattr(owner_presence, "generation", None),
                        str(getattr(owner, "client_uid", "") or ""),
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
                        *signature_tail,
                        getattr(
                            getattr(platform, "desktop_presence", None),
                            "generation",
                            None,
                        ),
                        str(getattr(platform, "client_uid", "") or ""),
                    )
                    task = asyncio.create_task(
                        self._poll(platform, settings, interval),
                        name=f"ag99live.desktop_presence_capture:{key}",
                    )
                    self._workers[key] = (platform, signature, task)
                    logger.debug(
                        "Desktop presence polling started: platform=%s interval=%s",
                        key,
                        interval,
                    )
                self._last_scheduler_error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - isolate scheduler failures and retain their traceback.
                error = (
                    stage,
                    platform_id,
                    type(exc).__name__,
                    getattr(exc, "name", None),
                )
                now = monotonic()
                if (
                    error != self._last_scheduler_error
                    or now - self._last_scheduler_error_at >= 60
                ):
                    logger.warning(
                        "Desktop presence capture scheduler failed: stage=%s platform=%s "
                        "error=%s attribute=%s object_type=%s",
                        stage,
                        platform_id,
                        type(exc).__name__,
                        getattr(exc, "name", None),
                        type(getattr(exc, "obj", None)).__qualname__,
                        exc_info=True,
                    )
                    self._last_scheduler_error = error
                    self._last_scheduler_error_at = now
                for _, _, task in self._workers.values():
                    task.cancel()
                await asyncio.gather(
                    *(worker[2] for worker in self._workers.values()),
                    return_exceptions=True,
                )
                self._workers.clear()
            await asyncio.sleep(2)

    async def _poll(
        self,
        platform: Any,
        settings: dict[str, int],
        interval: float,
    ) -> None:
        broker = platform.desktop_presence
        monitor_id = uuid4().hex
        last_error = None
        last_error_at = 0.0
        while True:
            try:
                await broker.read(monitor_id, settings)
                if last_error is not None:
                    logger.debug(
                        "Desktop presence capture recovered: platform=%s",
                        platform.platform_id,
                    )
                last_error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - frontend failures must not terminate the polling worker.
                error = (type(exc).__name__, getattr(exc, "name", None))
                now = monotonic()
                if error != last_error or now - last_error_at >= 60:
                    logger.warning(
                        "Desktop presence capture unavailable platform=%s error=%s attribute=%s",
                        platform.platform_id,
                        type(exc).__name__,
                        getattr(exc, "name", None),
                        exc_info=True,
                    )
                    last_error = error
                    last_error_at = now
            await asyncio.sleep(interval)


__all__ = ["DesktopPresenceCaptureRuntime"]
