"""Minimal DSH ConversationProvider boundary.

The DSH protocol is intentionally injected as callbacks. This keeps endpoint,
authentication and session details in the DSH adapter while the Orchestrator
consumes the same ConversationInput/ConversationEvent contract as AstrBot.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterable, Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from ...providers.contracts import (
    ConversationEvent,
    ConversationEventKind,
    ConversationInput,
    ConversationListener,
    ConversationProvider,
    SegmentBoundary,
    Unsubscribe,
)


DshReplyStream = AsyncIterable[ConversationEvent | Mapping[str, Any]]
DshSend = Callable[
    [ConversationInput],
    Awaitable[DshReplyStream | None] | DshReplyStream | None,
]
DshInterrupt = Callable[[str | None], Awaitable[None]]
DshClose = Callable[[], Awaitable[None]]


@dataclass(frozen=True)
class DshConversationCallbacks:
    send: DshSend
    interrupt: DshInterrupt
    close: DshClose


class DshConversationProvider(ConversationProvider):
    """Adapt one DSH reply stream without creating Turn or output state."""

    def __init__(self, callbacks: DshConversationCallbacks) -> None:
        self._callbacks = callbacks
        self._listeners: set[ConversationListener] = set()
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._closed = False

    def subscribe(self, listener: ConversationListener) -> Unsubscribe:
        if self._closed:
            raise RuntimeError("dsh_conversation_provider_closed")
        self._listeners.add(listener)
        active = True

        def unsubscribe() -> None:
            nonlocal active
            if active:
                active = False
                self._listeners.discard(listener)

        return unsubscribe

    async def send_message(self, request: ConversationInput) -> None:
        if self._closed:
            raise RuntimeError("dsh_conversation_provider_closed")
        if request.turn_id in self._tasks:
            raise RuntimeError("dsh_turn_already_active")
        result = self._callbacks.send(request)
        stream = await result if asyncio.iscoroutine(result) or isinstance(result, Awaitable) else result
        if stream is None:
            return
        task = asyncio.create_task(
            self._consume_stream(request.turn_id, stream),
            name=f"ag99live-dsh-conversation-{request.turn_id[:16]}",
        )
        self._tasks[request.turn_id] = task
        task.add_done_callback(lambda _: self._tasks.pop(request.turn_id, None))
        await task

    async def interrupt(self, turn_id: str | None = None) -> None:
        normalized = str(turn_id or "").strip() or None
        await self._callbacks.interrupt(normalized)
        if normalized is not None:
            task = self._tasks.pop(normalized, None)
            if task is not None and not task.done():
                task.cancel()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        tasks = tuple(self._tasks.values())
        self._tasks.clear()
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self._callbacks.close()
        self._listeners.clear()

    async def publish_event(self, event: ConversationEvent) -> None:
        for listener in tuple(self._listeners):
            result = listener(event)
            if asyncio.iscoroutine(result) or isinstance(result, Awaitable):
                await result

    async def _consume_stream(self, turn_id: str, stream: DshReplyStream) -> None:
        index = 0
        async for raw_event in stream:
            event = _normalize_event(raw_event, turn_id=turn_id, index=index)
            index += 1
            await self.publish_event(event)


def _normalize_event(
    raw_event: ConversationEvent | Mapping[str, Any],
    *,
    turn_id: str,
    index: int,
) -> ConversationEvent:
    if isinstance(raw_event, ConversationEvent):
        if raw_event.turn_id != turn_id:
            raise ValueError("dsh_event_turn_identity_invalid")
        return raw_event
    if not isinstance(raw_event, Mapping):
        raise TypeError("dsh_event_invalid")
    kind_raw = str(raw_event.get("kind") or "").strip()
    try:
        kind = ConversationEventKind(kind_raw)
    except ValueError as exc:
        raise ValueError(f"dsh_event_kind_invalid:{kind_raw}") from exc
    boundary_raw = raw_event.get("boundary")
    boundary = None
    if boundary_raw is not None:
        if not isinstance(boundary_raw, Mapping):
            raise TypeError("dsh_event_boundary_invalid")
        boundary = SegmentBoundary(
            provider_boundary_id=str(
                boundary_raw.get("provider_boundary_id")
                or boundary_raw.get("id")
                or f"{turn_id}:boundary:{index}"
            ),
            reason=str(boundary_raw.get("reason") or "dsh_boundary"),
        )
    metadata = raw_event.get("metadata", {})
    if not isinstance(metadata, Mapping):
        raise TypeError("dsh_event_metadata_invalid")
    return ConversationEvent(
        kind=kind,
        turn_id=turn_id,
        provider_event_id=str(
            raw_event.get("provider_event_id") or f"{turn_id}:event:{index}"
        ),
        text=str(raw_event.get("text") or ""),
        boundary=boundary,
        reason=(str(raw_event["reason"]).strip() if raw_event.get("reason") else None),
        metadata=dict(metadata),
    )


__all__ = ["DshConversationCallbacks", "DshConversationProvider"]
