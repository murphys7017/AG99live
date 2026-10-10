"""AstrBot event wrapper for the AG99live desktop frontend."""

from __future__ import annotations

import inspect
from copy import copy
from typing import Any, Protocol

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent

from .core_compatibility import get_prompt_annotation_capabilities
from .motion.output_sanitizer import (
    sanitize_assistant_output_segment_text,
)
from .runtime.message_utils import resolve_platform_segment_message_id


class OutputSegmentDeliveryPort(Protocol):
    async def finalize_output_segment(self, *, turn_id: str, message_id: str) -> None: ...

    def has_pending_persona_segment(self, *, turn_id: str, message_id: str) -> bool: ...

    async def close_turn_output_queue(self, *, turn_id: str) -> None: ...

    async def abort_turn_from_backend(self, *, turn_id: str, reason: str) -> int: ...


class PlatformEventAdapterPort(Protocol):
    turn_coordinator: OutputSegmentDeliveryPort

    async def emit_message_chain(self, **kwargs: Any) -> None: ...


class OLVPetPlatformEvent(AstrMessageEvent):
    """Message event that sends AstrBot replies back to the desktop frontend."""

    def __init__(
        self,
        message_str,
        message_obj,
        platform_meta,
        session_id,
        adapter: PlatformEventAdapterPort,
    ):
        super().__init__(message_str, message_obj, platform_meta, session_id)
        self.adapter = adapter
        runtime_state = getattr(adapter, "runtime_state", None)
        if bool(getattr(runtime_state, "independent_motion_enabled", False)):
            per_speech_segment = bool(
                getattr(
                    runtime_state,
                    "independent_motion_per_speech_segment",
                    False,
                )
            )
            self.set_extra(
                "_interaction_plugin_runtime_target_overrides",
                {
                    "astrbot_plugin_ag99live_adapter": (
                        "personal_expression" if per_speech_segment else "core"
                    )
                },
            )
            if not per_speech_segment:
                self.set_extra(
                    "_interaction_core_bypass_requested",
                    "ag99live_independent_motion",
                )
            logger.info(
                "WIRING interaction.independent_motion_route "
                "mode=%s core_bypass=%s plugin_target=%s provider=%s",
                (
                    "per_speech_segment"
                    if per_speech_segment
                    else (
                        "parallel"
                        if bool(
                            getattr(
                                runtime_state,
                                "independent_motion_parallel",
                                False,
                            )
                        )
                        else "serial"
                    )
                ),
                not per_speech_segment,
                "personal_expression" if per_speech_segment else "core",
                getattr(runtime_state, "independent_motion_provider_id", "<missing>"),
            )
        self._standard_output_platform_extras = {
            "logical_message_id": "standard_reply",
        }
        self._direct_output_sequence = 0
        self._logical_segment_indexes: dict[str, int] = {}
        self._next_logical_segment_index = 0
        self._message_children: dict[str, list[str]] = {}
        self._active_persona_delivery_parent: dict[str, str] = {}
        self._persona_segment_delivery_state: dict[str, dict[str, Any]] = {}
        self._attach_prompt_annotations(message_obj=message_obj)

    async def send(self, message):
        self._direct_output_sequence += 1
        message_id = f"direct_output:{self._direct_output_sequence:04d}"
        await self.send_message_with_extras(
            message,
            platform_extras={"logical_message_id": message_id},
        )
        await self.complete_visible_message(message_id=message_id)

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
        split_applied = bool(
            resolved_platform_extras.pop("_ag99live_persona_split_applied", False)
        )
        explicit_parent_id = str(
            resolved_platform_extras.pop("_ag99live_persona_parent_message_id", "")
            or ""
        ).strip()
        raw_text_override = resolved_platform_extras.pop(
            "_ag99live_raw_reply_text_override",
            None,
        )
        has_split_raw_text_override = raw_text_override is not None
        split_raw_text = str(raw_text_override or "")
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

        if not split_applied:
            persona_split, split_failure, tts_failure = self._resolve_persona_text_split(
                message,
                resolved_platform_extras,
                turn_id=turn_id,
            )
            if persona_split is not None:
                parent_message_id = (
                    str(tts_failure["parent_message_id"])
                    if tts_failure is not None
                    else self._resolve_parent_message_id(resolved_platform_extras)
                )
                for segment_index, segment_text, child_message in persona_split:
                    child_message_id = (
                        str(tts_failure["message_id"])
                        if tts_failure is not None
                        and segment_index == tts_failure["segment_index"]
                        else self._persona_child_message_id(parent_message_id, segment_index)
                    )
                    child_extras = dict(resolved_platform_extras)
                    child_extras.pop("persona_speech_segments", None)
                    if tts_failure is not None and segment_index != tts_failure["segment_index"]:
                        for key in (
                            "output_segment",
                            "audio_attachment",
                            "tts_status",
                            "failure_code",
                        ):
                            child_extras.pop(key, None)
                    child_extras.update(
                        {
                            "logical_message_id": child_message_id,
                            "composite_message_id": child_message_id,
                            "persona_segment_index": segment_index,
                            "persona_segment_count": len(persona_split),
                            "semantic_text": segment_text,
                            "_ag99live_persona_split_applied": True,
                            "_ag99live_persona_parent_message_id": parent_message_id,
                            "_ag99live_raw_reply_text_override": segment_text,
                        }
                    )
                    if not segment_text.strip():
                        child_extras["_ag99live_motion_disabled"] = True
                    await self.send_message_with_extras(
                        child_message,
                        platform_extras=child_extras,
                        record_send_operation=False,
                    )
                if record_send_operation:
                    record_send = getattr(self, "_record_send_operation", None)
                    if callable(record_send):
                        await record_send()
                    else:
                        await super().send(message)
                return
            if split_failure:
                auxiliary_parent_id = (
                    self._resolve_persona_tts_auxiliary_parent_id(
                        resolved_platform_extras
                    )
                    if split_failure == "persona_speech_text_boundary_mismatch"
                    and tts_failure is None
                    else ""
                )
                if auxiliary_parent_id:
                    self._prepare_persona_tts_auxiliary_output(
                        resolved_platform_extras,
                        parent_message_id=auxiliary_parent_id,
                    )
                else:
                    self._mark_persona_split_failure(
                        resolved_platform_extras,
                        split_failure,
                    )
                    resolved_platform_extras.pop("persona_speech_segments", None)
        message_id = resolve_platform_segment_message_id(resolved_platform_extras)
        persona_segment = _extract_persona_segment_metadata(resolved_platform_extras)
        active_persona_parent = self._active_persona_delivery_parent.get(turn_id)
        parent_message_id = explicit_parent_id or (
            active_persona_parent
            if persona_segment is not None and active_persona_parent
            else self._resolve_parent_message_id(resolved_platform_extras)
        )
        output_segment = resolved_platform_extras.get("output_segment")
        if persona_segment is not None and isinstance(output_segment, dict):
            await self._emit_missing_persona_tts_segments_before(
                turn_id=turn_id,
                parent_message_id=parent_message_id,
                before_segment_index=persona_segment[0],
                segment_count=persona_segment[1],
                template_extras=resolved_platform_extras,
            )
        grouped_persona_delivery = self._register_active_persona_delivery_parent(
            turn_id=turn_id,
            message_id=message_id,
            platform_extras=resolved_platform_extras,
            explicit_parent=bool(explicit_parent_id),
        )
        if explicit_parent_id:
            self._register_message_child(parent_message_id, message_id)
        elif not grouped_persona_delivery:
            self._register_message_child(parent_message_id, message_id)
        if persona_segment is not None:
            self._remember_persona_segment(
                turn_id=turn_id,
                parent_message_id=parent_message_id,
                segment_index=persona_segment[0],
                segment_count=persona_segment[1],
                template_extras=(
                    resolved_platform_extras
                    if isinstance(output_segment, dict)
                    and isinstance(output_segment.get("tts"), dict)
                    and output_segment["tts"].get("status") == "succeeded"
                    else None
                ),
            )
        sequence = self._logical_segment_indexes.get(message_id)
        if sequence is None:
            sequence = self._allocate_logical_segment_index()
            self._logical_segment_indexes[message_id] = sequence
        resolved_platform_extras["logical_segment_index"] = sequence
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
            raw_reply_text_override=(
                split_raw_text
                if has_split_raw_text_override
                else str(self.get_extra("ag99live_raw_reply_text", "") or "").strip()
            )
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

    async def abort_visible_turn(self, *, reason: str) -> None:
        """Close this frontend turn before a superseding Core turn begins."""
        turn_id = str(self.get_extra("output_correlation_id", "") or "").strip()
        if not turn_id:
            return
        await self.adapter.turn_coordinator.abort_turn_from_backend(
            turn_id=turn_id,
            reason=reason,
        )

    async def complete_visible_message(self, *, message_id: str) -> None:
        """Finalize a Core-delivered logical message without closing its Turn."""
        if self._is_stop_requested():
            return
        turn_id = str(self.get_extra("output_correlation_id", "") or "").strip()
        if not turn_id:
            raise RuntimeError("output_event_turn_id_missing")
        normalized_message_id = str(message_id or "").strip()
        if not normalized_message_id:
            raise RuntimeError("output_event_segment_message_id_missing")
        await self._emit_remaining_persona_tts_segments(
            turn_id=turn_id,
            parent_message_id=normalized_message_id,
        )
        child_message_ids = self._message_children.pop(
            normalized_message_id,
            [normalized_message_id],
        )
        for child_message_id in child_message_ids:
            await self.adapter.turn_coordinator.finalize_output_segment(
                turn_id=turn_id,
                message_id=child_message_id,
            )
        self._active_persona_delivery_parent.pop(turn_id, None)
        self._persona_segment_delivery_state.pop(
            self._persona_delivery_state_key(turn_id, normalized_message_id),
            None,
        )
        self.set_extra("_ag99live_pending_persona_tts_segments", None)
        self.set_extra("_ag99live_persona_tts_segment_map", {})
        self.set_extra("_ag99live_persona_tts_parent_message_id", "")

    async def _close_frontend_turn_output_queue(self) -> None:
        turn_id = str(self.get_extra("output_correlation_id", "") or "").strip()
        if not turn_id:
            raise RuntimeError("output_event_turn_id_missing")
        await self.adapter.turn_coordinator.close_turn_output_queue(turn_id=turn_id)

    def _is_stop_requested(self) -> bool:
        return bool(self.get_extra("agent_stop_requested", False))

    def _allocate_logical_segment_index(self) -> int:
        index = self._next_logical_segment_index
        self._next_logical_segment_index += 1
        return index

    def _resolve_persona_text_split(
        self,
        message: Any,
        platform_extras: dict[str, Any],
        *,
        turn_id: str,
    ) -> tuple[
        list[tuple[int, str, Any]] | None,
        str | None,
        dict[str, Any] | None,
    ]:
        raw_segments = platform_extras.get("persona_speech_segments")
        if raw_segments is None:
            return None, None, None
        if not isinstance(raw_segments, list) or not raw_segments:
            return None, "persona_speech_segments_invalid", None

        tts_failure = self._resolve_persona_tts_failure(platform_extras)
        if (
            ("output_segment" in platform_extras or "audio_attachment" in platform_extras)
            and tts_failure is None
        ):
            return None, None, None

        resolved_segments: list[str] = []
        for segment in raw_segments:
            if not isinstance(segment, str):
                return None, "persona_speech_segment_type_invalid", tts_failure
            resolved_segments.append(segment)
        if (
            tts_failure is not None
            and tts_failure["segment_count"] != len(resolved_segments)
        ):
            return None, "persona_speech_tts_segment_count_mismatch", tts_failure

        visible_segments, visible_speech = _resolve_visible_persona_speech_segments(
            resolved_segments
        )
        if not visible_speech:
            return None, "persona_speech_text_empty", tts_failure

        components = _message_components(message)
        plain_matches = []
        for component_index, component in enumerate(components):
            if not _is_plain_component(component):
                continue
            component_text = str(component.text)
            if component_text.count(visible_speech) == 1:
                plain_matches.append(
                    (component_index, component, component_text.index(visible_speech))
                )
        if len(plain_matches) != 1:
            return None, "persona_speech_text_boundary_mismatch", tts_failure
        plain_index, plain_component, speech_offset = plain_matches[0]
        actual_text = str(plain_component.text)

        parent_message_id = (
            str(tts_failure["parent_message_id"])
            if tts_failure is not None
            else self._resolve_parent_message_id(platform_extras)
        )
        pending_check = getattr(
            self.adapter.turn_coordinator,
            "has_pending_persona_segment",
            None,
        )
        if callable(pending_check) and pending_check(
            turn_id=turn_id,
            message_id=parent_message_id,
        ):
            # tts_dual_output sends one merged Plain after the indexed Record
            # messages. That Plain is an echo and must not create new segments.
            return None, None, None

        split: list[tuple[int, str, Any]] = []
        prefix = actual_text[:speech_offset]
        suffix = actual_text[speech_offset + len(visible_speech) :]
        for segment_index, segment_text in enumerate(visible_segments):
            child_components = []
            for component_index, component in enumerate(components):
                if component_index == plain_index:
                    child_text = segment_text
                    if segment_index == 0:
                        child_text = prefix + child_text
                    if segment_index == len(visible_segments) - 1:
                        child_text += suffix
                    child_components.append(
                        _clone_plain_component(plain_component, child_text)
                    )
                elif component_index < plain_index and segment_index == 0:
                    child_components.append(component)
                elif (
                    component_index > plain_index
                    and segment_index == len(visible_segments) - 1
                ):
                    child_components.append(component)
            split.append(
                (
                    segment_index,
                    segment_text,
                    _derive_message_chain(message, child_components),
                )
            )
        return split, None, tts_failure

    def _resolve_persona_tts_failure(
        self,
        platform_extras: dict[str, Any],
    ) -> dict[str, Any] | None:
        output_segment = platform_extras.get("output_segment")
        tts = output_segment.get("tts") if isinstance(output_segment, dict) else None
        if not isinstance(tts, dict) or str(tts.get("status") or "").strip() != "failed":
            return None
        message_id = str(tts.get("message_id") or "").strip()
        raw_mapping = self.get_extra("_ag99live_persona_tts_segment_map", {})
        mapping = raw_mapping if isinstance(raw_mapping, dict) else {}
        tracked = mapping.get(message_id)
        if not isinstance(tracked, dict):
            return None
        segment_index = tracked.get("segment_index")
        segment_count = tracked.get("segment_count")
        if (
            isinstance(segment_index, bool)
            or not isinstance(segment_index, int)
            or isinstance(segment_count, bool)
            or not isinstance(segment_count, int)
        ):
            return None
        if segment_index < 0 or segment_index >= segment_count or not message_id:
            return None
        parent_message_id = str(tracked.get("parent_message_id") or "").strip()
        if not parent_message_id:
            return None
        return {
            "message_id": message_id,
            "parent_message_id": parent_message_id,
            "segment_index": segment_index,
            "segment_count": segment_count,
        }

    def _resolve_parent_message_id(self, platform_extras: dict[str, Any]) -> str:
        for key in (
            "_ag99live_persona_parent_message_id",
            "composite_message_id",
            "logical_message_id",
            "visible_message_id",
            "message_id",
        ):
            value = platform_extras.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return resolve_platform_segment_message_id(platform_extras)

    def _resolve_persona_tts_auxiliary_parent_id(
        self,
        platform_extras: dict[str, Any],
    ) -> str:
        if "output_segment" in platform_extras or "audio_attachment" in platform_extras:
            return ""
        try:
            message_id = resolve_platform_segment_message_id(platform_extras)
        except ValueError:
            return ""
        raw_mapping = self.get_extra("_ag99live_persona_tts_segment_map", {})
        mapping = raw_mapping if isinstance(raw_mapping, dict) else {}
        tracked = mapping.get(message_id)
        if not isinstance(tracked, dict):
            return ""
        segment_index = tracked.get("segment_index")
        segment_count = tracked.get("segment_count")
        if (
            type(segment_index) is not int
            or type(segment_count) is not int
            or segment_index < 0
            or segment_index >= segment_count
        ):
            return ""
        if str(tracked.get("parent_message_id") or "").strip() != message_id:
            return ""
        return message_id

    @staticmethod
    def _prepare_persona_tts_auxiliary_output(
        platform_extras: dict[str, Any],
        *,
        parent_message_id: str,
    ) -> None:
        visible_message_id = str(
            platform_extras.get("visible_message_id") or ""
        ).strip()
        auxiliary_message_id = (
            visible_message_id
            if visible_message_id and visible_message_id != parent_message_id
            else f"{parent_message_id}::persona_auxiliary"
        )
        platform_extras["logical_message_id"] = auxiliary_message_id
        platform_extras["composite_message_id"] = auxiliary_message_id
        platform_extras["_ag99live_persona_parent_message_id"] = parent_message_id
        platform_extras["_ag99live_motion_disabled"] = True
        platform_extras.pop("persona_speech_segments", None)
        platform_extras.pop("persona_segment_index", None)
        platform_extras.pop("persona_segment_count", None)
        platform_extras.pop("semantic_text", None)

        client_objects = platform_extras.get("client_objects")
        if isinstance(client_objects, list):
            platform_extras["client_objects"] = [
                candidate
                for candidate in client_objects
                if not (
                    isinstance(candidate, dict)
                    and str(candidate.get("type") or "").strip()
                    == "ag99live.motion_payload"
                )
            ]
        metadata = platform_extras.get("metadata")
        if isinstance(metadata, dict):
            resolved_metadata = dict(metadata)
            resolved_metadata.pop("ag99live_motion_schedule", None)
            platform_extras["metadata"] = resolved_metadata

    @staticmethod
    def _persona_child_message_id(parent_message_id: str, segment_index: int) -> str:
        return f"{parent_message_id}::persona::{segment_index:04d}"

    def _register_message_child(self, parent_message_id: str, message_id: str) -> None:
        children = self._message_children.setdefault(parent_message_id, [])
        if message_id not in children:
            children.append(message_id)

    @staticmethod
    def _persona_delivery_state_key(turn_id: str, parent_message_id: str) -> str:
        return f"{turn_id}|{parent_message_id}"

    def _remember_persona_segment(
        self,
        *,
        turn_id: str,
        parent_message_id: str,
        segment_index: int,
        segment_count: int,
        template_extras: dict[str, Any] | None,
    ) -> None:
        key = self._persona_delivery_state_key(turn_id, parent_message_id)
        state = self._persona_segment_delivery_state.setdefault(
            key,
            {"segment_count": segment_count, "indexes": set(), "template": None},
        )
        if state["segment_count"] != segment_count:
            raise RuntimeError("persona_segment_count_conflict")
        state["indexes"].add(segment_index)
        if template_extras is not None:
            template = dict(template_extras)
            for field in (
                "output_segment",
                "audio_attachment",
                "tts_status",
                "failure_code",
                "persona_speech_segments",
                "logical_message_id",
                "composite_message_id",
                "visible_message_id",
                "message_id",
                "persona_segment_index",
                "persona_segment_count",
                "semantic_text",
            ):
                template.pop(field, None)
            state["template"] = template

    async def _emit_missing_persona_tts_segments_before(
        self,
        *,
        turn_id: str,
        parent_message_id: str,
        before_segment_index: int,
        segment_count: int,
        template_extras: dict[str, Any],
    ) -> None:
        key = self._persona_delivery_state_key(turn_id, parent_message_id)
        state = self._persona_segment_delivery_state.get(key)
        if state is not None and state["segment_count"] != segment_count:
            raise RuntimeError("persona_segment_count_conflict")
        seen = state["indexes"] if state is not None else set()
        for segment_index in range(before_segment_index):
            if segment_index in seen:
                continue
            await self._emit_persona_motion_only_segment(
                turn_id=turn_id,
                parent_message_id=parent_message_id,
                segment_index=segment_index,
                segment_count=segment_count,
                template_extras=template_extras,
            )

    async def _emit_remaining_persona_tts_segments(
        self,
        *,
        turn_id: str,
        parent_message_id: str,
    ) -> None:
        key = self._persona_delivery_state_key(turn_id, parent_message_id)
        state = self._persona_segment_delivery_state.get(key)
        if not isinstance(state, dict) or not isinstance(state.get("template"), dict):
            return
        segment_count = state.get("segment_count")
        seen = state.get("indexes")
        if not isinstance(segment_count, int) or not isinstance(seen, set):
            return
        for segment_index in range(segment_count):
            if segment_index in seen:
                continue
            await self._emit_persona_motion_only_segment(
                turn_id=turn_id,
                parent_message_id=parent_message_id,
                segment_index=segment_index,
                segment_count=segment_count,
                template_extras=state["template"],
            )

    async def _emit_persona_motion_only_segment(
        self,
        *,
        turn_id: str,
        parent_message_id: str,
        segment_index: int,
        segment_count: int,
        template_extras: dict[str, Any],
    ) -> None:
        message_id = self._persona_child_message_id(
            parent_message_id,
            segment_index,
        )
        child_extras = dict(template_extras)
        for key in (
            "output_segment",
            "audio_attachment",
            "tts_status",
            "failure_code",
        ):
            child_extras.pop(key, None)
        child_extras.update(
            {
                "logical_message_id": message_id,
                "composite_message_id": message_id,
                "persona_segment_index": segment_index,
                "persona_segment_count": segment_count,
                "semantic_text": "",
                "_ag99live_persona_split_applied": True,
                "_ag99live_persona_parent_message_id": parent_message_id,
                "_ag99live_raw_reply_text_override": "",
            }
        )
        empty_segment_indexes = child_extras.get("persona_speech_empty_indexes")
        if (
            isinstance(empty_segment_indexes, (list, tuple))
            and segment_index in empty_segment_indexes
        ):
            child_extras["_ag99live_motion_disabled"] = True
        await self.send_message_with_extras(
            [],
            platform_extras=child_extras,
            record_send_operation=False,
        )

    def _register_active_persona_delivery_parent(
        self,
        *,
        turn_id: str,
        message_id: str,
        platform_extras: dict[str, Any],
        explicit_parent: bool,
    ) -> bool:
        if explicit_parent:
            return True
        index = platform_extras.get("persona_segment_index")
        count = platform_extras.get("persona_segment_count")
        if (
            isinstance(index, bool)
            or not isinstance(index, int)
            or isinstance(count, bool)
            or not isinstance(count, int)
            or index < 0
            or count <= 0
        ):
            return False
        active_parent = self._active_persona_delivery_parent.get(turn_id)
        if index == 0 or active_parent is None:
            self._active_persona_delivery_parent[turn_id] = message_id
            self._register_message_child(message_id, message_id)
            return True
        self._register_message_child(active_parent, message_id)
        return True

    def _mark_persona_split_failure(
        self,
        platform_extras: dict[str, Any],
        reason: str,
    ) -> None:
        metadata = platform_extras.get("metadata")
        if not isinstance(metadata, dict):
            return
        schedule = metadata.get("ag99live_motion_schedule")
        if not isinstance(schedule, dict):
            return
        resolved_schedule = dict(schedule)
        resolved_schedule["motion_resolution_reason"] = (
            f"persona_text_segmentation_failed:{reason}"
        )
        resolved_metadata = dict(metadata)
        resolved_metadata["ag99live_motion_schedule"] = resolved_schedule
        platform_extras["metadata"] = resolved_metadata

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


