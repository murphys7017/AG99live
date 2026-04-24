from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from astrbot.api import logger
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.platform.message_type import MessageType

INLINE_ANIM_TAG_PATTERN = re.compile(r"<@anim\s*\{[\s\S]*?\}>\s*", re.IGNORECASE)
LEGACY_EXPRESSION_TAG_PATTERN = re.compile(r"<~[^~]*~>\s*", re.IGNORECASE)
SYSTEM_REMINDER_PATTERN = re.compile(
    r"<system_reminder>[\s\S]*?</system_reminder>",
    re.IGNORECASE,
)


class ConversationHistoryBridge:
    """Bridge AstrBot conversation history to the desktop frontend format."""

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

    def set_client_uid(self, client_uid: str) -> None:
        self._client_uid = client_uid

    async def list_histories(self) -> list[dict[str, Any]]:
        conv_mgr = self._get_conversation_manager()
        if conv_mgr is None:
            return []

        conversations = await conv_mgr.get_conversations(
            unified_msg_origin=self._build_unified_msg_origin(),
            platform_id=self._platform_id,
        )
        histories: list[dict[str, Any]] = []
        for conversation in conversations:
            messages = self._conversation_to_frontend_messages(conversation)
            latest_message = self._pick_latest_text_message(messages)
            if latest_message is None:
                continue
            histories.append(
                {
                    "uid": conversation.cid,
                    "latest_message": latest_message,
                    "timestamp": latest_message["timestamp"],
                }
            )

        histories.sort(key=lambda item: item.get("timestamp") or "", reverse=True)
        return histories

    async def fetch_history(self, history_uid: str) -> list[dict[str, Any]]:
        conv_mgr = self._get_conversation_manager()
        if conv_mgr is None or not history_uid:
            self._sync_chat_buffer([])
            return []

        umo = self._build_unified_msg_origin()
        await conv_mgr.switch_conversation(umo, history_uid)
        conversation = await conv_mgr.get_conversation(
            unified_msg_origin=umo,
            conversation_id=history_uid,
        )
        messages = self._conversation_to_frontend_messages(conversation)
        self._sync_chat_buffer(messages)
        return messages

    async def create_history(self) -> str | None:
        conv_mgr = self._get_conversation_manager()
        if conv_mgr is None:
            return None

        history_uid = await conv_mgr.new_conversation(
            self._build_unified_msg_origin(),
            platform_id=self._platform_id,
        )
        self._sync_chat_buffer([])
        return history_uid

    async def delete_history(self, history_uid: str) -> bool:
        conv_mgr = self._get_conversation_manager()
        if conv_mgr is None or not history_uid:
            return False

        umo = self._build_unified_msg_origin()
        try:
            await conv_mgr.delete_conversation(
                unified_msg_origin=umo,
                conversation_id=history_uid,
            )
        except Exception as exc:
            logger.warning("Failed to delete conversation `%s`: %s", history_uid, exc)
            return False

        current_cid = await conv_mgr.get_curr_conversation_id(umo)
        if not current_cid:
            remaining = await conv_mgr.get_conversations(
                unified_msg_origin=umo,
                platform_id=self._platform_id,
            )
            if remaining:
                current_cid = remaining[0].cid
                await conv_mgr.switch_conversation(umo, current_cid)

        if not current_cid:
            self._sync_chat_buffer([])
            return True

        conversation = await conv_mgr.get_conversation(
            unified_msg_origin=umo,
            conversation_id=current_cid,
        )
        self._sync_chat_buffer(self._conversation_to_frontend_messages(conversation))
        return True

    def _get_conversation_manager(self) -> Any | None:
        context = self._plugin_context
        if context is None:
            logger.warning("Plugin context is unavailable, skip conversation history bridge.")
            return None

        conv_mgr = getattr(context, "conversation_manager", None)
        if conv_mgr is None:
            logger.warning("Conversation manager is unavailable on plugin context.")
            return None
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
            return [item for item in history_value if isinstance(item, dict)]
        if not isinstance(history_value, str) or not history_value.strip():
            return []

        try:
            parsed = json.loads(history_value)
        except Exception:
            logger.warning("Failed to parse conversation history JSON.")
            return []

        if not isinstance(parsed, list):
            return []
        return [item for item in parsed if isinstance(item, dict)]

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
    def _resolve_anchor_time(conversation: Any) -> datetime:
        updated_at = getattr(conversation, "updated_at", 0) or 0
        created_at = getattr(conversation, "created_at", 0) or 0
        timestamp = updated_at or created_at
        if isinstance(timestamp, (int, float)) and timestamp > 0:
            try:
                return datetime.fromtimestamp(timestamp, tz=timezone.utc)
            except Exception:
                pass
        return datetime.now(timezone.utc)

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
        text = SYSTEM_REMINDER_PATTERN.sub("", value or "")
        text = INLINE_ANIM_TAG_PATTERN.sub("", text)
        text = LEGACY_EXPRESSION_TAG_PATTERN.sub("", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()

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
