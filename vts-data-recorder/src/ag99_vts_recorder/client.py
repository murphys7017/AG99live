from __future__ import annotations

import asyncio
import contextlib
import json
import time
from dataclasses import dataclass
from typing import Any, Mapping

import websockets

from .protocol import (
    InboundMessage,
    VTSAPIError,
    VTSProtocolError,
    build_request,
    parse_inbound_message,
    raise_for_api_error,
)


class VTSConnectionError(RuntimeError):
    """Raised when the WebSocket connection cannot serve a request."""


class VTSRequestTimeout(RuntimeError):
    """Raised when VTube Studio does not answer before the request deadline."""


@dataclass(frozen=True)
class VTSResponse:
    request_id: str
    message_type: str
    data: Mapping[str, Any]
    raw: Mapping[str, Any]
    sent_monotonic_ns: int
    received_monotonic_ns: int
    vts_timestamp_ms: int | None


@dataclass(frozen=True)
class _ReceivedMessage:
    message: InboundMessage
    received_monotonic_ns: int


class VTSClient:
    """Minimal request/event client with exactly one WebSocket receive loop."""

    def __init__(
        self,
        endpoint: str,
        *,
        connect_timeout_seconds: float = 5.0,
        request_timeout_seconds: float = 5.0,
    ) -> None:
        self.endpoint = endpoint
        self.connect_timeout_seconds = connect_timeout_seconds
        self.request_timeout_seconds = request_timeout_seconds
        self._websocket: Any | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._send_lock = asyncio.Lock()
        self._pending: dict[str, asyncio.Future[_ReceivedMessage]] = {}
        self._events: asyncio.Queue[InboundMessage] = asyncio.Queue()
        self._closed = False
        self._reader_error: BaseException | None = None

    async def __aenter__(self) -> "VTSClient":
        await self.connect()
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def connect(self) -> None:
        if self._websocket is not None:
            return
        try:
            self._websocket = await websockets.connect(
                self.endpoint,
                open_timeout=self.connect_timeout_seconds,
            )
        except Exception as exc:
            raise VTSConnectionError(
                f"Unable to connect to VTube Studio at {self.endpoint}: {exc}"
            ) from exc
        self._closed = False
        self._reader_task = asyncio.create_task(
            self._read_messages(),
            name="ag99-vts-recorder-receive-loop",
        )

    async def close(self) -> None:
        self._closed = True
        websocket = self._websocket
        self._websocket = None
        if websocket is not None:
            with contextlib.suppress(Exception):
                await websocket.close(code=1000, reason="AG99live probe finished")
        reader_task = self._reader_task
        self._reader_task = None
        if reader_task is not None:
            reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await reader_task
        self._fail_pending(VTSConnectionError("VTube Studio connection closed"))

    async def request(
        self,
        message_type: str,
        data: Mapping[str, Any] | None = None,
        *,
        timeout_seconds: float | None = None,
    ) -> VTSResponse:
        websocket = self._websocket
        if websocket is None:
            raise VTSConnectionError("VTube Studio client is not connected")
        if self._reader_error is not None:
            raise VTSConnectionError("VTube Studio receive loop has stopped") from self._reader_error

        request_payload = build_request(message_type, data)
        request_id = str(request_payload["requestID"])
        future: asyncio.Future[_ReceivedMessage] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            async with self._send_lock:
                if self._websocket is None:
                    raise VTSConnectionError("VTube Studio connection closed before send")
                sent_monotonic_ns = time.monotonic_ns()
                await self._websocket.send(json.dumps(request_payload))
            timeout = timeout_seconds if timeout_seconds is not None else self.request_timeout_seconds
            try:
                received = await asyncio.wait_for(future, timeout=timeout)
            except TimeoutError as exc:
                raise VTSRequestTimeout(
                    f"{message_type} did not receive a VTube Studio response within {timeout:.1f}s"
                ) from exc
            raise_for_api_error(received.message)
            return VTSResponse(
                request_id=request_id,
                message_type=received.message.message_type,
                data=received.message.data,
                raw=received.message.raw,
                sent_monotonic_ns=sent_monotonic_ns,
                received_monotonic_ns=received.received_monotonic_ns,
                vts_timestamp_ms=received.message.timestamp_ms,
            )
        except VTSAPIError:
            raise
        except (VTSConnectionError, VTSRequestTimeout):
            raise
        except Exception as exc:
            raise VTSConnectionError(f"Failed to send {message_type}: {exc}") from exc
        finally:
            self._pending.pop(request_id, None)

    def drain_events(self) -> list[InboundMessage]:
        events: list[InboundMessage] = []
        while True:
            try:
                events.append(self._events.get_nowait())
            except asyncio.QueueEmpty:
                return events

    async def _read_messages(self) -> None:
        try:
            websocket = self._websocket
            if websocket is None:
                return
            async for raw_payload in websocket:
                received_monotonic_ns = time.monotonic_ns()
                try:
                    decoded = json.loads(raw_payload)
                    message = parse_inbound_message(decoded)
                except (json.JSONDecodeError, VTSProtocolError) as exc:
                    self._reader_error = exc
                    self._fail_pending(VTSConnectionError(f"Invalid VTube Studio message: {exc}"))
                    return

                pending = self._pending.get(message.request_id or "")
                if pending is not None and not pending.done():
                    pending.set_result(
                        _ReceivedMessage(
                            message=message,
                            received_monotonic_ns=received_monotonic_ns,
                        )
                    )
                else:
                    self._events.put_nowait(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._reader_error = exc
        finally:
            if not self._closed:
                self._fail_pending(VTSConnectionError("VTube Studio receive loop stopped"))

    def _fail_pending(self, error: Exception) -> None:
        for future in tuple(self._pending.values()):
            if not future.done():
                future.set_exception(error)