def _message_components(message: Any) -> list[Any]:
    if hasattr(message, "chain") and isinstance(message.chain, list):
        return list(message.chain)
    if isinstance(message, list):
        return list(message)
    return [message]


def _is_plain_component(component: Any) -> bool:
    return (
        component is not None
        and type(component).__name__ == "Plain"
        and isinstance(getattr(component, "text", None), str)
    )


def _clone_plain_component(component: Any, text: str) -> Any:
    model_copy = getattr(component, "model_copy", None)
    if callable(model_copy):
        return model_copy(update={"text": text}, deep=True)
    copy_method = getattr(component, "copy", None)
    if callable(copy_method):
        try:
            return copy_method(update={"text": text}, deep=True)
        except TypeError:
            return copy_method(update={"text": text})
    try:
        cloned = copy(component)
        cloned.text = text
        return cloned
    except Exception:  # noqa: BLE001
        return type(component)(text)


def _derive_message_chain(message: Any, components: list[Any]) -> Any:
    derive = getattr(message, "derive", None)
    if callable(derive):
        return derive(components)
    return components


def _extract_persona_segment_metadata(
    platform_extras: dict[str, Any],
) -> tuple[int, int] | None:
    index = platform_extras.get("persona_segment_index")
    count = platform_extras.get("persona_segment_count")
    if isinstance(index, bool) or not isinstance(index, int):
        return None
    if isinstance(count, bool) or not isinstance(count, int):
        return None
    if index < 0 or count <= 0 or index >= count:
        return None
    return index, count


