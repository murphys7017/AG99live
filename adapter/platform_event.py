"""AstrBot event wrapper for the AG99live desktop frontend."""

from __future__ import annotations

from astrbot.api.event import AstrMessageEvent


class OLVPetPlatformEvent(AstrMessageEvent):
    """Message event that sends AstrBot replies back to the desktop frontend."""

    def __init__(self, message_str, message_obj, platform_meta, session_id, adapter):
        super().__init__(message_str, message_obj, platform_meta, session_id)
        self.adapter = adapter

    async def send(self, message):
        await self.adapter.emit_message_chain(
            message_chain=message,
            unified_msg_origin=self.unified_msg_origin,
        )
        await super().send(message)
