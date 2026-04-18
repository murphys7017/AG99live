from __future__ import annotations

from typing import Any, Awaitable, Callable
from uuid import uuid4


SUPPORTED_COMPAT_MESSAGE_TYPES = {
    "fetch-backgrounds",
    "fetch-history-list",
    "create-new-history",
    "fetch-and-set-history",
    "delete-history",
    "heartbeat",
    "audio-play-start",
}


class FrontendCompatHandler:
    def __init__(
        self,
        *,
        background_files_getter: Callable[[], list[str]],
        history_bridge,
    ) -> None:
        self._background_files_getter = background_files_getter
        self._history_bridge = history_bridge
        self._history_uid = str(uuid4())

    @staticmethod
    def can_handle(msg_type: str | None) -> bool:
        return msg_type in SUPPORTED_COMPAT_MESSAGE_TYPES

    async def handle(
        self,
        message: dict[str, Any],
        *,
        send_json: Callable[[dict[str, Any]], Awaitable[bool]],
        refresh_and_send_model: Callable[..., Awaitable[None]],
    ) -> None:
        msg_type = message.get("type")

        if msg_type == "fetch-backgrounds":
            await send_json(
                {"type": "background-files", "files": self._background_files_getter()}
            )
        elif msg_type == "fetch-history-list":
            histories = await self._history_bridge.list_histories()
            await send_json({"type": "history-list", "histories": histories})
        elif msg_type == "create-new-history":
            history_uid = await self._history_bridge.create_history()
            self._history_uid = history_uid or str(uuid4())
            await send_json(
                {"type": "new-history-created", "history_uid": self._history_uid}
            )
        elif msg_type == "fetch-and-set-history":
            history_uid = str(message.get("history_uid") or "").strip()
            messages = await self._history_bridge.fetch_history(history_uid)
            if history_uid:
                self._history_uid = history_uid
            await send_json({"type": "history-data", "messages": messages})
        elif msg_type == "delete-history":
            history_uid = str(message.get("history_uid") or "").strip()
            success = await self._history_bridge.delete_history(history_uid)
            await send_json(
                {
                    "type": "history-deleted",
                    "success": success,
                    "history_uid": history_uid,
                }
            )
        elif msg_type == "heartbeat":
            await send_json({"type": "heartbeat-ack"})
