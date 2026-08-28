"""AstrBot event wrapper for the AG99live desktop frontend."""

from __future__ import annotations

import inspect
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent

from .core_compatibility import get_prompt_annotation_capabilities


class OLVPetPlatformEvent(AstrMessageEvent):
    """Message event that sends AstrBot replies back to the desktop frontend."""

    def __init__(self, message_str, message_obj, platform_meta, session_id, adapter):
        super().__init__(message_str, message_obj, platform_meta, session_id)
        self.adapter = adapter
        self._standard_output_platform_extras = {
            "logical_message_id": "standard_reply",
        }
        self._attach_prompt_annotations(message_obj=message_obj)

    async def send(self, message):
        await self.send_message_with_extras(message)

    async def send_message_with_extras(
        self,
        message,
        *,
        platform_extras: dict[str, Any] | None = None,
        record_send_operation: bool = True,
    ) -> None:
        turn_id = str(self.get_extra("output_correlation_id", "") or "").strip()
        if not turn_id:
            raise RuntimeError("output_event_turn_id_missing")
        if self._is_stop_requested():
            logger.info(
                "Discarded late output from interrupted AG99live turn: turn_id=%s",
                turn_id,
            )
            return
        previous_has_send_oper = self._has_send_oper
        resolved_platform_extras = dict(platform_extras or {})
        if not any(
            key in resolved_platform_extras
            for key in (
                "output_segment",
                "logical_message_id",
                "visible_message_id",
                "message_id",
            )
        ):
            resolved_platform_extras.update(self._standard_output_platform_extras)
        if bool(self.get_extra("_ag99live_official_inline_motion_expected", False)):
            metadata = resolved_platform_extras.get("metadata")
            resolved_metadata = dict(metadata) if isinstance(metadata, dict) else {}
            resolved_metadata.setdefault(
                "ag99live_motion_schedule",
                {
                    "scheduled": True,
                    "source": "official_inline_anim_compat",
                    "reason": "official_core_inline_motion_requested",
                },
            )
            resolved_platform_extras["metadata"] = resolved_metadata
        await self.adapter.emit_message_chain(
            message_chain=message,
            turn_id=turn_id,
            unified_msg_origin=self.unified_msg_origin,
            raw_reply_text_override=str(self.get_extra("ag99live_raw_reply_text", "") or "").strip()
            or None,
            platform_extras=resolved_platform_extras,
        )
        if not record_send_operation:
            self._has_send_oper = previous_has_send_oper
        else:
            record_send = getattr(self, "_record_send_operation", None)
            if callable(record_send):
                await record_send()
            else:
                await super().send(message)

    async def complete_visible_turn(self) -> None:
        if self._is_stop_requested():
            return
        base_complete = getattr(super(), "complete_visible_turn", None)
        if callable(base_complete):
            result = base_complete()
            if inspect.isawaitable(result):
                await result
        await self._close_frontend_turn_output_queue()

    async def _close_frontend_turn_output_queue(self) -> None:
        turn_id = str(self.get_extra("output_correlation_id", "") or "").strip()
        if not turn_id:
            raise RuntimeError("output_event_turn_id_missing")
        turn_coordinator = getattr(self.adapter, "turn_coordinator", None)
        close_queue = getattr(turn_coordinator, "close_turn_output_queue", None)
        if callable(close_queue):
            await close_queue(turn_id=turn_id)

    def _is_stop_requested(self) -> bool:
        return bool(self.get_extra("agent_stop_requested", False))

    def _attach_prompt_annotations(self, *, message_obj: Any) -> None:
        capabilities = get_prompt_annotation_capabilities()
        annotations: dict[str, dict[str, str]] = {
            capabilities.input_text_annotation_key: {
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
        if isinstance(components, list) and callable(
            capabilities.build_message_annotation_key
        ):
            for index, component in enumerate(components):
                if index not in desktop_snapshot_indexes:
                    continue
                component_type = str(type(component).__name__).lower()
                if component_type != "image":
                    continue
                annotations[capabilities.build_message_annotation_key(index)] = {
                    "semantic_type": "desktop_snapshot",
                    "explanation": (
                        "This image is an optional desktop snapshot captured around the same turn."
                    ),
                    "explanation_source": "platform",
                    "context_role": "supporting",
                }

        self.set_extra(capabilities.input_item_annotations_extra_key, annotations)


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