def _resolve_visible_persona_speech_segments(
    raw_segments: list[str],
) -> tuple[list[str], str]:
    visible_segments = [
        sanitize_assistant_output_segment_text(segment)
        for segment in raw_segments
    ]
    combined_segment_text = "".join(visible_segments)
    combined_sanitized_text = sanitize_assistant_output_segment_text(
        "".join(raw_segments)
    )
    if combined_segment_text != combined_sanitized_text:
        return visible_segments, ""

    visible_speech = combined_sanitized_text.strip()
    if not visible_speech:
        return ["" for _ in visible_segments], ""

    leading_whitespace = len(combined_segment_text) - len(
        combined_segment_text.lstrip()
    )
    trailing_whitespace = len(combined_segment_text) - len(
        combined_segment_text.rstrip()
    )
    for index in range(len(visible_segments)):
        if not leading_whitespace:
            break
        trim_count = min(leading_whitespace, len(visible_segments[index]))
        visible_segments[index] = visible_segments[index][trim_count:]
        leading_whitespace -= trim_count
    for index in range(len(visible_segments) - 1, -1, -1):
        if not trailing_whitespace:
            break
        trim_count = min(trailing_whitespace, len(visible_segments[index]))
        if trim_count:
            visible_segments[index] = visible_segments[index][:-trim_count]
        trailing_whitespace -= trim_count

    if "".join(visible_segments) != visible_speech:
        return visible_segments, ""
    return visible_segments, visible_speech


def _resolve_desktop_snapshot_component_indexes(message_obj: Any) -> set[int]:
    raw_message = getattr(message_obj, "raw_message", None)
    if not isinstance(raw_message, dict):
        return set()

    cached_indexes = raw_message.get("desktop_snapshot_component_indexes")
    if isinstance(cached_indexes, list):
        return {
            index
            for index in cached_indexes
            if isinstance(index, int) and index >= 0
        }

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
