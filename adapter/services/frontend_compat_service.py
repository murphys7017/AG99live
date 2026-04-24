from __future__ import annotations

from typing import Awaitable, Callable
from uuid import uuid4

from ..adapter.payload_builder import (
    build_system_background_list,
    build_system_heartbeat_ack,
    build_system_history_created,
    build_system_history_data,
    build_system_history_deleted,
    build_system_history_list,
)
from ..adapter.protocol import (
    TYPE_SYSTEM_BACKGROUND_LIST_REQUEST,
    TYPE_SYSTEM_HEARTBEAT,
    TYPE_SYSTEM_HISTORY_CREATE,
    TYPE_SYSTEM_HISTORY_DELETE,
    TYPE_SYSTEM_HISTORY_LIST_REQUEST,
    TYPE_SYSTEM_HISTORY_LOAD,
)

SUPPORTED_SYSTEM_MESSAGE_TYPES = {
    TYPE_SYSTEM_BACKGROUND_LIST_REQUEST,
    TYPE_SYSTEM_HISTORY_LIST_REQUEST,
    TYPE_SYSTEM_HISTORY_CREATE,
    TYPE_SYSTEM_HISTORY_LOAD,
    TYPE_SYSTEM_HISTORY_DELETE,
    TYPE_SYSTEM_HEARTBEAT,
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
        return msg_type in SUPPORTED_SYSTEM_MESSAGE_TYPES

    async def handle(
        self,
        message,
        *,
        send_json: Callable[[dict], Awaitable[bool]],
        refresh_and_send_model: Callable[..., Awaitable[None]],
    ) -> None:
        del refresh_and_send_model

        msg_type = message.type
        session_id = message.session_id
        payload = message.payload

        if msg_type == TYPE_SYSTEM_BACKGROUND_LIST_REQUEST:
            await send_json(
                build_system_background_list(
                    session_id=session_id,
                    files=self._background_files_getter(),
                )
            )
        elif msg_type == TYPE_SYSTEM_HISTORY_LIST_REQUEST:
            histories = await self._history_bridge.list_histories()
            await send_json(
                build_system_history_list(
                    session_id=session_id,
                    histories=histories,
                )
            )
        elif msg_type == TYPE_SYSTEM_HISTORY_CREATE:
            history_uid = await self._history_bridge.create_history()
            self._history_uid = history_uid or str(uuid4())
            await send_json(
                build_system_history_created(
                    session_id=session_id,
                    history_uid=self._history_uid,
                )
            )
        elif msg_type == TYPE_SYSTEM_HISTORY_LOAD:
            history_uid = str(payload.get("history_uid") or "").strip()
            messages = await self._history_bridge.fetch_history(history_uid)
            if history_uid:
                self._history_uid = history_uid
            await send_json(
                build_system_history_data(
                    session_id=session_id,
                    messages=messages,
                )
            )
        elif msg_type == TYPE_SYSTEM_HISTORY_DELETE:
            history_uid = str(payload.get("history_uid") or "").strip()
            success = await self._history_bridge.delete_history(history_uid)
            await send_json(
                build_system_history_deleted(
                    session_id=session_id,
                    history_uid=history_uid,
                    success=success,
                )
            )
        elif msg_type == TYPE_SYSTEM_HEARTBEAT:
            await send_json(build_system_heartbeat_ack(session_id=session_id))
