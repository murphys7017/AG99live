"""AstrBot event wrapper for the AG99live desktop frontend."""

from __future__ import annotations

import asyncio
import inspect
import math
from copy import copy
from dataclasses import dataclass, field
from typing import Any, Protocol

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent

from .core_compatibility import get_prompt_annotation_capabilities
from .motion.observation import resolve_persona_motion_source_route
from .motion.output_sanitizer import (
    sanitize_assistant_output_segment_text,
)
from .runtime.message_utils import resolve_platform_segment_message_id
from .runtime.persona_lifecycle import (
    PersonaResultState,
    PersonaSegmentIdentity,
    PersonaTurnIdentity,
)

ACTION_ONLY_MOTION_ACK_TIMEOUT_SECONDS = 30.0


@dataclass(slots=True)
class _AdapterEventInternalState:
    """Adapter-owned state mirrored to AstrBot extras only at the boundary."""

    plugin_runtime_target_overrides: dict[str, str] = field(default_factory=dict)
    persona_segment_stream_requested: bool = False
    incremental_output_requested: bool = False
    wait_for_motion_execution_ack: bool = False
    incremental_motion_states: dict[str, Any] = field(default_factory=dict)
    core_turn_id: str = ""
    delivery_turn_id: str = ""
    agent_stop_requested: bool = False
    raw_reply_text: str = ""

    def observe_extra(self, key: str, value: Any) -> None:
        if key == "_interaction_plugin_runtime_target_overrides":
            self.plugin_runtime_target_overrides = (
                dict(value) if isinstance(value, dict) else {}
            )
        elif key == "_interaction_persona_segment_stream_requested":
            self.persona_segment_stream_requested = value is True
        elif key == "_interaction_incremental_output_requested":
            self.incremental_output_requested = value is True
        elif key == "_interaction_wait_for_motion_execution_ack":
            self.wait_for_motion_execution_ack = value is True
        elif key == "_interaction_incremental_motion_states":
            self.incremental_motion_states = (
                dict(value) if isinstance(value, dict) else {}
            )
        elif key == "_turn_id":
            self.core_turn_id = str(value or "").strip()
        elif key == "output_correlation_id":
            self.delivery_turn_id = str(value or "").strip()
        elif key == "agent_stop_requested":
            self.agent_stop_requested = value is True
        elif key == "ag99live_raw_reply_text":
            self.raw_reply_text = str(value or "")


class OutputSegmentDeliveryPort(Protocol):
    async def finalize_output_segment(self, *, turn_id: str, message_id: str) -> None: ...

    def has_pending_persona_segment(self, *, turn_id: str, message_id: str) -> bool: ...

    async def close_turn_output_queue(
        self, *, turn_id: str, failure_reason: str | None = None
    ) -> None: ...

    async def abort_turn_from_backend(self, *, turn_id: str, reason: str) -> int: ...


