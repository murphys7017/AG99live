"""Bounded capture-owned warming of existing Memory read caches.

No Turn, history write or input-dependent Prompt is created. Formal collectors
still resolve current identity/config/history and use Memory's own cache keys.
"""

from __future__ import annotations

import asyncio
import inspect
import time

from astrbot.api import logger

try:
    from astrbot.core.memory.config import get_memory_config
    from astrbot.core.memory.scope_context import resolve_memory_scope_context
    from astrbot.core.memory.service import get_memory_service
    from astrbot.core.memory.snapshot_builder import (
        memory_injection_to_snapshot_read_options,
    )
except ImportError:
    get_memory_config = None
    resolve_memory_scope_context = None
    get_memory_service = None
    memory_injection_to_snapshot_read_options = None


_MEMORY_PREPARATION_AVAILABLE = all(
    (
        get_memory_config,
        resolve_memory_scope_context,
        get_memory_service,
        memory_injection_to_snapshot_read_options,
    )
)


class InputPreparation:
    def __init__(self, *, plugin_context, build_event) -> None:
        self._context = plugin_context
        self._build_event = build_event
        self._task: asyncio.Task | None = None
        self._capture_id: str | None = None

    def start(self, capture_id: str) -> None:
        if self._capture_id == capture_id:
            return
        self.cancel()
        # Freeze the authenticated adapter identity before any await/profile change.
        try:
            event = self._build_event()
        except Exception as exc:
            logger.debug("Input preparation skipped: capture_id=%s error=%s", capture_id, exc)
            return
        self._capture_id = capture_id
        self._task = asyncio.create_task(self._run(event, capture_id))

    def cancel(self, capture_id: str | None = None) -> None:
        if capture_id is not None and self._capture_id != capture_id:
            return
        if self._task is not None:
            self._task.cancel()
        self._task = None
        self._capture_id = None

    async def _run(self, event, capture_id: str) -> None:
        started = time.perf_counter()
        status = "started"
        logger.debug("DIAG input.prepare: capture_id=%s stage=%s", capture_id, status)
        try:
            if not _MEMORY_PREPARATION_AVAILABLE:
                status = "unsupported"
                return
            async with asyncio.timeout(5):
                umo = event.unified_msg_origin
                selection = self._context.astrbot_config_mgr.resolve_configuration_selection(umo)
                config = selection.runtime_config
                config_id = selection.config_id
                memory = get_memory_config(config, cache_key=config_id)
                if not memory.enabled or not memory.injection.enabled:
                    status = "disabled"
                    return
                service = get_memory_service(config, cache_key=config_id)
                await service.initialize()
                conversation_id = await self._context.conversation_manager.get_curr_conversation_id(umo)
                identity = None
                if service.identity_resolver is not None:
                    resolved = service.identity_resolver.resolve_from_event(event)
                    identity = await resolved if inspect.isawaitable(resolved) else resolved
                # Reuse the same local/read-through caches as formal collectors.
                # get_prompt_snapshot only schedules recall; it never waits for
                # recall model completion or the previous turn's memory update.
                await service.get_prompt_snapshot(
                    umo=umo,
                    conversation_id=conversation_id,
                    read_options=memory_injection_to_snapshot_read_options(memory.injection),
                    identity=identity,
                    scope_context=resolve_memory_scope_context(event, identity) if identity else None,
                )
                status = "ready"
        except asyncio.CancelledError:
            status = "cancelled"
            raise
        except Exception as exc:  # Optional speculation cannot fail ordinary input.
            status = "failed"
            logger.debug("Input preparation failed: capture_id=%s error=%s", capture_id, exc)
        finally:
            logger.debug(
                "DIAG input.prepare: capture_id=%s stage=%s kind=memory_cache elapsed_ms=%.1f epoch_ms=%s",
                capture_id, status, (time.perf_counter() - started) * 1000,
                time.time_ns() // 1_000_000,
            )
