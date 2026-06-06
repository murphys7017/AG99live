from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable
from uuid import uuid4

from astrbot.api import logger
from astrbot.api.message_components import Plain, Record  # re-exported for test access
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.platform.message_type import MessageType
from astrbot.core.utils.active_event_registry import active_event_registry

from ..protocol.builder import (
    build_control_error,
    build_control_interrupt,
    build_control_synth_finished,
    build_control_turn_finished,
    build_control_turn_started,
    build_output_audio,
    build_output_image,
    build_output_text,
)
from ..protocol.binary_audio import parse_binary_audio_frame
from ..protocol import (
    SOURCE_ADAPTER,
    SOURCE_ENGINE,
    TYPE_ENGINE_CATALOG_MOTION,
    TYPE_CONTROL_INTERRUPT,
    TYPE_CONTROL_PLAYBACK_FINISHED,
    TYPE_ENGINE_MOTION_INTENT,
    TYPE_INPUT_AUDIO_STREAM_CHUNK,
    TYPE_INPUT_AUDIO_STREAM_END,
    TYPE_INPUT_AUDIO_STREAM_START,
    TYPE_INPUT_MIC_AUDIO_DATA,
    TYPE_INPUT_MIC_AUDIO_END,
    TYPE_INPUT_RAW_AUDIO_DATA,
    TYPE_INPUT_TEXT,
    build_message_envelope,
    parse_inbound_message,
)
from ..services.speech_service import SpeechIngressService
from ..motion.realtime_motion_plan import (
    normalize_motion_intent_payload,
)
from ..motion.inline_motion import (
    INLINE_ANIM_START_PATTERN,
    build_model_visible_user_text as _build_model_visible_user_text,
    extract_inline_motion_plan as _extract_inline_motion_plan,
    extract_message_motion_payload as _extract_message_motion_payload,
    resolve_engine_motion_message_type as _resolve_engine_motion_message_type,
    resolve_inline_motion_source as _resolve_inline_motion_source,
    resolve_motion_generation_mode as _resolve_motion_generation_mode,
    resolve_motion_payload_schema_version as _resolve_motion_payload_schema_version,
    summarize_motion_payload as _summarize_motion_payload,
    validate_motion_payload as _validate_motion_payload,
)
from .message_utils import (
    extract_outbound_message_parts as _extract_outbound_message_parts,
    iter_platform_motion_client_objects as _iter_platform_motion_client_objects,
    resolve_platform_segment_message_id as _resolve_platform_segment_message_id,
)
from .image_diagnostics import (
    emit_image_input_diagnostics,
)

