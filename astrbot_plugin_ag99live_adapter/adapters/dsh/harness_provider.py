"""Concrete DSH ConversationProvider backed by the local Harness runtime."""

from __future__ import annotations

from collections.abc import Mapping

from ...providers.contracts import ConversationInput
from .conversation_provider import DshConversationCallbacks, DshConversationProvider
from .harness_client import DshHarnessClient, DshHarnessConfig


class DshHarnessConversationProvider(DshConversationProvider):
    """Bridge AG99live turns to one reusable DeepSeek Harness process."""

    def __init__(self, config: DshHarnessConfig) -> None:
        self.client = DshHarnessClient(config)
        super().__init__(
            DshConversationCallbacks(
                send=self._send,
                interrupt=self._interrupt,
                close=self.client.close,
            )
        )
        self._active_sessions: set[str] = set()

    async def _send(self, request: ConversationInput):
        self._active_sessions.add(request.turn_id)
        try:
            async for event in self.client.prompt(
                session_id=request.metadata.get("dsh_session_id", request.turn_id)
                if isinstance(request.metadata, Mapping)
                else request.turn_id,
                text=request.text,
                metadata=request.metadata,
            ):
                yield event
        finally:
            self._active_sessions.discard(request.turn_id)

    async def _interrupt(self, turn_id: str | None) -> None:
        # The SDK JSON-RPC profile currently exposes no session/cancel method.
        # Cancelling the provider-owned stream prevents late events from being
        # admitted; the process remains reusable for the next session.
        return None


__all__ = ["DshHarnessConversationProvider"]
