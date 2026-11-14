"""Desktop presence transport and Core state ingress."""

from __future__ import annotations

import asyncio
from typing import Any
from uuid import uuid4

from ..protocol.desktop_presence import SCHEMA, REQUEST_TYPE, validate_presence_result
from ..protocol.parser import build_message_envelope
from .desktop_state import DesktopStateStore


class DesktopPresenceBroker:
    """Own one connection's presence request/result exchange."""

    def __init__(self, send_json: Any, state_store: DesktopStateStore) -> None:
        self._send_json = send_json
        self.state_store = state_store
        self._pending: tuple[str, asyncio.Future] | None = None
        self.generation = 0
        self.supported = False

    def disconnect(self) -> None:
        self.generation += 1
        self.supported = False
        self.state_store.disconnect()
        if self._pending is not None:
            self._pending[1].cancel()
            self._pending = None

    async def read(self, monitor_id: str, settings: dict[str, Any]) -> dict[str, Any]:
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

    def resolve(self, payload: dict[str, Any]) -> None:
        validate_presence_result(payload)
        if self._pending is None or self._pending[0] != payload["request_id"]:
            return
        future = self._pending[1]
        if future.done():
            return
        if payload["ok"]:
            snapshot = payload["snapshot"]
            self.state_store.update_presence(snapshot)
            future.set_result(snapshot)
        else:
            future.set_exception(RuntimeError(payload["error"]))


__all__ = ["DesktopPresenceBroker", "SCHEMA"]
