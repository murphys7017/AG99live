"""AstrBot event wrapper for the AG99live desktop frontend."""

from __future__ import annotations

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
        )
        await super().send(message)

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

        components = getattr(message_obj, "message", [])
        if isinstance(components, list) and callable(build_message_annotation_key):
            for index, component in enumerate(components):
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
