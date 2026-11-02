"""AstrBot implementation of the neutral RuntimeState provider registry."""

from __future__ import annotations

from astrbot.api.provider import Provider, STTProvider
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.platform.message_type import MessageType


class AstrBotProviderRegistry:
    def __init__(self, context, *, platform_id: str) -> None:
        self._context = context
        self._platform_id = platform_id

    def get_chat_provider(self, provider_id: str):
        if self._context is None:
            return None
        provider = self._context.get_provider_by_id(provider_id)
        return provider if isinstance(provider, Provider) else None

    def get_stt_provider(self, *, platform_id: str, client_uid: str):
        if self._context is None:
            return None
        provider = self._context.get_using_stt_provider(
            umo=str(
                MessageSession(
                    platform_name=platform_id or self._platform_id,
                    message_type=MessageType.FRIEND_MESSAGE,
                    session_id=client_uid,
                )
            )
        )
        return provider if isinstance(provider, STTProvider) else None


__all__ = ["AstrBotProviderRegistry"]