class TurnCoordinator:
    def __init__(
        self,
        *,
        session_state,
        turn_identity_map,
        runtime_state,
        media_service,
        chat_buffer,
        speaker_name: str,
        convert_message: Callable[[dict[str, Any]], Any],
        build_message_object: Callable[..., Any],
        handle_frontend_system: Callable[[Any], Awaitable[None]],
        refresh_runtime_settings: Callable[[], None],
        send_current_model_and_conf: Callable[[], Awaitable[None]],
        send_json: Callable[[dict[str, Any]], Awaitable[bool]],
        build_platform_event: Callable[[Any], Any],
        commit_event: Callable[[Any], None],
        ensure_vad_engine: Callable[[], Any],
    ) -> None:
        self.session_state = session_state
        self.turn_identity_map = turn_identity_map
        self.runtime_state = runtime_state
        self.media_service = media_service
        self.chat_buffer = chat_buffer
        self.speaker_name = speaker_name
        self._convert_message = convert_message
        self._build_message_object = build_message_object
        self._handle_frontend_system = handle_frontend_system
        self._refresh_runtime_settings = refresh_runtime_settings
        self._send_current_model_and_conf = send_current_model_and_conf
        self._send_json = send_json
        self._build_platform_event = build_platform_event
        self._commit_event = commit_event
        self._ensure_vad_engine = ensure_vad_engine
        self.speech_ingress = SpeechIngressService(
            media_service=self.media_service,
            runtime_state=self.runtime_state,
            ensure_vad_engine=self._ensure_vad_engine,
            send_json=self._send_json,
            build_message_object=self._build_message_object,
        )

        self._turn_lock = asyncio.Lock()
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self._turn_timing: dict[str, Any] = {}

    async def handle_msg(self, raw_message: dict[str, Any]) -> None:
        message = parse_inbound_message(raw_message)

        if message.type.startswith("system."):
            await self._handle_frontend_system(message)
            return

        if message.type in {TYPE_ENGINE_MOTION_INTENT, TYPE_ENGINE_CATALOG_MOTION}:
            await self._handle_engine_motion_payload_preview(message)
            return

        turn_id = self._require_interactive_turn_id(message)

        if message.type == TYPE_CONTROL_PLAYBACK_FINISHED:
            success_raw = message.payload.get("success", True)
            success = success_raw if isinstance(success_raw, bool) else True
            reason_raw = message.payload.get("reason")
            reason = reason_raw.strip() if isinstance(reason_raw, str) and reason_raw.strip() else None
            await self.finalize_turn(turn_id=turn_id, success=success, reason=reason)
            return

        if message.type == TYPE_CONTROL_INTERRUPT:
            await self._handle_interrupt_signal(turn_id)
            return

        if message.type == TYPE_INPUT_AUDIO_STREAM_START:
            await self.speech_ingress.handle_audio_stream_start(message)
            return

        if message.type == TYPE_INPUT_AUDIO_STREAM_CHUNK:
            await self.speech_ingress.handle_audio_stream_chunk(message)
            return

        if message.type == TYPE_INPUT_AUDIO_STREAM_END:
            message_obj = await self.speech_ingress.handle_audio_stream_end(message)
            if message_obj is not None:
                await self._commit_inbound_message(message_obj, turn_id=turn_id)
            return

        if message.type == TYPE_INPUT_MIC_AUDIO_DATA:
            await self.speech_ingress.handle_audio_data(message)
            return

        if message.type == TYPE_INPUT_RAW_AUDIO_DATA:
            message_obj = await self.speech_ingress.handle_raw_audio_data(message)
            if message_obj is not None:
                await self._commit_inbound_message(message_obj, turn_id=turn_id)
            return

        if message.type == TYPE_INPUT_MIC_AUDIO_END:
            await self._handle_audio_end(message)
            return

        if message.type == TYPE_INPUT_TEXT:
            message_obj = self._convert_message(message.raw)
            await self._commit_inbound_message(message_obj, turn_id=turn_id)
            return

        await self._send_json(
            build_control_error(
                turn_id=turn_id,
                message=f"Unhandled message type: {message.type}",
            )
        )

    async def handle_binary_msg(self, raw_message: bytes) -> None:
        frame = parse_binary_audio_frame(raw_message)
        message_obj = await self.speech_ingress.handle_audio_stream_binary_chunk(frame)
        if message_obj is not None:
            turn_id = self._require_turn_id_value(frame.turn_id)
            await self._commit_inbound_message(message_obj, turn_id=turn_id)

    async def emit_message_chain(
        self,
        message_chain,
        unified_msg_origin: str | None = None,
        inline_base_expression: str | None = None,
        inline_motion_id: str | None = None,
        raw_reply_text_override: str | None = None,
        platform_extras: dict[str, Any] | None = None,
    ) -> None:
        del unified_msg_origin
        del inline_base_expression
        del inline_motion_id

        turn_id = self.session_state.current_turn_id
        platform_extras_dict = platform_extras if isinstance(platform_extras, dict) else {}
        segment_message_id = _resolve_platform_segment_message_id(platform_extras_dict)

        self._mark_turn_timing("emit_started_at")
        texts, picture_paths, record_paths = _extract_outbound_message_parts(message_chain)
        override_text = str(raw_reply_text_override or "").strip()
        raw_reply_text = override_text or "\n".join(texts).strip()
        motion_generation_mode = _resolve_motion_generation_mode(self.runtime_state)
        inline_anim_detected = INLINE_ANIM_START_PATTERN.search(raw_reply_text) is not None
        reply_text, inline_payload, inline_mode = _extract_inline_motion_plan(raw_reply_text)

        if reply_text:
            self.chat_buffer.add("assistant", reply_text)
            await self._send_json(
                build_output_text(
                    turn_id=turn_id,
                    message_id=segment_message_id,
                    text=reply_text,
                    speaker_name=self.speaker_name,
                    avatar="",
                )
            )

        if motion_generation_mode == "split_after_reply":
            logger.info(
                "WIRING motion_plan turn_id=%s inline_anim_detected=%s route=split_after_reply",
                turn_id or "",
                inline_anim_detected,
            )
        elif inline_anim_detected:
            if inline_payload is None:
                logger.warning(
                    "WIRING motion_plan turn_id=%s inline_anim_parse_failed=true "
                    "route=secondary_request",
                    turn_id or "",
                )
            else:
                logger.info(
                    "WIRING motion_plan turn_id=%s inline_anim_detected=%s inline_plan_valid=%s "
                    "inline_mode=%s route=inline_primary",
                    turn_id or "",
                    inline_anim_detected,
                    inline_payload is not None,
                    inline_mode or "",
                )
        else:
            logger.info(
                "WIRING motion_plan turn_id=%s inline_anim_detected=false "
                "route=secondary_request",
                turn_id or "",
            )

        inline_dispatched = False
        platform_motion_dispatched = await self._broadcast_platform_motion_client_objects(
            platform_extras=platform_extras_dict,
            turn_id=turn_id,
            message_id=segment_message_id,
        )
        if platform_motion_dispatched:
            inline_dispatched = True

        if (
            motion_generation_mode == "inline_first"
            and not inline_dispatched
            and isinstance(inline_payload, dict)
        ):
            inline_mode_resolved = str(inline_mode or "inline").strip() or "inline"
            inline_dispatched = await self.broadcast_motion_payload(
                motion_payload=inline_payload,
                mode=inline_mode_resolved,
                source=_resolve_inline_motion_source(inline_payload),
                turn_id=turn_id,
                message_id=segment_message_id,
            )
            if not inline_dispatched:
                logger.warning(
                    "WIRING motion_plan turn_id=%s inline_plan_dispatch_failed=true "
                    "route=secondary_request",
                    turn_id or "",
                )

        if picture_paths:
            await self._send_json(
                build_output_image(
                    turn_id=turn_id,
                    images=picture_paths,
                )
            )

        if record_paths:
            record_path = record_paths[0]
            _, audio_url = self.media_service.cache_audio_file(record_path)
            await self._send_json(
                build_output_audio(
                    turn_id=turn_id,
                    message_id=segment_message_id,
                    audio_url=audio_url,
                    text=reply_text,
                    speaker_name=self.speaker_name,
                    avatar="",
                )
            )
            self._mark_turn_timing("audio_payload_sent_at")
            self._mark_turn_synthesizing()
            self._mark_turn_playing()
            return

        self._mark_turn_playing()

    async def close_turn_output_queue(self) -> None:
        current_turn_id = self.session_state.current_turn_id
        if current_turn_id is None:
            return

        mark_closed = getattr(self.session_state, "mark_output_queue_closed", None)
        if callable(mark_closed):
            if not mark_closed():
                return
        else:
            if bool(getattr(self.session_state, "output_queue_closed", False)):
                return
            setattr(self.session_state, "output_queue_closed", True)

        await self._send_json(
            build_control_synth_finished(
                turn_id=current_turn_id,
            )
        )
        self._mark_turn_playing()

    def _mark_turn_synthesizing(self) -> None:
        mark_synthesizing = getattr(self.session_state, "mark_synthesizing", None)
        if callable(mark_synthesizing):
            mark_synthesizing()

    def _mark_turn_playing(self) -> None:
        mark_playing = getattr(self.session_state, "mark_playing", None)
        if callable(mark_playing):
            mark_playing()

    async def finalize_turn(
        self,
        *,
        turn_id: str | None,
        success: bool = True,
        reason: str | None = None,
    ) -> None:
        current_turn_id = self.session_state.current_turn_id
        if not self.session_state.waiting_for_playback_complete:
            return
        resolved_turn_id = self._resolve_frontend_turn_id(turn_id) if turn_id else None
        if resolved_turn_id and current_turn_id and resolved_turn_id != current_turn_id:
            logger.debug(
                "Ignoring playback-finished for stale turn_id=%s current_turn_id=%s",
                turn_id,
                current_turn_id,
            )
            return

        await self._finish_turn(success=success, reason=reason)
        self._mark_turn_timing("playback_completed_at")
        logger.debug(
            "Turn timing playback: turn=%s playback_ms=%.1f total_ms=%.1f success=%s reason=%s",
            self._current_turn_index(),
            self._elapsed_ms("audio_payload_sent_at", "playback_completed_at"),
            self._elapsed_ms("received_at", "playback_completed_at"),
            success,
            reason or "",
        )

    async def _commit_inbound_message(self, message_obj, *, turn_id: str | None = None) -> None:
        async with self._turn_lock:
            if self.session_state.waiting_for_playback_complete:
                await self.finalize_turn(turn_id=self.session_state.current_turn_id)

            normalized_turn_id = self._require_turn_id_value(turn_id)
            backend_turn_id = self._resolve_backend_turn_id(message_obj, frontend_turn_id=normalized_turn_id)
            turn_identity_map = getattr(self, "turn_identity_map", None)
            if turn_identity_map is not None:
                turn_identity_map.register_bound_turn(
                    frontend_turn_id=normalized_turn_id,
                    backend_turn_id=backend_turn_id,
                )
            current_turn_id = self.session_state.begin_turn(
                message_obj.message_str,
                turn_id=normalized_turn_id,
            )
            self._begin_turn_timing(message_obj.message_str)
            self.chat_buffer.add("user", message_obj.message_str)
            await self._send_json(
                build_control_turn_started(
                    turn_id=current_turn_id,
                )
            )
            await self._emit_image_input_diagnostics(message_obj)

            event = self._build_platform_event(message_obj)
            motion_generation_mode = _resolve_motion_generation_mode(self.runtime_state)
            if motion_generation_mode == "split_after_reply":
                set_extra = getattr(event, "set_extra", None)
                if callable(set_extra):
                    set_extra("enable_streaming", False)
                    set_extra("ag99live_motion_generation_mode", motion_generation_mode)
            self._apply_raw_message_metadata_to_event(event, message_obj)
            if motion_generation_mode == "inline_first":
                self._apply_inline_motion_contract_to_event(event, message_obj=message_obj)
            self._commit_event(event)
            self._mark_turn_timing("event_committed_at")
            logger.debug(
                "Turn timing start: turn=%s text_len=%d turn_id=%s",
                self._current_turn_index(),
                len(message_obj.message_str or ""),
                current_turn_id,
            )

    async def submit_system_text_input(
        self,
        text: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        normalized_text = str(text or "").strip()
        if not normalized_text:
            return
        message_id = uuid4().hex
        raw_message = build_message_envelope(
            TYPE_INPUT_TEXT,
            source=SOURCE_ADAPTER,
            message_id=message_id,
            turn_id=f"remote-operator:{message_id}",
            payload={
                "text": normalized_text,
                "images": [],
            },
        )
        if isinstance(metadata, dict):
            raw_message.update(metadata)
        message_obj = self._build_message_object(
            text=normalized_text,
            raw_message=raw_message,
            images=[],
        )
        await self._commit_inbound_message(
            message_obj,
            turn_id=str(raw_message.get("turn_id") or ""),
        )

    @staticmethod
    def _apply_raw_message_metadata_to_event(event: Any, message_obj: Any) -> None:
        raw_message = getattr(message_obj, "raw_message", None)
        if not isinstance(raw_message, dict):
            return
        set_extra = getattr(event, "set_extra", None)
        if not callable(set_extra):
            return
        for key in ("ag99live_input_source", "remote_operator"):
            if key in raw_message:
                set_extra(key, raw_message[key])

    def _apply_inline_motion_contract_to_event(self, event, *, message_obj) -> None:
        original_message_str = str(getattr(message_obj, "message_str", "") or "")
        set_extra = getattr(event, "set_extra", None)
        if callable(set_extra):
            set_extra("ag99live_original_message_str", original_message_str)

        prompt_text = _build_model_visible_user_text(
            original_message_str,
            runtime_state=self.runtime_state,
        )
        if prompt_text == original_message_str:
            return

        event.message_str = prompt_text
        if callable(set_extra):
            set_extra("ag99live_inline_motion_contract_applied", True)
            set_extra("ag99live_inline_motion_contract_mode", "user_prompt_system_reminder")
            set_extra("ag99live_inline_motion_contract_prompt", prompt_text)

        logger.info(
            "WIRING inline_motion_contract applied=true turn_id=%s original_len=%s prompt_len=%s",
            getattr(self.session_state, "current_turn_id", "") or "",
            len(original_message_str),
            len(prompt_text),
        )

    async def _emit_image_input_diagnostics(self, message_obj) -> None:
        await emit_image_input_diagnostics(
            message_obj=message_obj,
            client_uid=self.session_state.client_uid,
            current_turn_id=self.session_state.current_turn_id,
            send_json=self._send_json,
        )

    async def _handle_audio_end(self, message) -> None:
        message_obj = await self.speech_ingress.handle_audio_end(message)
        if message_obj is None:
            return
        await self._commit_inbound_message(message_obj, turn_id=message.turn_id)

    async def _handle_interrupt_signal(self, turn_id: str | None) -> None:
        current_turn_id = self.session_state.current_turn_id
        resolved_turn_id = self._resolve_frontend_turn_id(turn_id) if turn_id else None
        if resolved_turn_id and current_turn_id and resolved_turn_id != current_turn_id:
            logger.debug(
                "Ignoring interrupt for stale turn_id=%s current_turn_id=%s",
                turn_id,
                current_turn_id,
            )
            return

        umo = self._build_current_unified_msg_origin()
        stopped_count = 0

        plugin_context = getattr(self.runtime_state, "plugin_context", None)
        agent_runner_type = ""
        if plugin_context is not None:
            try:
                cfg = plugin_context.get_config(umo=umo)
                provider_settings = cfg.get("provider_settings", {}) if isinstance(cfg, dict) else {}
                agent_runner_type = str(provider_settings.get("agent_runner_type", "") or "")
            except Exception as exc:
                logger.warning("Failed to resolve agent runner type for interrupt: %s", exc)

        if agent_runner_type in {"dify", "coze"}:
            stopped_count = active_event_registry.stop_all(umo)
        else:
            stopped_count = active_event_registry.request_agent_stop_all(umo)
            stopped_count = max(stopped_count, active_event_registry.stop_all(umo))

        await self.speech_ingress.handle_audio_stream_interrupt()
        await self.media_service.clear_audio_buffer()
        await self._send_json(
            build_control_interrupt(
                turn_id=current_turn_id,
            )
        )
        await self._finish_turn(success=False, reason="interrupted")

        logger.info(
            "Processed control.interrupt for turn=%s stopped_events=%s umo=%s",
            self._current_turn_index(),
            stopped_count,
            umo,
        )

    async def _handle_engine_motion_payload_preview(self, message) -> None:
        payload = message.payload if isinstance(message.payload, dict) else {}
        motion_payload, failure_reason = _extract_message_motion_payload(
            message.type,
            payload,
        )
        mode = str(payload.get("mode") or "preview")
        if failure_reason:
            logger.warning(
                "WIRING motion_payload_ingress rejected type=%s mode=%s turn_id=%s failure_reason=%s",
                message.type,
                mode,
                message.turn_id or "",
                failure_reason,
            )
            await self._send_json(
                build_control_error(
                    turn_id=message.turn_id,
                    message=f"Invalid {message.type} payload: {failure_reason}",
                )
            )
            return
        schema_version, resolved_mode, axis_count, supplementary_count, failure_reason = _summarize_motion_payload(
            motion_payload
        )

        logger.info(
            "WIRING motion_payload_ingress type=%s mode=%s turn_id=%s "
            "plan_schema=%s plan_mode=%s axis_count=%s supplementary_count=%s failure_reason=%s",
            message.type,
            mode,
            message.turn_id or "",
            schema_version,
            resolved_mode,
            axis_count,
            supplementary_count,
            failure_reason,
        )
        # Frontend-origin preview payloads are validated here; playback happens
        # locally in the desktop frontend, so the adapter only records ingress.
        return

    async def broadcast_motion_payload(
        self,
        *,
        motion_payload: Any,
        mode: str = "preview",
        source: str = "engine.motion_payload",
        turn_id: str | None = None,
        message_id: str | None = None,
    ) -> bool:
        if not isinstance(motion_payload, dict):
            return False

        if _resolve_motion_payload_schema_version(motion_payload) == "engine.motion_intent.v2":
            try:
                motion_payload = normalize_motion_intent_payload(motion_payload)
            except ValueError as exc:
                logger.warning("WIRING motion_payload_egress rejected: %s", exc)
                return False

        message_type = _resolve_engine_motion_message_type(motion_payload)
        if not message_type:
            return False

        resolved_turn_id = turn_id if turn_id is not None else self.session_state.current_turn_id
        if message_type == TYPE_ENGINE_MOTION_INTENT:
            payload_key = "intent"
        elif message_type == TYPE_ENGINE_CATALOG_MOTION:
            payload_key = "motion"
        else:
            payload_key = "plan"
        payload = {
            "mode": str(mode or "preview"),
            payload_key: motion_payload,
            "source": str(source or "engine.motion_payload"),
        }
        sent = await self._send_json(
            build_message_envelope(
                message_type,
                turn_id=resolved_turn_id,
                message_id=message_id,
                source=SOURCE_ENGINE,
                payload=payload,
            )
        )
        if sent:
            schema_version, resolved_mode, axis_count, supplementary_count, failure_reason = (
                _summarize_motion_payload(motion_payload)
            )
            logger.info(
                "WIRING motion_payload_egress type=%s source=%s mode=%s turn_id=%s "
                "plan_schema=%s plan_mode=%s axis_count=%s supplementary_count=%s failure_reason=%s",
                message_type,
                payload["source"],
                payload["mode"],
                resolved_turn_id or "",
                schema_version,
                resolved_mode,
                axis_count,
                supplementary_count,
                failure_reason,
            )
        return sent

    async def _broadcast_platform_motion_client_objects(
        self,
        *,
        platform_extras: dict[str, Any],
        turn_id: str | None,
        message_id: str,
    ) -> bool:
        dispatched = False
        for motion_object in _iter_platform_motion_client_objects(platform_extras):
            motion_payload = motion_object.get("motion_payload")
            if not isinstance(motion_payload, dict):
                motion_payload = motion_object.get("intent")
            if not isinstance(motion_payload, dict):
                motion_payload = motion_object.get("plan")
            if not isinstance(motion_payload, dict):
                continue

            sent = await self.broadcast_motion_payload(
                motion_payload=motion_payload,
                mode=str(motion_object.get("mode") or "preview"),
                source=str(motion_object.get("source") or "platform_extras"),
                turn_id=turn_id,
                message_id=message_id,
            )
            dispatched = dispatched or sent
        return dispatched

    def _spawn_background_task(self, coroutine: Awaitable[None]) -> None:
        task = asyncio.create_task(coroutine)
        self._background_tasks.add(task)

        def _on_done(done_task: asyncio.Task[Any]) -> None:
            self._background_tasks.discard(done_task)
            try:
                done_task.result()
            except asyncio.CancelledError:
                return
            except Exception as exc:
                logger.warning("Background task in turn coordinator failed: %s", exc)

        task.add_done_callback(_on_done)

    async def _finish_turn(self, *, success: bool, reason: str | None) -> None:
        current_turn_id = self.session_state.current_turn_id
        if current_turn_id is None:
            self.session_state.reset_to_idle()
            return

        await self._send_json(
            build_control_turn_finished(
                turn_id=current_turn_id,
                success=success,
                reason=reason,
            )
        )
        self._mark_turn_timing("turn_completed_at")
        turn_identity_map = getattr(self, "turn_identity_map", None)
        if turn_identity_map is not None:
            turn_identity_map.clear_frontend_turn(current_turn_id)
        if self.session_state.waiting_for_playback_complete:
            self.session_state.mark_playback_complete()
        else:
            self.session_state.reset_to_idle()

    def _resolve_backend_turn_id(
        self,
        message_obj,
        *,
        frontend_turn_id: str,
    ) -> str:
        candidates = [
            getattr(message_obj, "message_id", None),
        ]
        raw_message = getattr(message_obj, "raw_message", None)
        if isinstance(raw_message, dict):
            candidates.extend(
                [
                    raw_message.get("backend_turn_id"),
                    raw_message.get("request_id"),
                    raw_message.get("input_id"),
                ]
            )
        for candidate in candidates:
            normalized = self._normalize_optional_turn_value(candidate)
            if normalized:
                return normalized
        return frontend_turn_id

    def _resolve_frontend_turn_id(self, frontend_turn_id: str | None) -> str | None:
        normalized = self._normalize_optional_turn_value(frontend_turn_id)
        if not normalized:
            return None
        turn_identity_map = getattr(self, "turn_identity_map", None)
        if turn_identity_map is None:
            return normalized
        resolved = turn_identity_map.resolve_frontend_turn(normalized)
        return resolved or normalized

    @staticmethod
    def _normalize_optional_turn_value(value: object) -> str | None:
        if not isinstance(value, str):
            return None
        normalized = value.strip()
        return normalized or None

    def _current_turn_index(self) -> int:
        return int(getattr(self.session_state, "turn_index", 0) or 0)

    def _build_current_unified_msg_origin(self) -> str:
        return str(
            MessageSession(
                platform_name="olv_pet_adapter",
                message_type=MessageType.FRIEND_MESSAGE,
                session_id=self.session_state.client_uid,
            )
        )

    def _begin_turn_timing(self, user_text: str) -> None:
        self._turn_timing = {
            "turn_index": self._current_turn_index(),
            "received_at": time.perf_counter(),
            "user_text_len": len(user_text or ""),
        }

    def _mark_turn_timing(
        self,
        key: str,
        value: float | None = None,
    ) -> None:
        if not self._turn_timing:
            self._turn_timing = {"turn_index": self._current_turn_index()}
        self._turn_timing[key] = time.perf_counter() if value is None else value

    def _elapsed_ms(self, start_key: str, end_key: str) -> float:
        start_value = _coerce_perf_counter(self._turn_timing.get(start_key))
        end_value = _coerce_perf_counter(self._turn_timing.get(end_key))
        if start_value is None or end_value is None:
            return -1.0
        return max((end_value - start_value) * 1000.0, 0.0)

    def _require_interactive_turn_id(self, message) -> str:
        if message.type.startswith("system."):
            raise ValueError("System messages should not require interactive turn ids.")
        return self._require_turn_id_value(message.turn_id)

    @staticmethod
    def _require_turn_id_value(turn_id: str | None) -> str:
        normalized = str(turn_id or "").strip()
        if not normalized:
            raise ValueError("Interactive protocol messages require a non-empty turn_id.")
        return normalized


def _coerce_perf_counter(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return None
