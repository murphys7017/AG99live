"""Desktop screenshot transport and Core state ingress."""

from __future__ import annotations

import asyncio
from typing import Any
from uuid import uuid4

from ..protocol.desktop_observation import SCHEMA, REQUEST_TYPE, validate_frame_result
from ..protocol.parser import build_message_envelope
from .desktop_state import DesktopStateStore


class DesktopFrameBroker:
    """Own one connection's screenshot request/result exchange."""

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

    async def capture(self) -> str:
        if not self.supported or self._pending is not None:
            raise RuntimeError("desktop_capture_unavailable")
        request_id = uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self._pending = (request_id, future)
        try:
            async with asyncio.timeout(12):
                sent = await self._send_json(
                    build_message_envelope(
                        REQUEST_TYPE,
                        source="adapter",
                        payload={"schema_version": SCHEMA, "request_id": request_id},
                    )
                )
                if not sent:
                    raise RuntimeError("desktop_capture_send_failed")
                return await future
        finally:
            if self._pending is not None and self._pending[0] == request_id:
                self._pending = None
            if not future.done():
                future.cancel()

    def resolve(self, payload: dict[str, Any]) -> None:
        validate_frame_result(payload)
        if self._pending is None or self._pending[0] != payload["request_id"]:
            return
        future = self._pending[1]
        if future.done():
            return
        if payload["ok"]:
            image = "data:image/jpeg;base64," + payload["data"]
            self.state_store.update_frame(image)
            future.set_result(image)
        else:
            future.set_exception(RuntimeError(payload["error"]))


__all__ = ["DesktopFrameBroker", "SCHEMA"]
