from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Callable
from typing import Any, Awaitable


class TextChatStreamUnavailable(RuntimeError):
    """The selected optional Provider cannot produce a chat text stream."""


class TextChatStreamOutputTooLarge(RuntimeError):
    """The optional Provider produced more text than the motion path accepts."""


MAX_TEXT_CHAT_STREAM_CHARS = 16_000


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
    on_complete_json: Callable[[dict[str, Any]], Awaitable[None] | None] | None = None,
    stop_after_complete_json: bool = False,
    request_options: dict[str, Any] | None = None,
) -> str:
    """Collect a Provider chat stream without a non-streaming fallback.

    ``on_complete_json`` is called as soon as the first complete top-level JSON
    object appears in the accumulated delta.  The stream is still consumed to
    EOF by default. ``stop_after_complete_json`` lets short input reactions
    close the iterator immediately after their only complete record. Callers
    can pass request-local Provider options without mutating its configuration.
    """

    if not supports_text_chat_stream(provider):
        raise TextChatStreamUnavailable("text_chat_stream_unsupported")

    iterator = None
    streamed_text = ""
    final_text = ""
    saw_chunk = False
    first_chunk_reported = False
    complete_json_reported = False

    async def report_complete_json() -> None:
        nonlocal complete_json_reported
        if complete_json_reported or on_complete_json is None:
            return
        candidate = _first_complete_json_object(streamed_text)
        if candidate is None:
            return
        complete_json_reported = True
        callback_result = on_complete_json(candidate)
        if inspect.isawaitable(callback_result):
            await callback_result
    try:
        iterator = provider.text_chat_stream(
            prompt=prompt,
            system_prompt=system_prompt,
            contexts=contexts or None,
            **(request_options or {}),
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
                    if len(streamed_text) + len(chunk_text) > MAX_TEXT_CHAT_STREAM_CHARS:
                        raise TextChatStreamOutputTooLarge(
                            f"text_chat_stream_output_too_large:{MAX_TEXT_CHAT_STREAM_CHARS}"
                        )
                    saw_chunk = True
                    if not first_chunk_reported:
                        first_chunk_reported = True
                        if on_first_chunk is not None:
                            on_first_chunk()
                    # AstrBot is_chunk responses carry deltas, including repeats.
                    streamed_text += chunk_text
                    await report_complete_json()
                    if complete_json_reported and stop_after_complete_json:
                        return streamed_text
                continue
            if chunk_text:
                final_text = chunk_text
        if not saw_chunk:
            raise TextChatStreamUnavailable("text_chat_stream_final_only")
        if final_text:
            if len(final_text) > MAX_TEXT_CHAT_STREAM_CHARS:
                raise TextChatStreamOutputTooLarge(
                    f"text_chat_stream_output_too_large:{MAX_TEXT_CHAT_STREAM_CHARS}"
                )
            if final_text.startswith(streamed_text):
                streamed_text = final_text
            elif not streamed_text.startswith(final_text):
                streamed_text = final_text
        return (streamed_text or final_text).strip()
    finally:
        await _close_stream_iterator(iterator)


def _first_complete_json_object(value: str) -> dict[str, Any] | None:
    """Return the first complete JSON object in a streamed text prefix.

    ``JSONDecoder.raw_decode`` handles braces inside quoted strings and escaped
    characters for us.  Searching for the first opening brace keeps this
    tolerant of an optional Markdown fence while still refusing arrays or
    scalar values as action records.
    """

    start = value.find("{")
    if start < 0:
        return None
    try:
        parsed, _ = json.JSONDecoder().raw_decode(value[start:])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


__all__ = [
    "MAX_TEXT_CHAT_STREAM_CHARS",
    "TextChatStreamUnavailable",
    "TextChatStreamOutputTooLarge",
    "read_text_chat_stream",
    "supports_text_chat_stream",
]
