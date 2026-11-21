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
        self._pending: tuple[str, asyncio.Future[str], bool] | None = None
        self.generation = 0
        self.supported = False

    def disconnect(self) -> None:
        self.generation += 1
        self.supported = False
        self.state_store.disconnect()
        if self._pending is not None:
            self._pending[1].cancel()
            self._pending = None

    async def capture(self, *, publish_to_state: bool = True) -> str:
        pending = self._pending
        if not self.supported or (pending is not None and publish_to_state):
            raise RuntimeError("desktop_capture_unavailable")
        owns_request = pending is None
        if pending is None:
            pending = (uuid4().hex, asyncio.get_running_loop().create_future(), publish_to_state)
            self._pending = pending
        request_id, future, _ = pending
        try:
            async with asyncio.timeout(12):
                if not owns_request:
                    # Use a frame already in flight without cancelling another consumer's request.
                    return await asyncio.shield(future)
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
        except asyncio.CancelledError:
            task = asyncio.current_task()
            if future.cancelled() and task is not None and not task.cancelling():
                raise RuntimeError("desktop_capture_disconnected") from None
            raise
        finally:
            if owns_request:
                if self._pending is pending:
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
            if self._pending[2]:
                self.state_store.update_frame(image)
            future.set_result(image)
        else:
            future.set_exception(RuntimeError(payload["error"]))


__all__ = ["DesktopFrameBroker", "SCHEMA"]
