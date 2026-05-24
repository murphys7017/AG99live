"""AstrBot event wrapper for the AG99live desktop frontend."""

from __future__ import annotations

import inspect
from typing import Any

from astrbot.api.event import AstrMessageEvent

try:
    from astrbot.core.prompt import (
        INPUT_ITEM_ANNOTATIONS_EXTRA_KEY,
        INPUT_TEXT_ANNOTATION_KEY,
        build_message_annotation_key,
    )
except Exception:
    INPUT_ITEM_ANNOTATIONS_EXTRA_KEY = "prompt_input_item_annotations"
    INPUT_TEXT_ANNOTATION_KEY = "input.text"
    build_message_annotation_key = None


class OLVPetPlatformEvent(AstrMessageEvent):
    """Message event that sends AstrBot replies back to the desktop frontend."""

    def __init__(self, message_str, message_obj, platform_meta, session_id, adapter):
        super().__init__(message_str, message_obj, platform_meta, session_id)
        self.adapter = adapter
        self._attach_prompt_annotations(message_obj=message_obj)

    async def send(self, message):
        await self.adapter.emit_message_chain(
            message_chain=message,
            unified_msg_origin=self.unified_msg_origin,
            raw_reply_text_override=str(self.get_extra("ag99live_raw_reply_text", "") or "").strip()
            or None,
        )
        await super().send(message)
        await self._close_frontend_turn_output_queue()

    async def send_interaction_message(
        self,
        message,
        *,
        platform_extras: dict[str, Any] | None = None,
        record_send_operation: bool = True,
    ) -> None:
        previous_has_send_oper = self._has_send_oper
        await self.adapter.emit_message_chain(
            message_chain=message,
            unified_msg_origin=self.unified_msg_origin,
            raw_reply_text_override=str(self.get_extra("ag99live_raw_reply_text", "") or "").strip()
            or None,
            platform_extras=platform_extras,
        )
        await super().send(message)
        if not record_send_operation:
            self._has_send_oper = previous_has_send_oper

    async def complete_visible_turn(self) -> None:
        base_complete = getattr(super(), "complete_visible_turn", None)
        if callable(base_complete):
            result = base_complete()
            if inspect.isawaitable(result):
                await result
        await self._close_frontend_turn_output_queue()

    async def _close_frontend_turn_output_queue(self) -> None:
        turn_coordinator = getattr(self.adapter, "turn_coordinator", None)
        close_queue = getattr(turn_coordinator, "close_turn_output_queue", None)
        if callable(close_queue):
            await close_queue()

    def _attach_prompt_annotations(self, *, message_obj: Any) -> None:
        annotations: dict[str, dict[str, str]] = {
            INPUT_TEXT_ANNOTATION_KEY: {
                "semantic_type": "desktop_chat_turn",
                "explanation": (
                    "This text comes from AG99live desktop real-time chat and should be "
                    "interpreted as the current user turn."
                ),
                "explanation_source": "platform",
                "context_role": "primary",
            }
        }

        desktop_snapshot_indexes = _resolve_desktop_snapshot_component_indexes(message_obj)
        components = getattr(message_obj, "message", [])
        if isinstance(components, list) and callable(build_message_annotation_key):
            for index, component in enumerate(components):
                if index not in desktop_snapshot_indexes:
                    continue
                component_type = str(type(component).__name__).lower()
                if component_type != "image":
                    continue
                annotations[build_message_annotation_key(index)] = {
                    "semantic_type": "desktop_snapshot",
                    "explanation": (
                        "This image is an optional desktop snapshot captured around the same turn."
                    ),
                    "explanation_source": "platform",
                    "context_role": "supporting",
                }

        self.set_extra(INPUT_ITEM_ANNOTATIONS_EXTRA_KEY, annotations)


def _resolve_desktop_snapshot_component_indexes(message_obj: Any) -> set[int]:
    raw_message = getattr(message_obj, "raw_message", None)
    if not isinstance(raw_message, dict):
        return set()

    payload = raw_message.get("payload")
    if not isinstance(payload, dict):
        return set()

    images = payload.get("images")
    if not isinstance(images, list):
        return set()

    indexes: set[int] = set()
    component_index = 1
    for image in images:
        if isinstance(image, dict) and str(image.get("source") or "").strip() == "screen":
            indexes.add(component_index)
        component_index += 1
    return indexes