class PlatformEventAdapterPort(Protocol):
    turn_coordinator: OutputSegmentDeliveryPort

    async def emit_message_chain(self, **kwargs: Any) -> None: ...

    async def open_incremental_output(self, *, event: Any, persona_result_id: str) -> Any: ...

    async def discard_incremental_output(
        self, *, event: Any, persona_result_id: str
    ) -> bool: ...


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
        self._adapter_internal_state = _AdapterEventInternalState()
        super().__init__(message_str, message_obj, platform_meta, session_id)
        self.adapter = adapter
        runtime_state = getattr(adapter, "runtime_state", None)
        source_route = resolve_persona_motion_source_route(
            self,
            runtime_state,
            capture_if_missing=True,
        )
        independent_motion_enabled = source_route == "independent_motion"
        if bool(getattr(runtime_state, "fast_asr_enabled", False)):
            raw_message = getattr(message_obj, "raw_message", None)
            raw_payload = (
                raw_message.get("payload", {})
                if isinstance(raw_message, dict)
                else {}
            )
            review_turn_id = (
                str(raw_message.get("turn_id") or "").strip()
                if isinstance(raw_message, dict)
                else ""
            )
            if review_turn_id and isinstance(raw_payload, dict) and raw_payload.get("stream_id"):
                speech_ingress = getattr(
                    getattr(getattr(adapter, "turn_coordinator", None), "speech_ingress", None),
                    "review_audio_for_turn",
                    None,
                )
                if callable(speech_ingress):
                    async def review_handoff_audio() -> str | None:
                        return await speech_ingress(review_turn_id)

                    self.set_extra(
                        "_ag99live_handoff_asr_review",
                        review_handoff_audio,
                    )
        persona_segment_stream_enabled = (
            getattr(adapter, "desktop_persona_segment_stream_enabled", False) is True
        )
        if independent_motion_enabled:
            self.set_extra(
                "_interaction_plugin_runtime_target_overrides",
                {"astrbot_plugin_ag99live_adapter": "personal_expression"},
            )
            logger.info(
                "WIRING interaction.independent_motion_route "
                "mode=persona_speech_segment core_bypass=false "
                "plugin_target=personal_expression provider=%s "
                "persona_segment_stream_enabled=%s",
                getattr(runtime_state, "independent_motion_provider_id", "<missing>"),
                persona_segment_stream_enabled,
            )
        if persona_segment_stream_enabled:
            gate_failure = None
            if not independent_motion_enabled:
                gate_failure = "independent_motion_disabled"
            elif not bool(
                getattr(runtime_state, "interaction_result_event_filter_available", False)
            ):
                gate_failure = "result_event_filter_unavailable"
            elif not bool(
                getattr(runtime_state, "persona_segment_stream_hooks_available", False)
            ):
                gate_failure = "persona_segment_stream_hooks_unavailable"
            if gate_failure:
                logger.warning(
                    "WIRING interaction.persona_segment_stream_request_skipped "
                    "reason=%s",
                    gate_failure,
                )
            else:
                self.set_extra(
                    "_interaction_persona_segment_stream_requested",
                    True,
                )
                # The Core producer may opt into the connection-bound
                # incremental writer. Keep this separate from the existing
                # segment-stream gate so older Core builds can still fall back.
                self.set_extra(
                    "_interaction_incremental_output_requested",
                    True,
                )
                logger.info(
                    "WIRING interaction.persona_segment_stream_requested "
                    "independent_motion=true"
                )
        self._standard_output_platform_extras = {
            "logical_message_id": "standard_reply",
        }
        self._direct_output_sequence = 0
        self._logical_segment_indexes: dict[str, int] = {}
        self._next_logical_segment_index = 0
        self._attach_prompt_annotations(message_obj=message_obj)

    def set_extra(self, key: str, value: Any) -> None:
        super().set_extra(key, value)
        self._adapter_internal_state.observe_extra(key, value)

    async def send(self, message):
        self._direct_output_sequence += 1
        message_id = f"direct_output:{self._direct_output_sequence:04d}"
        await self.send_message_with_extras(
            message,
            platform_extras={"logical_message_id": message_id},
        )
        await self.complete_visible_message(message_id=message_id)

    async def open_interaction_incremental_output(self, *, persona_result_id: str):
        """Core producer entry; opt-in remains unavailable until full negotiation."""
        if not self._adapter_internal_state.incremental_output_requested:
            raise RuntimeError("incremental_output_not_negotiated")
        if self._is_stop_requested():
            raise asyncio.CancelledError
        writer = await self.adapter.open_incremental_output(
            event=self, persona_result_id=persona_result_id,
        )
        self.adapter.runtime_state.persona_sessions.register_writer(
            PersonaTurnIdentity(self._adapter_internal_state.core_turn_id),
            persona_result_id,
            writer,
        )
        return writer

    async def discard_interaction_incremental_output(
        self, *, persona_result_id: str
    ) -> bool:
        """Drop a payloadless incremental writer so Core can fall back."""
        discarded = await self.adapter.discard_incremental_output(
            event=self,
            persona_result_id=persona_result_id,
        )
        if not discarded:
            return False
        result = self._persona_result_state(persona_result_id)
        if result is not None:
            result.writer = None
            result.delivery_mode = None
        session = self._persona_session()
        normalized_result_id = str(persona_result_id or "").strip()
        if session is not None and session.active_result_id == normalized_result_id:
            session.active_result_id = next(
                (
                    candidate.persona_result_id
                    for candidate in session.results.values()
                    if candidate.writer is not None
                    and candidate.persona_result_id != normalized_result_id
                ),
                None,
            )
        return True

    def _persona_result_state(self, persona_result_id: str | None = None):
        sessions = self.adapter.runtime_state.persona_sessions
        turn_id = self._adapter_internal_state.core_turn_id
        if not turn_id:
            return None
        normalized_result_id = str(persona_result_id or "").strip()
        return (
            sessions.get_result(
                PersonaTurnIdentity(turn_id), normalized_result_id
            )
            if normalized_result_id
            else sessions.get_active_result(PersonaTurnIdentity(turn_id))
        )

    def _persona_session(self):
        runtime_state = getattr(self.adapter, "runtime_state", None)
        sessions = getattr(runtime_state, "persona_sessions", None)
        if sessions is None:
            return None
        turn_id = str(
            self._adapter_internal_state.core_turn_id
            or self._adapter_internal_state.delivery_turn_id
            or ""
        ).strip()
        if not turn_id:
            return None
        return sessions.session(PersonaTurnIdentity(turn_id))

    def _persona_delivery_result(
        self,
        *,
        parent_message_id: str,
        persona_result_id: str | None = None,
        create: bool = False,
    ) -> PersonaResultState | None:
        runtime_state = getattr(self.adapter, "runtime_state", None)
        sessions = getattr(runtime_state, "persona_sessions", None)
        if sessions is None:
            return None
        core_turn_id = self._adapter_internal_state.core_turn_id
        if not core_turn_id:
            return None
        identity = PersonaTurnIdentity(core_turn_id)
        session = (
            sessions.session(identity)
            if create
            else sessions.get_session(identity)
        )
        if session is None:
            return None
        normalized_result_id = str(persona_result_id or "").strip()
        result = session.results.get(normalized_result_id) if normalized_result_id else next(
            (candidate for candidate in session.results.values()
             if candidate.parent_message_id == parent_message_id),
            None,
        )
        if result is None and create:
            prior_parent_result = next(
                (candidate for candidate in session.results.values()
                 if candidate.parent_message_id == parent_message_id),
                None,
            )
            if (
                prior_parent_result is not None
                and normalized_result_id
                and prior_parent_result.persona_result_id != normalized_result_id
            ):
                raise RuntimeError("persona_result_id_conflict")
            result = session.result(
                normalized_result_id or f"delivery:{parent_message_id}"
            )
        if result is None:
            return None
        if create:
            result.set_parent_message_id(parent_message_id)
        elif result.parent_message_id != parent_message_id:
            return None
        return result

    async def publish_interaction_incremental_motion(
        self,
        *,
        segment_index: int,
        persona_result_id: str | None = None,
        motion_payload: dict[str, Any] | None,
        reason: str = "",
        final: bool = True,
        anchor: str = "segment_start",
    ) -> bool:
        """Publish one optional motion result without blocking core text/audio.

        A closed JSON action may arrive before the Provider stream reaches EOF.
        Such a preview updates the still-open motion stream; the later final
        result closes it and is idempotent when it carries the same payload.
        """
        if self._is_stop_requested():
            return False
        normalized_result_id = str(persona_result_id or "").strip()
        result_state = self._persona_result_state(normalized_result_id or None)
        if result_state is None or result_state.writer is None:
            return False  # A late result cannot mutate the next expression's motion.
        if result_state.stream_status is not None:
            return False
        normalized_result_id = result_state.persona_result_id

        def settle_core_future(accepted: bool) -> None:
            if not final:
                return
            motion_states = self._adapter_internal_state.incremental_motion_states
            motion_state = (
                motion_states.get(normalized_result_id)
                if isinstance(motion_states, dict)
                else None
            )
            futures = (
                motion_state.get("futures")
                if isinstance(motion_state, dict)
                else None
            )
            future = futures.get(segment_index) if isinstance(futures, dict) else None
            if isinstance(future, asyncio.Future) and not future.done():
                future.set_result(accepted)

        result_state.segment(
            PersonaSegmentIdentity(
                turn=result_state.turn,
                persona_result_id=result_state.persona_result_id,
                segment_index=segment_index,
            )
        )
        writer = result_state.writer
        try:
            accepted = await writer.publish_motion_result(
                segment_index,
                motion_payload,
                reason=reason,
                final=final,
                anchor=anchor,
            )
            if not accepted:
                logger.warning(
                    "Discarded late incremental motion result: core_turn_id=%s "
                    "persona_result_id=%s segment_index=%s",
                    result_state.turn.turn_id,
                    normalized_result_id,
                    segment_index,
                )
        except (RuntimeError, ValueError):
            accepted = False
        except BaseException:
            settle_core_future(False)
            raise
        settle_core_future(accepted)
        return accepted

    def get_interaction_incremental_motion_deadline(
        self, *, segment_index: int, persona_result_id: str | None = None
    ) -> float | None:
        """Expose the producer's existing deadline, never a fresh wait budget."""
        result_state = self._persona_result_state(persona_result_id)
        if result_state is None or result_state.writer is None:
            return None
        segment_state = result_state.segments.get(segment_index)
        deadline = segment_state.deadline if segment_state is not None else None
        return float(deadline) if isinstance(deadline, (int, float)) and math.isfinite(deadline) else None

    async def send_message_with_extras(
        self,
        message,
        *,
        platform_extras: dict[str, Any] | None = None,
        record_send_operation: bool = True,
    ) -> None:
        turn_id = self._adapter_internal_state.delivery_turn_id
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
        if resolved_platform_extras.pop("persona_incremental_delivery", False):
            resolved_platform_extras["_ag99live_persona_split_applied"] = True
            resolved_platform_extras["_ag99live_persona_parent_message_id"] = resolved_platform_extras.pop("persona_delivery_parent_message_id", "")
            resolved_platform_extras["_ag99live_raw_reply_text_override"] = resolved_platform_extras.get("semantic_text", "")
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
        session = self._persona_session()
        active_persona_parent = session.active_delivery_parent if session is not None else None
        parent_message_id = explicit_parent_id or (
            active_persona_parent
            if persona_segment is not None and active_persona_parent
            else self._resolve_parent_message_id(resolved_platform_extras)
        )
        output_segment = resolved_platform_extras.get("output_segment")
        if (
            persona_segment is not None
            and persona_segment[1] is not None
            and isinstance(output_segment, dict)
        ):
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
                parent_message_id=parent_message_id,
                persona_result_id=str(
                    resolved_platform_extras.get("persona_result_id") or ""
                ).strip() or None,
                segment_index=persona_segment[0],
                segment_count=persona_segment[1],
                streaming=bool(resolved_platform_extras.get("persona_streaming")),
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
        await self._attach_persona_stream_motion(
            resolved_platform_extras,
            turn_id=turn_id,
            parent_message_id=explicit_parent_id or parent_message_id,
        )
        await self.adapter.emit_message_chain(
            message_chain=message,
            turn_id=turn_id,
            unified_msg_origin=self.unified_msg_origin,
            raw_reply_text_override=(
                split_raw_text
                if has_split_raw_text_override
                else self._adapter_internal_state.raw_reply_text.strip()
            )
            or None,
            platform_extras=resolved_platform_extras,
        )
        if not record_send_operation:
            self._has_send_oper = previous_has_send_oper
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
        if not self._adapter_internal_state.wait_for_motion_execution_ack:
            return

        turn_id = self._adapter_internal_state.delivery_turn_id
        coordinator = getattr(self.adapter, "turn_coordinator", None)
        wait_for_turn_finished = getattr(
            coordinator,
            "wait_for_turn_finished",
            None,
        )
        if not turn_id or not callable(wait_for_turn_finished):
            raise RuntimeError("motion_playback_ack_unavailable")
        try:
            success, reason = await wait_for_turn_finished(
                turn_id=turn_id,
                timeout_seconds=ACTION_ONLY_MOTION_ACK_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            abort_turn = getattr(coordinator, "abort_turn_from_backend", None)
            if callable(abort_turn):
                await abort_turn(
                    turn_id=turn_id,
                    reason="motion_playback_ack_timeout",
                )
            raise RuntimeError("motion_playback_ack_timeout") from exc
        if not success:
            raise RuntimeError(
                f"motion_playback_failed:{reason or 'unknown'}"
            )

    async def abort_visible_turn(self, *, reason: str) -> None:
        """Close this frontend turn before a superseding Core turn begins."""
        turn_id = self._adapter_internal_state.delivery_turn_id
        if not turn_id:
            return
        await self.adapter.turn_coordinator.abort_turn_from_backend(
            turn_id=turn_id,
            reason=reason,
        )

    async def flush_visible_segment(self, *, message_id: str) -> None:
        """Emit one ready segment without completing its parent or Turn."""
        if self._is_stop_requested():
            raise asyncio.CancelledError
        turn_id = self._adapter_internal_state.delivery_turn_id
        if not turn_id or not str(message_id or "").strip():
            raise RuntimeError("output_event_segment_identity_missing")
        await self.adapter.turn_coordinator.finalize_output_segment(
            turn_id=turn_id, message_id=message_id,
        )

    async def complete_visible_message(self, *, message_id: str) -> None:
        """Finalize a Core-delivered logical message without closing its Turn."""
        if self._is_stop_requested():
            return
        turn_id = self._adapter_internal_state.delivery_turn_id
        if not turn_id:
            raise RuntimeError("output_event_turn_id_missing")
        normalized_message_id = str(message_id or "").strip()
        if not normalized_message_id:
            raise RuntimeError("output_event_segment_message_id_missing")
        await self._emit_remaining_persona_tts_segments(
            turn_id=turn_id,
            parent_message_id=normalized_message_id,
        )
        child_message_ids = self._persona_session().message_children.pop(
            normalized_message_id,
            [normalized_message_id],
        )
        for child_message_id in child_message_ids:
            await self.adapter.turn_coordinator.finalize_output_segment(
                turn_id=turn_id,
                message_id=child_message_id,
            )
        session = self._persona_session()
        if session is not None:
            session.active_delivery_parent = None
        result_state = self._persona_delivery_result(
            parent_message_id=normalized_message_id
        )
        if result_state is not None:
            result_state.mark_delivery_completed()

    def record_persona_stream_failure(self, reason: str) -> None:
        session = self._persona_session()
        if session is not None and session.output_failure_reason is None:
            session.output_failure_reason = reason

    def mark_persona_stream_finished(
        self,
        *,
        turn_id: str,
        persona_result_id: str,
        message_id: str,
        segment_count: int,
        status: str,
        failure_reason: str | None = None,
    ) -> None:
        event_turn_id = self._adapter_internal_state.core_turn_id
        delivery_turn_id = self._adapter_internal_state.delivery_turn_id
        normalized_turn_id = str(turn_id or "").strip()
        normalized_result_id = str(persona_result_id or "").strip()
        normalized_parent_id = str(message_id or "").strip()
        normalized_status = str(status or "").strip().lower()
        if (
            not normalized_turn_id
            or normalized_turn_id != event_turn_id
            or not delivery_turn_id
            or not normalized_result_id
            or not normalized_parent_id
            or type(segment_count) is not int
            or segment_count < 0
            or normalized_status not in {"completed", "incomplete", "failed", "cancelled"}
        ):
            raise RuntimeError("persona_stream_terminal_identity_invalid")
        turn_identity_map = getattr(
            getattr(self.adapter, "turn_coordinator", None),
            "turn_identity_map",
            None,
        )
        resolve_core_turn = getattr(turn_identity_map, "resolve_astrbot_turn", None)
        if callable(resolve_core_turn) and resolve_core_turn(delivery_turn_id) != event_turn_id:
            raise RuntimeError("persona_stream_terminal_turn_binding_invalid")
        result_state = self._persona_delivery_result(
            parent_message_id=normalized_parent_id,
            persona_result_id=normalized_result_id,
            create=True,
        )
        if result_state is None:
            raise RuntimeError("persona_stream_terminal_result_missing")
        result_state.set_parent_message_id(normalized_parent_id)
        result_state.set_expected_segment_count(segment_count)
        result_state.delivery_assembly_state(streaming=True)
        result_state.finish_stream(normalized_status, failure_reason)
        if normalized_status != "completed":
            self.record_persona_stream_failure(
                str(failure_reason or "").strip()
                or f"persona_segment_stream_{normalized_status}"
            )

    async def _close_frontend_turn_output_queue(self) -> None:
        turn_id = self._adapter_internal_state.delivery_turn_id
        if not turn_id:
            raise RuntimeError("output_event_turn_id_missing")
        await self.adapter.turn_coordinator.close_turn_output_queue(
            turn_id=turn_id, failure_reason=self._persona_session().output_failure_reason
        )

    def _is_stop_requested(self) -> bool:
        return self._adapter_internal_state.agent_stop_requested

    async def _attach_persona_stream_motion(
        self,
        platform_extras: dict[str, Any],
        *,
        turn_id: str,
        parent_message_id: str,
    ) -> None:
        if platform_extras.get("persona_streaming") is not True:
            return
        segment_index = platform_extras.get("persona_segment_index")
        persona_result_id = str(
            platform_extras.get("persona_result_id") or ""
        ).strip()
        if (
            isinstance(segment_index, bool)
            or not isinstance(segment_index, int)
            or segment_index < 0
            or not persona_result_id
        ):
            raise RuntimeError("persona_stream_motion_identity_invalid")
        result_state = self._persona_result_state(persona_result_id)
        result = None
        failure_reason = "independent_segment_work_missing"
        if (
            result_state is not None
            and result_state.turn.turn_id
            == self._adapter_internal_state.core_turn_id
            and result_state.persona_result_id == persona_result_id
            and result_state.parent_message_id == parent_message_id
        ):
            segment_state = result_state.segments.get(segment_index)
            future = (
                segment_state.result_future
                if segment_state is not None
                else None
            )
            if hasattr(future, "__await__"):
                try:
                    from .middleware.interaction_motion.independent import (
                        resolve_stream_motion_budget_seconds,
                    )

                    timeout_seconds = resolve_stream_motion_budget_seconds(
                        getattr(self.adapter, "runtime_state", None), event=self,
                    )
                except (ImportError, AttributeError, TypeError, ValueError):
                    timeout_seconds = 5.0
                remaining = timeout_seconds
                deadline = segment_state.deadline
                if isinstance(deadline, (int, float)):
                    remaining = max(
                        0.0,
                        deadline - asyncio.get_running_loop().time(),
                    )
                try:
                    if future.done():
                        result = await asyncio.shield(future)
                    else:
                        result = await asyncio.wait_for(
                            asyncio.shield(future),
                            timeout=remaining,
                        )
                except asyncio.TimeoutError:
                    result = None
                    failure_reason = "motion_timeout"
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    result = None
                    failure_reason = "motion_failed:" + type(exc).__name__
                    logger.warning(
                        "WIRING independent_motion.future_failed turn_id=%s "
                        "persona_result_id=%s segment_index=%s error=%s "
                        "action=continue_core_dialogue",
                        self._adapter_internal_state.core_turn_id or "<missing>",
                        persona_result_id,
                        segment_index,
                        exc,
                        exc_info=True,
                    )
                if self._is_stop_requested():
                    raise asyncio.CancelledError
                if result is not None:
                    failure_reason = str(getattr(result, "reason", "") or "")

        motion_payload = getattr(result, "motion_payload", None)
        if not isinstance(motion_payload, dict):
            motion_payload = None
        client_objects = platform_extras.get("client_objects")
        resolved_objects = (
            list(client_objects) if isinstance(client_objects, list) else []
        )
        resolved_objects = [
            candidate
            for candidate in resolved_objects
            if not (
                isinstance(candidate, dict)
                and candidate.get("type") == "ag99live.motion_payload"
                and candidate.get("persona_segment_index") == segment_index
            )
        ]
        if motion_payload is not None:
            resolved_objects.append(
                {
                    "type": "ag99live.motion_payload",
                    "motion_payload": motion_payload,
                    "mode": "preview",
                    "source": "independent_provider",
                    "persona_segment_index": segment_index,
                }
            )
        platform_extras["client_objects"] = resolved_objects

        metadata = platform_extras.get("metadata")
        resolved_metadata = dict(metadata) if isinstance(metadata, dict) else {}
        schedule = resolved_metadata.get("ag99live_motion_schedule")
        resolved_schedule = dict(schedule) if isinstance(schedule, dict) else {}
        resolved_schedule.update(
            {
                "scheduled": True,
                "source": "independent_provider",
                "persona_segmented": True,
                "reason": (
                    "independent_provider"
                    if motion_payload is not None
                    else failure_reason or "independent_segment_work_missing"
                ),
            }
        )
        failure_reasons = resolved_schedule.get("persona_motion_failure_reasons")
        failure_reasons = dict(failure_reasons) if isinstance(failure_reasons, dict) else {}
        if motion_payload is None:
            failure_reasons[str(segment_index)] = (
                failure_reason or "independent_segment_work_missing"
            )
        else:
            failure_reasons.pop(str(segment_index), None)
        if failure_reasons:
            resolved_schedule["persona_motion_failure_reasons"] = failure_reasons
        else:
            resolved_schedule.pop("persona_motion_failure_reasons", None)
        resolved_metadata["ag99live_motion_schedule"] = resolved_schedule
        platform_extras["metadata"] = resolved_metadata

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
        turn_id = self._adapter_internal_state.core_turn_id
        if not turn_id:
            return None
        found = self.adapter.runtime_state.persona_sessions.find_segment_by_message_id(
            PersonaTurnIdentity(turn_id),
            message_id,
        )
        if found is None:
            return None
        result_state, segment_state = found
        binding = segment_state.tts_binding
        segment_count = result_state.expected_segment_count
        if binding is None or segment_count is None or not message_id:
            return None
        return {
            "message_id": message_id,
            "parent_message_id": binding.parent_message_id,
            "segment_index": segment_state.index,
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
        turn_id = self._adapter_internal_state.core_turn_id
        if not turn_id:
            return ""
        found = self.adapter.runtime_state.persona_sessions.find_segment_by_message_id(
            PersonaTurnIdentity(turn_id),
            message_id,
        )
        if found is None:
            return ""
        result_state, segment_state = found
        binding = segment_state.tts_binding
        segment_count = result_state.expected_segment_count
        if binding is None or segment_count is None:
            return ""
        if binding.parent_message_id != message_id:
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
        session = self._persona_session()
        if session is None:
            return
        children = session.message_children.setdefault(parent_message_id, [])
        if message_id not in children:
            children.append(message_id)

    def _remember_persona_segment(
        self,
        *,
        parent_message_id: str,
        persona_result_id: str | None,
        segment_index: int,
        segment_count: int | None,
        streaming: bool,
        template_extras: dict[str, Any] | None,
    ) -> None:
        normalized_result_id = str(persona_result_id or "").strip()
        if streaming and not normalized_result_id:
            raise RuntimeError("persona_stream_result_identity_missing")
        result_state = self._persona_delivery_result(
            parent_message_id=parent_message_id,
            persona_result_id=normalized_result_id or None,
            create=True,
        )
        if result_state is None:
            raise RuntimeError("persona_delivery_result_state_missing")
        template = None
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
        result_state.remember_delivery_segment(
            segment_index=segment_index,
            segment_count=segment_count,
            streaming=streaming,
            template_extras=template,
        )

    async def _emit_missing_persona_tts_segments_before(
        self,
        *,
        turn_id: str,
        parent_message_id: str,
        before_segment_index: int,
        segment_count: int,
        template_extras: dict[str, Any],
    ) -> None:
        result_state = self._persona_delivery_result(
            parent_message_id=parent_message_id
        )
        assembly = result_state.delivery_assembly if result_state is not None else None
        if assembly is not None and assembly.streaming:
            return
        if (
            result_state is not None
            and result_state.expected_segment_count not in {None, segment_count}
        ):
            raise RuntimeError("persona_segment_count_conflict")
        seen = assembly.segment_indexes if assembly is not None else set()
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
        result_state = self._persona_delivery_result(
            parent_message_id=parent_message_id
        )
        assembly = result_state.delivery_assembly if result_state is not None else None
        if (
            result_state is None
            or assembly is None
            or not isinstance(assembly.template_extras, dict)
        ):
            return
        if assembly.streaming:
            return
        segment_count = result_state.expected_segment_count
        if type(segment_count) is not int:
            return
        for segment_index in range(segment_count):
            if segment_index in assembly.segment_indexes:
                continue
            await self._emit_persona_motion_only_segment(
                turn_id=turn_id,
                parent_message_id=parent_message_id,
                segment_index=segment_index,
                segment_count=segment_count,
                template_extras=assembly.template_extras,
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
        active_parent = self._persona_session().active_delivery_parent
        if index == 0 or active_parent is None:
            self._persona_session().active_delivery_parent = message_id
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
                    "explanation": "这是用户当前桌面截图。",
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
) -> tuple[int, int | None] | None:
    index = platform_extras.get("persona_segment_index")
    count = platform_extras.get("persona_segment_count")
    if isinstance(index, bool) or not isinstance(index, int):
        if count is None:
            return None
        raise RuntimeError("persona_segment_index_invalid")
    if count is None and platform_extras.get("persona_streaming") is True:
        if index < 0:
            raise RuntimeError("persona_segment_index_invalid")
        return index, None
    if isinstance(count, bool) or not isinstance(count, int):
        raise RuntimeError("persona_segment_count_invalid")
    if index < 0 or count <= 0 or index >= count:
        raise RuntimeError("persona_segment_metadata_invalid")
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
