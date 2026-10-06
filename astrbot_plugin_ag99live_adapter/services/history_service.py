from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from astrbot.api import logger
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.platform.message_type import MessageType
from ..motion.output_sanitizer import sanitize_assistant_output_text


class HistoryNotFoundError(LookupError):
    """The requested conversation does not belong to this adapter session."""


class ConversationHistoryBridge:
    """Project AstrBot conversation history for desktop and authenticated Web clients."""

    def __init__(
        self,
        *,
        plugin_context: Any,
        platform_id: str,
        client_uid: str,
        speaker_name: str,
        chat_buffer,
    ) -> None:
        self._plugin_context = plugin_context
        self._platform_id = platform_id
        self._client_uid = client_uid
        self._speaker_name = speaker_name
        self._chat_buffer = chat_buffer
        self._lock = asyncio.Lock()

    def set_client_uid(self, client_uid: str) -> None:
        self._client_uid = client_uid

    async def list_histories(self) -> list[dict[str, Any]]:
        async with self._lock:
            return await self._list_histories(
                self._get_conversation_manager(), self._build_unified_msg_origin()
            )

    async def read_history_state(self, history_uid: str | None = None) -> dict[str, Any]:
        async with self._lock:
            return await self._read_history_state(
                self._get_conversation_manager(),
                self._build_unified_msg_origin(),
                history_uid,
            )

    async def mutate_history_state(
        self,
        action: Literal["create", "load", "delete"],
        history_uid: str | None = None,
    ) -> dict[str, Any]:
        async with self._lock:
            conv_mgr = self._get_conversation_manager()
            umo = self._build_unified_msg_origin()
            if action == "create":
                await self._create_history(conv_mgr, umo)
            elif action == "load" and history_uid:
                await self._fetch_history(conv_mgr, umo, history_uid)
            elif action == "delete" and history_uid:
                if not await self._delete_history(conv_mgr, umo, history_uid):
                    raise RuntimeError("history_operation_failed")
            else:
                raise ValueError("history_operation_invalid")
            return await self._read_history_state(conv_mgr, umo)

    async def fetch_history(self, history_uid: str) -> list[dict[str, Any]]:
        async with self._lock:
            return await self._fetch_history(
                self._get_conversation_manager(),
                self._build_unified_msg_origin(),
                history_uid,
            )

    async def create_history(self) -> str:
        async with self._lock:
            return await self._create_history(
                self._get_conversation_manager(), self._build_unified_msg_origin()
            )

    async def delete_history(self, history_uid: str) -> bool:
        async with self._lock:
            return await self._delete_history(
                self._get_conversation_manager(),
                self._build_unified_msg_origin(),
                history_uid,
            )

    async def _list_histories(self, conv_mgr: Any, umo: str) -> list[dict[str, Any]]:
        conversations = await conv_mgr.get_conversations(
            unified_msg_origin=umo,
            platform_id=self._platform_id,
        )
        histories: list[dict[str, Any]] = []
        for conversation in conversations:
            if not self._owns_conversation(conversation, umo):
                continue
            messages = self._conversation_to_frontend_messages(conversation)
            latest_message = self._pick_latest_text_message(messages)
            anchor_time = self._resolve_anchor_time(conversation)
            histories.append(
                {
                    "uid": conversation.cid,
                    "latest_message": latest_message,
                    "timestamp": latest_message["timestamp"]
                    if latest_message
                    else anchor_time.isoformat() if anchor_time else "",
                }
            )

        histories.sort(key=lambda item: item.get("timestamp") or "", reverse=True)
        return histories

    def _owns_conversation(self, conversation: Any | None, umo: str) -> bool:
        return bool(
            conversation is not None
            and getattr(conversation, "user_id", None) == umo
            and getattr(conversation, "platform_id", None) == self._platform_id
        )

    async def _get_owned_conversation(
        self, conv_mgr: Any, umo: str, history_uid: str
    ) -> Any:
        conversation = await conv_mgr.get_conversation(
            unified_msg_origin=umo,
            conversation_id=history_uid,
        )
        # AstrBot's ID lookup does not itself filter by the supplied session.
        if not self._owns_conversation(conversation, umo):
            raise HistoryNotFoundError("history_not_found")
        return conversation

    async def _read_history_state(
        self, conv_mgr: Any, umo: str, history_uid: str | None = None
    ) -> dict[str, Any]:
        histories = await self._list_histories(conv_mgr, umo)
        active_uid = await conv_mgr.get_curr_conversation_id(umo) or ""
        if not any(item["uid"] == active_uid for item in histories):
            active_uid = ""
        selected_uid = history_uid if history_uid is not None else active_uid
        messages = []
        if selected_uid:
            conversation = await self._get_owned_conversation(conv_mgr, umo, selected_uid)
            messages = self._conversation_to_frontend_messages(conversation)
        return {
            "platform_id": self._platform_id,
            "active_history_uid": active_uid,
            "history_uid": selected_uid,
            "histories": histories,
            "messages": messages,
        }

    async def _fetch_history(
        self, conv_mgr: Any, umo: str, history_uid: str
    ) -> list[dict[str, Any]]:
        conversation = await self._get_owned_conversation(conv_mgr, umo, history_uid)
        messages = self._conversation_to_frontend_messages(conversation)
        await conv_mgr.switch_conversation(umo, history_uid)
        self._sync_chat_buffer(messages)
        return messages

    async def _create_history(self, conv_mgr: Any, umo: str) -> str:
        history_uid = await conv_mgr.new_conversation(
            umo,
            platform_id=self._platform_id,
        )
        if not isinstance(history_uid, str) or not history_uid.strip():
            raise RuntimeError("Conversation manager returned an empty conversation ID.")
        self._sync_chat_buffer([])
        return history_uid.strip()

    async def _delete_history(self, conv_mgr: Any, umo: str, history_uid: str) -> bool:
        await self._get_owned_conversation(conv_mgr, umo, history_uid)
        try:
            await conv_mgr.delete_conversation(
                unified_msg_origin=umo,
                conversation_id=history_uid,
            )
        except Exception as exc:
            logger.warning("Failed to delete conversation `%s`: %s", history_uid, exc)
            return False

        remaining = await self._list_histories(conv_mgr, umo)
        current_cid = await conv_mgr.get_curr_conversation_id(umo)
        remaining_uids = {item["uid"] for item in remaining}
        if current_cid not in remaining_uids:
            current_cid = remaining[0]["uid"] if remaining else ""
            if current_cid:
                await conv_mgr.switch_conversation(umo, current_cid)

        if not current_cid:
            self._sync_chat_buffer([])
            return True

        conversation = await self._get_owned_conversation(conv_mgr, umo, current_cid)
        self._sync_chat_buffer(self._conversation_to_frontend_messages(conversation))
        return True

    def _get_conversation_manager(self) -> Any:
        context = self._plugin_context
        if context is None:
            raise RuntimeError("Plugin context is unavailable for conversation history.")

        conv_mgr = getattr(context, "conversation_manager", None)
        if conv_mgr is None:
            raise RuntimeError("Conversation manager is unavailable on plugin context.")
        return conv_mgr

    def _build_unified_msg_origin(self) -> str:
        return str(
            MessageSession(
                platform_name=self._platform_id,
                message_type=MessageType.FRIEND_MESSAGE,
                session_id=self._client_uid,
            )
        )

    def _conversation_to_frontend_messages(
        self,
        conversation: Any | None,
    ) -> list[dict[str, Any]]:
        if conversation is None:
            return []

        records = self._parse_history_records(getattr(conversation, "history", ""))
        if not records:
            return []

        tool_results = self._collect_tool_results(records)
        converted: list[dict[str, Any]] = []
        for record_index, record in enumerate(records):
            role = str(record.get("role", "") or "").lower().strip()
            if role == "user":
                text = self._extract_display_text(record.get("content"))
                if text:
                    converted.append(
                        {
                            "id": f"{conversation.cid}-user-{record_index}",
                            "content": text,
                            "role": "human",
                            "type": "text",
                        }
                    )
                continue

            if role != "assistant":
                continue

            text = self._extract_display_text(record.get("content"))
            if text:
                converted.append(
                    {
                        "id": f"{conversation.cid}-assistant-{record_index}",
                        "content": text,
                        "role": "ai",
                        "type": "text",
                        "name": self._speaker_name,
                        "avatar": "",
                    }
                )

            tool_calls = record.get("tool_calls")
            if not isinstance(tool_calls, list):
                continue

            for tool_index, tool_call in enumerate(tool_calls):
                if not isinstance(tool_call, dict):
                    continue
                function = tool_call.get("function")
                if not isinstance(function, dict):
                    continue
                tool_id = str(
                    tool_call.get("id")
                    or f"{conversation.cid}-tool-{record_index}-{tool_index}"
                )
                tool_name = str(function.get("name") or "").strip()
                if not tool_name:
                    continue
                tool_content = (
                    tool_results.get(tool_id)
                    or self._stringify_tool_arguments(function.get("arguments"))
                )
                converted.append(
                    {
                        "id": tool_id,
                        "role": "ai",
                        "type": "tool_call_status",
                        "tool_id": tool_id,
                        "tool_name": tool_name,
                        "status": "completed",
                        "content": tool_content,
                        "name": self._speaker_name,
                    }
                )

        if not converted:
            return []

        anchored_at = self._resolve_anchor_time(conversation)
        total = len(converted)
        for index, message in enumerate(converted):
            timestamp = anchored_at - timedelta(seconds=max(total - index - 1, 0))
            message["timestamp"] = timestamp.isoformat()

        return converted

    @staticmethod
    def _parse_history_records(history_value: Any) -> list[dict[str, Any]]:
        if isinstance(history_value, list):
            parsed = history_value
        elif not isinstance(history_value, str) or not history_value.strip():
            return []
        else:
            try:
                parsed = json.loads(history_value)
            except (TypeError, ValueError) as exc:
                raise ValueError("Conversation history contains invalid JSON.") from exc

        if not isinstance(parsed, list):
            raise ValueError("Conversation history must contain a JSON array.")
        if any(not isinstance(item, dict) for item in parsed):
            raise ValueError("Conversation history contains a non-object record.")
        return parsed

    def _collect_tool_results(
        self,
        records: list[dict[str, Any]],
    ) -> dict[str, str]:
        tool_results: dict[str, str] = {}
        for record in records:
            if str(record.get("role", "") or "").lower().strip() != "tool":
                continue
            tool_call_id = str(record.get("tool_call_id") or "").strip()
            if not tool_call_id:
                continue
            tool_content = self._extract_display_text(record.get("content"))
            if tool_content:
                tool_results[tool_call_id] = tool_content
        return tool_results

    @staticmethod
    def _resolve_anchor_time(conversation: Any) -> datetime | None:
        updated_at = getattr(conversation, "updated_at", 0) or 0
        created_at = getattr(conversation, "created_at", 0) or 0
        timestamp = updated_at or created_at
        if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)) or timestamp <= 0:
            return None
        try:
            return datetime.fromtimestamp(timestamp, tz=timezone.utc)
        except (OverflowError, OSError, ValueError) as exc:
            logger.warning("Conversation timestamp is invalid: %r", timestamp)
            return None

    def _sync_chat_buffer(self, messages: list[dict[str, Any]]) -> None:
        self._chat_buffer.clear()
        for message in messages:
            if message.get("type") != "text":
                continue
            role = "assistant" if message.get("role") == "ai" else "user"
            self._chat_buffer.add(role, str(message.get("content") or ""))

    @staticmethod
    def _pick_latest_text_message(
        messages: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        for message in reversed(messages):
            if message.get("type") != "text":
                continue
            role = message.get("role")
            if role not in {"human", "ai"}:
                continue
            return {
                "role": role,
                "timestamp": str(message.get("timestamp") or ""),
                "content": str(message.get("content") or ""),
            }
        return None

    def _extract_display_text(self, value: Any) -> str:
        chunks: list[str] = []
        self._collect_display_text(value, chunks)
        return "\n".join(chunk for chunk in chunks if chunk).strip()

    def _collect_display_text(self, value: Any, chunks: list[str]) -> None:
        if value is None:
            return

        if isinstance(value, str):
            text = self._sanitize_text(value)
            if text:
                chunks.append(text)
            return

        if isinstance(value, list):
            for item in value:
                self._collect_display_text(item, chunks)
            return

        if not isinstance(value, dict):
            text = self._sanitize_text(str(value))
            if text:
                chunks.append(text)
            return

        part_type = str(value.get("type") or "").strip()
        if part_type == "text":
            self._collect_display_text(value.get("text"), chunks)
            return
        if part_type == "image_url":
            chunks.append("[图片]")
            return
        if part_type == "audio_url":
            chunks.append("[音频]")
            return
        if part_type == "think":
            return

        for key in ("text", "content", "prompt"):
            if key in value:
                self._collect_display_text(value.get(key), chunks)

    @staticmethod
    def _sanitize_text(value: str) -> str:
        return sanitize_assistant_output_text(value)

    @staticmethod
    def _stringify_tool_arguments(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value.strip()
        try:
            return json.dumps(value, ensure_ascii=False)
        except Exception:
            return str(value).strip()
