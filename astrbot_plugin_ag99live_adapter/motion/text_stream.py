from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable
from typing import Any


class TextChatStreamUnavailable(RuntimeError):
    """The selected optional Provider cannot produce a chat text stream."""


def supports_text_chat_stream(provider: Any) -> bool:
    stream = getattr(provider, "text_chat_stream", None)
    if not callable(stream):
        return False
    try:
        from astrbot.core.provider import supports_text_chat_stream as supports
    except (ImportError, AttributeError):
        return True
    return bool(supports(provider))


def _consume_close_error(task: asyncio.Task[Any]) -> None:
    if task.cancelled():
        return
    try:
        task.exception()
    except asyncio.CancelledError:
        return


async def _close_stream_iterator(iterator: Any) -> None:
    close = getattr(iterator, "aclose", None)
    if not callable(close):
        return
    close_task = asyncio.create_task(close())
    try:
        await asyncio.wait_for(asyncio.shield(close_task), timeout=0.05)
    except asyncio.CancelledError:
        if not close_task.done():
            close_task.cancel()
        close_task.add_done_callback(_consume_close_error)
        raise
    except asyncio.TimeoutError:
        if not close_task.done():
            close_task.cancel()
        close_task.add_done_callback(_consume_close_error)
    except Exception:
        return


async def read_text_chat_stream(
    provider: Any,
    *,
    prompt: str,
    system_prompt: str,
    contexts: list[dict[str, str]] | tuple[dict[str, str], ...] | None = None,
    on_first_chunk: Callable[[], None] | None = None,
) -> str:
    """Collect a Provider chat stream without a non-streaming fallback."""

    if not supports_text_chat_stream(provider):
        raise TextChatStreamUnavailable("text_chat_stream_unsupported")

    iterator = None
    streamed_text = ""
    final_text = ""
    saw_chunk = False
    first_chunk_reported = False
    try:
        iterator = provider.text_chat_stream(
            prompt=prompt,
            system_prompt=system_prompt,
            contexts=contexts or None,
        )
        if inspect.isawaitable(iterator):
            iterator = await iterator
        if not hasattr(iterator, "__aiter__"):
            raise TextChatStreamUnavailable("text_chat_stream_invalid_iterator")
        async for response in iterator:
            role = str(getattr(response, "role", "") or "")
            chunk_text = str(getattr(response, "completion_text", "") or "")
            if role == "err":
                raise RuntimeError(chunk_text or "text_chat_stream_error")
            if bool(getattr(response, "is_chunk", False)):
                if chunk_text:
                    saw_chunk = True
                    if not first_chunk_reported:
                        first_chunk_reported = True
                        if on_first_chunk is not None:
                            on_first_chunk()
                    # AstrBot is_chunk responses carry deltas, including repeats.
                    streamed_text += chunk_text
                continue
            if chunk_text:
                final_text = chunk_text
        if not saw_chunk:
            raise TextChatStreamUnavailable("text_chat_stream_final_only")
        if final_text:
            if final_text.startswith(streamed_text):
                streamed_text = final_text
            elif not streamed_text.startswith(final_text):
                streamed_text = final_text
        return (streamed_text or final_text).strip()
    finally:
        await _close_stream_iterator(iterator)


__all__ = [
    "TextChatStreamUnavailable",
    "read_text_chat_stream",
    "supports_text_chat_stream",
]
