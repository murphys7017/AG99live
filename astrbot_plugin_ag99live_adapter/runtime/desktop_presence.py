"""Desktop return facts feed the existing Personal Policy and Persona pipeline."""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from time import perf_counter
from typing import Any
from uuid import uuid4

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent
from astrbot.core.plugin_admission import build_plugin_admission_snapshot

from ..protocol.desktop_presence import SCHEMA, REQUEST_TYPE, validate_presence_result
from ..protocol.parser import build_message_envelope
from .plugin_runtime import get_plugin_config_snapshot, reconcile_control_platforms


@dataclass(frozen=True)
class DesktopReturnSensor:
    plugin_id: str = "ag99live"
    source_id: str = "desktop_return"


class DesktopPresenceBroker:
    def __init__(self, send_json: Any) -> None:
        self._send_json = send_json
        self._pending: tuple[str, asyncio.Future] | None = None
        self.generation = 0
        self.supported = False

    def disconnect(self) -> None:
        self.generation += 1
        self.supported = False
        if self._pending is not None:
            self._pending[1].cancel()
            self._pending = None

    async def read(self, monitor_id: str, settings: dict) -> dict:
        if not self.supported or self._pending is not None:
            raise RuntimeError("desktop_presence_unavailable")
        request_id = uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self._pending = (request_id, future)
        try:
            async with asyncio.timeout(5):
                sent = await self._send_json(
                    build_message_envelope(
                        REQUEST_TYPE,
                        source="adapter",
                        payload={
                            "schema_version": SCHEMA,
                            "request_id": request_id,
                            "monitor_id": monitor_id,
                            "settings": settings,
                        },
                    )
                )
                if not sent:
                    raise RuntimeError("desktop_presence_send_failed")
                return await future
        finally:
            if self._pending is not None and self._pending[0] == request_id:
                self._pending = None
            if not future.done():
                future.cancel()

    def resolve(self, payload: dict) -> None:
        validate_presence_result(payload)
        if self._pending is None or self._pending[0] != payload["request_id"]:
            return
        future = self._pending[1]
        if not future.done():
            if payload["ok"]:
                future.set_result(payload["snapshot"])
            else:
                future.set_exception(RuntimeError(payload["error"]))


def _setting(settings: dict, key: str, default: int, low: int, high: int) -> int:
    value = float(settings.get(key, default))
    if not math.isfinite(value):
        raise ValueError(f"desktop_return_{key}_invalid")
    return int(max(low, min(high, value)))


