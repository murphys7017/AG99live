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
    ExecutionEvent,
    ExecutionEventKind,
    ExecutionListener,
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
        self._execution_listeners: set[ExecutionListener] = set()
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

    def subscribe_execution(self, listener: ExecutionListener) -> Unsubscribe:
        if self._closed:
            raise RuntimeError("dsh_conversation_provider_closed")
        self._execution_listeners.add(listener)
        active = True

        def unsubscribe() -> None:
            nonlocal active
            if active:
                active = False
                self._execution_listeners.discard(listener)

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
        self._execution_listeners.clear()

    async def publish_event(self, event: ConversationEvent) -> None:
        for listener in tuple(self._listeners):
            result = listener(event)
            if asyncio.iscoroutine(result) or isinstance(result, Awaitable):
                await result

    async def publish_execution_event(self, event: ExecutionEvent) -> None:
        for listener in tuple(self._execution_listeners):
            result = listener(event)
            if asyncio.iscoroutine(result) or isinstance(result, Awaitable):
                await result

    async def _consume_stream(self, turn_id: str, stream: DshReplyStream) -> None:
        index = 0
        async for raw_event in stream:
            execution = _normalize_execution_event(raw_event, turn_id=turn_id, index=index)
            if execution is not None:
                await self.publish_execution_event(execution)
                index += 1
                continue
            dsh_event = _normalize_dsh_conversation_event(
                raw_event,
                turn_id=turn_id,
                index=index,
            )
            if dsh_event is not None:
                await self.publish_event(dsh_event)
                index += 1
                continue
            event = _normalize_event(raw_event, turn_id=turn_id, index=index)
            index += 1
            await self.publish_event(event)


def _normalize_execution_event(
    raw_event: ConversationEvent | Mapping[str, Any],
    *,
    turn_id: str,
    index: int,
) -> ExecutionEvent | None:
    if not isinstance(raw_event, Mapping):
        return None
    raw_type = str(raw_event.get("type") or raw_event.get("kind") or "").strip()
    if raw_type not in {
        "execution/requested",
        "execution/started",
        "execution/output",
        "execution/completed",
        "execution/failed",
        "execution/cancelled",
        "execution/approval_required",
        "tool/call",
        "tool/result",
        "tool/ptc-dispatch-start",
        "tool/ptc-dispatch",
    }:
        return None
    data = raw_event.get("data")
    data = data if isinstance(data, Mapping) else raw_event
    execution_id = str(
        data.get("execution_id")
        or data.get("callId")
        or data.get("call_id")
        or data.get("rootCallId")
        or data.get("subCallId")
        or f"{turn_id}:execution:{index}"
    )
    name = str(data.get("name") or data.get("tool_name") or "execution")
    arguments = data.get("arguments", {})
    if not isinstance(arguments, Mapping):
        arguments = {"raw": arguments}
    output = _extract_execution_text(data.get("content") or data.get("output"))
    error = data.get("error")
    if error is not None and not isinstance(error, Mapping):
        error = {"message": str(error)}
    if raw_type in {"tool/call", "tool/ptc-dispatch-start", "execution/requested"}:
        kind = ExecutionEventKind.STARTED
    elif raw_type in {"tool/result", "tool/ptc-dispatch", "execution/completed", "execution/failed"}:
        kind = ExecutionEventKind.FAILED if error or data.get("isError") else ExecutionEventKind.COMPLETED
    elif raw_type == "execution/cancelled":
        kind = ExecutionEventKind.CANCELLED
    elif raw_type == "execution/approval_required":
        kind = ExecutionEventKind.APPROVAL_REQUIRED
    else:
        kind = ExecutionEventKind.OUTPUT
    reason = None
    if isinstance(error, Mapping):
        reason = str(error.get("reason") or error.get("message") or "").strip() or None
    return ExecutionEvent(
        execution_id=execution_id,
        kind=kind,
        turn_id=turn_id,
        name=name,
        arguments=dict(arguments),
        output=output,
        error=dict(error) if isinstance(error, Mapping) else None,
        reason=reason,
        metadata={"source": "dsh", "wire_type": raw_type},
    )


def _normalize_dsh_conversation_event(
    raw_event: ConversationEvent | Mapping[str, Any],
    *,
    turn_id: str,
    index: int,
) -> ConversationEvent | None:
    if not isinstance(raw_event, Mapping):
        return None
    raw_type = str(raw_event.get("type") or "").strip()
    data = raw_event.get("data")
    data = data if isinstance(data, Mapping) else raw_event
    if raw_type == "assistant/message":
        message = data.get("message") if isinstance(data.get("message"), Mapping) else data
        content = message.get("content") if isinstance(message, Mapping) else None
        text = _extract_execution_text(content)
        if not text:
            return None
        return ConversationEvent(
            kind=ConversationEventKind.TEXT_COMPLETED,
            turn_id=turn_id,
            provider_event_id=f"{turn_id}:assistant:{index}",
            text=text,
            metadata={"source": "dsh", "wire_type": raw_type},
        )
    if raw_type == "assistant/attempt":
        stream = data.get("stream") if isinstance(data, Mapping) else None
        text_parts: list[str] = []
        if isinstance(stream, list):
            for item in stream:
                if not isinstance(item, Mapping):
                    continue
                if item.get("type") == "text-chunks":
                    chunks = item.get("texts")
                    if isinstance(chunks, list):
                        text_parts.extend(str(chunk) for chunk in chunks)
                    continue
                chunk = item.get("chunk")
                if not isinstance(chunk, Mapping) or chunk.get("type") != "block-end":
                    continue
                block = chunk.get("block")
                if isinstance(block, Mapping) and block.get("type") == "text":
                    text_parts.append(str(block.get("text") or ""))
        text = "".join(text_parts)
        if not text:
            return None
        return ConversationEvent(
            kind=ConversationEventKind.TEXT_COMPLETED,
            turn_id=turn_id,
            provider_event_id=f"{turn_id}:assistant-attempt:{index}",
            text=text,
            metadata={"source": "dsh", "wire_type": raw_type},
        )
    if raw_type == "turn/end":
        reason = data.get("reason") if isinstance(data, Mapping) else None
        reason_kind = (
            str(reason.get("kind") or "").strip()
            if isinstance(reason, Mapping)
            else ""
        )
        if reason_kind in {"completed", "max-tokens", "stop", "cancelled"}:
            kind = (
                ConversationEventKind.INTERRUPTED
                if reason_kind == "cancelled"
                else ConversationEventKind.TURN_COMPLETED
            )
        else:
            kind = ConversationEventKind.TURN_FAILED
        return ConversationEvent(
            kind=kind,
            turn_id=turn_id,
            provider_event_id=f"{turn_id}:turn-end:{index}",
            reason=reason_kind or "dsh_turn_end",
            metadata={"source": "dsh", "wire_type": raw_type},
        )
    return None


def _extract_execution_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        return str(value.get("text") or value.get("result") or "")
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, Mapping):
                text = item.get("text") or item.get("result")
                if text is not None:
                    parts.append(str(text))
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts)
    return ""


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
