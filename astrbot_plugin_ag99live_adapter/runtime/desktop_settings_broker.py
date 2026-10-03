"""桌面端本机配置的请求代理。

这些配置（麦克风设备、按键绑定、渲染参数）物理上属于桌面端所在的那台机器，
但用户要在 AstrBot 的 Web 配置页里改它们。适配器自己并不持有这些值，它只做
一次转发：把 Web 页的请求发给当前连接的桌面端，等桌面端回结果，再交回 Web 页。

之所以可行，是因为 WebSocketTransport 是单客户端契约——一个 Adapter 实例只对应
一个桌面端，不存在"发给谁"的问题。

同时缓存最近一次成功的应答，作为桌面端离线时页面要显示的"最后已知值"。
"""

from __future__ import annotations

import asyncio
import math
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable
from uuid import uuid4

from ..protocol.builder import build_system_desktop_settings_query

DESKTOP_SETTINGS_QUERY_TIMEOUT_SECONDS = 8.0
DESKTOP_SETTINGS_MIN_ESP32_SET_BUDGET_SECONDS = 7.25


class DesktopSettingsError(RuntimeError):
    """桌面端没能满足一次被代理的配置请求。code 直接作为失败原因返回。"""


class DesktopSettingsBroker:
    def __init__(
        self,
        *,
        send_json: Callable[[dict[str, Any]], Awaitable[bool]],
        is_connected: Callable[[], bool],
        timeout_seconds: float = DESKTOP_SETTINGS_QUERY_TIMEOUT_SECONDS,
    ) -> None:
        self._send_json = send_json
        self._is_connected = is_connected
        self._timeout_seconds = timeout_seconds
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._snapshot: dict[str, dict[str, Any]] = {}
        self._esp32_set_lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return bool(self._is_connected())

    def snapshot(self) -> dict[str, dict[str, Any]]:
        """最近一次已知的桌面端取值，桌面端离线时页面靠它显示而不是留空。"""
        return {key: dict(value) for key, value in self._snapshot.items()}

    async def query(
        self,
        *,
        key: str,
        action: str,
        value: str | None = None,
    ) -> dict[str, Any]:
        if not self.connected:
            raise DesktopSettingsError("desktop_client_offline")

        request_id = uuid4().hex
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._timeout_seconds
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        esp32_set = action == "set" and key.startswith("esp32_display_")
        lock_acquired = False
        try:
            if esp32_set:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                await asyncio.wait_for(
                    self._esp32_set_lock.acquire(), remaining
                )
                lock_acquired = True
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise asyncio.TimeoutError
            if (
                esp32_set
                and remaining < DESKTOP_SETTINGS_MIN_ESP32_SET_BUDGET_SECONDS
            ):
                raise asyncio.TimeoutError
            self._pending[request_id] = future
            sent = await asyncio.wait_for(
                self._send_json(
                    build_system_desktop_settings_query(
                        request_id=request_id,
                        key=key,
                        action=action,
                        value=value,
                    )
                ),
                remaining,
            )
            if not sent:
                raise DesktopSettingsError("desktop_client_send_failed")
            response_timeout = (
                self._timeout_seconds
                if esp32_set
                else deadline - loop.time()
            )
            if response_timeout <= 0:
                raise asyncio.TimeoutError
            result = await asyncio.wait_for(future, response_timeout)
        except asyncio.TimeoutError as exc:
            raise DesktopSettingsError("desktop_client_timeout") from exc
        finally:
            self._pending.pop(request_id, None)
            if lock_acquired:
                self._esp32_set_lock.release()

        if not result.get("ok"):
            raise DesktopSettingsError(
                str(result.get("error") or "desktop_client_rejected")
            )

        entry = {
            "value": str(result.get("value") or ""),
            "options": [
                {"id": str(item["id"]), "label": str(item["label"])}
                for item in result.get("options") or []
            ],
            "reportedAt": datetime.now(timezone.utc).isoformat(),
        }
        for field in ("minimum", "maximum", "step"):
            bound = result.get(field)
            if (
                isinstance(bound, (int, float))
                and not isinstance(bound, bool)
                and math.isfinite(bound)
            ):
                entry[field] = bound
        self._snapshot[key] = entry
        return dict(entry)

    def resolve(self, payload: dict[str, Any]) -> bool:
        """把桌面端的应答交回等待中的请求。返回是否命中了一个等待者。"""
        request_id = str(payload.get("request_id") or "").strip()
        future = self._pending.get(request_id)
        if future is None or future.done():
            return False
        future.set_result(payload)
        return True

    def fail_pending(self, reason: str) -> None:
        """连接断开时立刻释放等待者，而不是让它们各自等到超时。"""
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(DesktopSettingsError(reason))
        self._pending.clear()