class DesktopPresenceRuntime:
    def __init__(self, context: Any) -> None:
        self.context = context
        self.handle = context.register_runtime_observation_sensor(DesktopReturnSensor())
        self._task: asyncio.Task | None = None
        self._workers: dict[str, tuple[object, tuple, asyncio.Task]] = {}
        self._last_attempt: dict[tuple[str, str], float] = {}
        self._monitor_ids: dict[tuple[str, str], tuple[tuple, str]] = {}

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(
                self._run(), name="ag99live.desktop_return"
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
                config = get_plugin_config_snapshot().config.get("desktop_return", {})
                settings = {
                    "idle_after_seconds": _setting(
                        config, "idle_after_seconds", 300, 30, 3600
                    ),
                    "minimum_away_seconds": _setting(
                        config, "minimum_away_seconds", 60, 10, 3600
                    ),
                    "confirmation_seconds": _setting(
                        config, "confirmation_seconds", 3, 3, 10
                    ),
                }
                cooldown = _setting(config, "cooldown_seconds", 900, 0, 86400)
                signature = (*settings.values(), cooldown)
                if config.get("enabled", False) is not True:
                    self._monitor_ids.clear()
                active = {
                    p.platform_id: p
                    for p in reconcile_control_platforms(self.context)
                    if config.get("enabled", False) is True
                    and p.desktop_presence.supported
                    and p.transport._ws_client is not None
                }
                for key, (owner, previous, task) in list(self._workers.items()):
                    current = (
                        signature,
                        owner.desktop_presence.generation,
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
                    if key not in self._workers:
                        monitor_key = (key, platform.client_uid)
                        previous_monitor = self._monitor_ids.get(monitor_key)
                        if previous_monitor is None or previous_monitor[0] != signature:
                            self._monitor_ids[monitor_key] = (signature, uuid4().hex)
                        task = asyncio.create_task(
                            self._observe(
                                platform,
                                settings,
                                cooldown,
                                self._monitor_ids[monitor_key][1],
                            )
                        )
                        self._workers[key] = (
                            platform,
                            (
                                signature,
                                platform.desktop_presence.generation,
                                platform.client_uid,
                            ),
                            task,
                        )
            except Exception as exc:
                logger.warning(
                    "Desktop return scheduler failed: %s", type(exc).__name__
                )
                for _, _, task in self._workers.values():
                    task.cancel()
                await asyncio.gather(
                    *(w[2] for w in self._workers.values()), return_exceptions=True
                )
                self._workers.clear()
            await asyncio.sleep(1)

    async def _observe(
        self, platform: Any, settings: dict, cooldown: int, monitor_id: str
    ) -> None:
        broker = platform.desktop_presence
        generation, client_uid = broker.generation, platform.client_uid
        cooldown_key = (platform.platform_id, client_uid)
        identity: tuple[str, int] | None = None
        last_state: str | None = None
        cancellation: asyncio.Event | None = None
        relay: asyncio.Task | None = None
        window = platform.turn_coordinator.observation_window
        try:
            while True:
                try:
                    message = platform.message_factory.build_message_object(
                        text="", raw_message={}
                    )
                    # Admission needs a session event, not the adapter's output
                    # configuration/logging on every one-second timing sample.
                    event = AstrMessageEvent(
                        "", message, platform.meta(), message.session_id
                    )
                    event.set_extra(
                        "_astrbot_config",
                        self.context.get_config(umo=event.unified_msg_origin),
                    )
                    await build_plugin_admission_snapshot(event=event)
                    admitted = any(
                        item.plugin_id == "ag99live"
                        and item.source_id == "desktop_return"
                        for item in self.context.list_runtime_observation_sensors(event)
                    )
                    if not admitted:
                        if cancellation is not None:
                            cancellation.set()
                        identity = None
                        monitor_id = uuid4().hex
                        self._monitor_ids.pop(cooldown_key, None)
                        await asyncio.sleep(1)
                        continue
                    token = window.snapshot(0)
                    revision = window.revision
                    started = perf_counter()
                    snapshot = await broker.read(monitor_id, settings)
                    if (
                        generation != broker.generation
                        or client_uid != platform.client_uid
                    ):
                        return
                    next_identity = (snapshot["boot_id"], snapshot["sequence"])
                    if snapshot["state"] != last_state:
                        last_state = snapshot["state"]
                        logger.debug(
                            "DIAG desktop_return.state platform=%s state=%s sequence=%s",
                            platform.platform_id,
                            last_state,
                            snapshot["sequence"],
                        )
                    returned = snapshot["returned"]
                    if snapshot["state"] != "active" and cancellation is not None:
                        cancellation.set()
                    if identity is None or identity[0] != next_identity[0]:
                        identity = next_identity
                    elif next_identity[1] > identity[1]:
                        # Consume once even when busy, cooling down or otherwise rejected.
                        identity = next_identity
                        remaining = (
                            (30 - returned["age_seconds"] - (perf_counter() - started))
                            if returned
                            else 0
                        )
                        reason = "eligible"
                        if snapshot["state"] != "active" or remaining <= 0:
                            reason = "stale_or_inactive"
                        elif token is None or not window.is_current(token, 0, revision):
                            reason = "conversation_active"
                        elif (
                            perf_counter()
                            - self._last_attempt.get(cooldown_key, -math.inf)
                            < cooldown
                        ):
                            reason = "return_cooldown"
                        logger.debug(
                            "DIAG desktop_return.candidate platform=%s reason=%s",
                            platform.platform_id,
                            reason,
                        )
                        if reason == "eligible":
                            if cancellation is not None:
                                cancellation.set()
                            if relay is not None:
                                relay.cancel()
                                await asyncio.gather(relay, return_exceptions=True)
                            cancellation = asyncio.Event()

                            async def relay_input(
                                source: asyncio.Event, target: asyncio.Event
                            ) -> None:
                                await source.wait()
                                target.set()

                            relay = asyncio.create_task(
                                relay_input(token, cancellation)
                            )
                            self._last_attempt[cooldown_key] = perf_counter()
                            summary = {
                                "unlock": "系统观察到：屏幕解锁后恢复了输入操作。",
                                "resume": "系统观察到：电脑从休眠恢复后出现了新的输入操作。",
                                "input_resumed": "系统观察到：长时间无输入后恢复了操作；这不能确认用户身体离开过。",
                            }[returned["basis"]]
                            async with asyncio.timeout(remaining):
                                result = await self.handle.submit(
                                    kind="desktop_returned",
                                    session=event.unified_msg_origin,
                                    payload={
                                        "summary": summary,
                                        "inactive_seconds": returned[
                                            "inactive_seconds"
                                        ],
                                    },
                                    expires_in_seconds=remaining,
                                    coalesce_key="desktop_return",
                                    cancel_event=cancellation,
                                )
                            logger.debug(
                                "DIAG desktop_return.submitted platform=%s status=%s",
                                platform.platform_id,
                                getattr(result, "status", "unknown"),
                            )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    if cancellation is not None:
                        cancellation.set()
                    identity = None
                    logger.warning(
                        "Desktop return observation failed platform=%s error=%s reason=%s",
                        platform.platform_id,
                        type(exc).__name__,
                        str(exc)[:160],
                    )
                await asyncio.sleep(1)
        finally:
            if cancellation is not None:
                cancellation.set()
            if relay is not None:
                relay.cancel()
                await asyncio.gather(relay, return_exceptions=True)
