from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, Awaitable, Callable

from astrbot.api import logger
from astrbot.api.message_components import Image, Plain, Record
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.platform.message_type import MessageType
from astrbot.core.utils.active_event_registry import active_event_registry

from .payload_builder import (
    build_control_error,
    build_control_interrupt,
    build_control_synth_finished,
    build_control_turn_finished,
    build_control_turn_started,
    build_output_audio,
    build_output_image,
    build_output_text,
)
from .protocol import (
    SOURCE_ENGINE,
    TYPE_CONTROL_INTERRUPT,
    TYPE_CONTROL_PLAYBACK_FINISHED,
    TYPE_ENGINE_MOTION_PLAN,
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
from .speech_ingress import SpeechIngressService

INLINE_ANIM_TAG_PATTERN = re.compile(r"<@anim\s*\{[\s\S]*?\}>\s*", re.IGNORECASE)
INLINE_ANIM_START_PATTERN = re.compile(r"<@anim\b", re.IGNORECASE)


class TurnCoordinator:
    def __init__(
        self,
        *,
        session_state,
        runtime_state,
        media_service,
        chat_buffer,
        speaker_name: str,
        convert_message: Callable[[dict[str, Any]], Any],
        build_message_object: Callable[..., Any],
        handle_frontend_compat: Callable[[Any], Awaitable[None]],
        refresh_runtime_settings: Callable[[], None],
        send_current_model_and_conf: Callable[[], Awaitable[None]],
        send_json: Callable[[dict[str, Any]], Awaitable[bool]],
        build_platform_event: Callable[[Any], Any],
        commit_event: Callable[[Any], None],
        ensure_vad_engine: Callable[[], Any],
        generate_realtime_motion_plan: Callable[..., Awaitable[dict[str, Any] | None]] | None = None,
        realtime_motion_mode_getter: Callable[[], str] | None = None,
    ) -> None:
        self.session_state = session_state
        self.runtime_state = runtime_state
        self.media_service = media_service
        self.chat_buffer = chat_buffer
        self.speaker_name = speaker_name
        self._convert_message = convert_message
        self._build_message_object = build_message_object
        self._handle_frontend_compat = handle_frontend_compat
        self._refresh_runtime_settings = refresh_runtime_settings
        self._send_current_model_and_conf = send_current_model_and_conf
        self._send_json = send_json
        self._build_platform_event = build_platform_event
        self._commit_event = commit_event
        self._ensure_vad_engine = ensure_vad_engine
        self._generate_realtime_motion_plan = generate_realtime_motion_plan
        self._realtime_motion_mode_getter = realtime_motion_mode_getter
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
        message = parse_inbound_message(
            raw_message,
            default_session_id=self.session_state.client_uid,
        )

        if message.type.startswith("system."):
            await self._handle_frontend_compat(message)
            return

        if message.type == TYPE_CONTROL_PLAYBACK_FINISHED:
            success_raw = message.payload.get("success", True)
            success = success_raw if isinstance(success_raw, bool) else True
            reason_raw = message.payload.get("reason")
            reason = reason_raw.strip() if isinstance(reason_raw, str) and reason_raw.strip() else None
            await self.finalize_turn(turn_id=message.turn_id, success=success, reason=reason)
            return

        if message.type == TYPE_CONTROL_INTERRUPT:
            await self._handle_interrupt_signal(message.turn_id)
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
                await self._commit_inbound_message(message_obj, turn_id=message.turn_id)
            return

        if message.type == TYPE_INPUT_MIC_AUDIO_DATA:
            await self.speech_ingress.handle_audio_data(message)
            return

        if message.type == TYPE_INPUT_RAW_AUDIO_DATA:
            message_obj = await self.speech_ingress.handle_raw_audio_data(message)
            if message_obj is not None:
                await self._commit_inbound_message(message_obj, turn_id=message.turn_id)
            return

        if message.type == TYPE_INPUT_MIC_AUDIO_END:
            await self._handle_audio_end(message)
            return

        if message.type == TYPE_INPUT_TEXT:
            message_obj = self._convert_message(message.raw)
            await self._commit_inbound_message(message_obj, turn_id=message.turn_id)
            return

        if message.type == TYPE_ENGINE_MOTION_PLAN:
            await self._handle_engine_motion_plan_preview(message)
            return

        await self._send_json(
            build_control_error(
                session_id=message.session_id,
                turn_id=message.turn_id,
                message=f"Unhandled message type: {message.type}",
            )
        )

    async def emit_message_chain(
        self,
        message_chain,
        unified_msg_origin: str | None = None,
        inline_base_expression: str | None = None,
        inline_motion_id: str | None = None,
    ) -> None:
        del unified_msg_origin
        del inline_base_expression
        del inline_motion_id

        session_id = self.session_state.client_uid
        turn_id = self.session_state.current_turn_id

        self._mark_turn_timing("emit_started_at")
        texts, picture_paths, record_paths = _extract_outbound_message_parts(message_chain)
        raw_reply_text = "\n".join(texts).strip()
        inline_anim_detected = INLINE_ANIM_START_PATTERN.search(raw_reply_text) is not None
        reply_text, inline_plan, inline_mode = _extract_inline_motion_plan(raw_reply_text)

        if reply_text:
            self.chat_buffer.add("assistant", reply_text)
            await self._send_json(
                build_output_text(
                    session_id=session_id,
                    turn_id=turn_id,
                    text=reply_text,
                    speaker_name=self.speaker_name,
                    avatar="",
                )
            )

        if inline_anim_detected:
            if inline_plan is None:
                logger.warning(
                    "WIRING motion_plan turn_id=%s inline_anim_parse_failed=true "
                    "route=secondary_request",
                    turn_id or "",
                )
            else:
                logger.info(
                    "WIRING motion_plan turn_id=%s inline_anim_detected=%s inline_plan_valid=%s "
                    "inline_mode=%s route=secondary_request",
                    turn_id or "",
                    inline_anim_detected,
                    inline_plan is not None,
                    inline_mode or "",
                )

        schedule_text = reply_text
        if not schedule_text and inline_anim_detected and inline_plan is None:
            schedule_text = str(getattr(self.session_state, "last_user_text", "") or "").strip()
        if schedule_text:
            self._schedule_realtime_motion_plan_preview(
                reply_text=schedule_text,
                origin_turn_id=turn_id,
            )

        if picture_paths:
            await self._send_json(
                build_output_image(
                    session_id=session_id,
                    turn_id=turn_id,
                    images=picture_paths,
                )
            )

        if record_paths:
            record_path = record_paths[0]
            _, audio_url = self.media_service.cache_audio_file(record_path)
            await self._send_json(
                build_output_audio(
                    session_id=session_id,
                    turn_id=turn_id,
                    audio_url=audio_url,
                    text=reply_text,
                    speaker_name=self.speaker_name,
                    avatar="",
                )
            )
            self._mark_turn_timing("audio_payload_sent_at")
            await self._send_json(
                build_control_synth_finished(
                    session_id=session_id,
                    turn_id=turn_id,
                )
            )
            self.session_state.mark_synthesizing()
            self.session_state.mark_playing()
            return

        await self._finish_turn(success=True, reason=None)

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
        if turn_id and current_turn_id and turn_id != current_turn_id:
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

            current_turn_id = self.session_state.begin_turn(message_obj.message_str, turn_id=turn_id)
            self._begin_turn_timing(message_obj.message_str)
            self.chat_buffer.add("user", message_obj.message_str)
            await self._send_json(
                build_control_turn_started(
                    session_id=self.session_state.client_uid,
                    turn_id=current_turn_id,
                )
            )
            await self._emit_image_input_diagnostics(message_obj)

            event = self._build_platform_event(message_obj)
            self._commit_event(event)
            self._mark_turn_timing("event_committed_at")
            logger.debug(
                "Turn timing start: turn=%s text_len=%d turn_id=%s",
                self._current_turn_index(),
                len(message_obj.message_str or ""),
                current_turn_id,
            )

    async def _emit_image_input_diagnostics(self, message_obj) -> None:
        raw_message = getattr(message_obj, "raw_message", None)
        if not isinstance(raw_message, dict):
            return

        diagnostics = raw_message.get("image_input_diagnostics")
        if not isinstance(diagnostics, list) or not diagnostics:
            return

        cooldown_diagnostics = [
            item for item in diagnostics
            if isinstance(item, dict) and str(item.get("reason") or "").strip() == "cooldown_window"
        ]
        if cooldown_diagnostics:
            remaining_seconds = max(
                int(str(item.get("remaining_seconds") or "0") or "0")
                for item in cooldown_diagnostics
            )
            cooldown_message = (
                "Image input skipped by cooldown window. "
                f"Wait about {remaining_seconds}s, or set `image_cooldown_seconds` to 0."
            )
            logger.info("Image input diagnostics: %s", cooldown_message)
            await self._send_json(
                build_control_error(
                    session_id=self.session_state.client_uid,
                    turn_id=self.session_state.current_turn_id,
                    message=cooldown_message,
                )
            )

        actionable_reasons = [
            str(item.get("reason") or "").strip()
            for item in diagnostics
            if isinstance(item, dict)
            and str(item.get("reason") or "").strip()
            and str(item.get("reason") or "").strip() != "cooldown_window"
        ]
        if not actionable_reasons:
            return

        counts: dict[str, int] = {}
        for reason in actionable_reasons:
            counts[reason] = counts.get(reason, 0) + 1

        parts = [
            f"{count} image(s) {self._describe_image_input_reason(reason)}"
            for reason, count in counts.items()
        ]
        message = "Some images were ignored: " + "; ".join(parts) + "."
        logger.warning("Image input diagnostics: %s", message)
        await self._send_json(
            build_control_error(
                session_id=self.session_state.client_uid,
                turn_id=self.session_state.current_turn_id,
                message=message,
            )
        )

    @staticmethod
    def _describe_image_input_reason(reason: str) -> str:
        descriptions = {
            "unsupported_image_payload": "used an unsupported payload format",
            "unsupported_data_uri": "used an unsupported data URI format",
            "invalid_base64_payload": "could not be decoded",
            "invalid_local_path": "used an invalid local file path",
            "local_path_outside_allowed_roots": "were outside the allowed local folders",
            "unsupported_local_suffix": "used an unsupported local file suffix",
            "local_read_failed": "could not be read from disk",
            "image_too_large": "were too large",
            "empty_image_payload": "were empty",
        }
        return descriptions.get(reason, "failed validation")

    async def _handle_audio_end(self, message) -> None:
        message_obj = await self.speech_ingress.handle_audio_end(message)
        if message_obj is None:
            return
        await self._commit_inbound_message(message_obj, turn_id=message.turn_id)

    async def _handle_interrupt_signal(self, turn_id: str | None) -> None:
        session_id = self.session_state.client_uid
        current_turn_id = self.session_state.current_turn_id
        if turn_id and current_turn_id and turn_id != current_turn_id:
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
                session_id=session_id,
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

    async def _handle_engine_motion_plan_preview(self, message) -> None:
        payload = message.payload if isinstance(message.payload, dict) else {}
        plan_payload = payload.get("plan")
        mode = str(payload.get("mode") or "preview")
        step_count = 0
        if isinstance(plan_payload, dict):
            steps = plan_payload.get("steps")
            if isinstance(steps, list):
                step_count = len(steps)

        logger.info(
            "Received engine motion plan preview (mode=%s, steps=%s, turn_id=%s).",
            mode,
            step_count,
            message.turn_id or "",
        )
        # Phase-1/2 bridge stub: accept and record the preview plan so frontend
        # testing won't be blocked by protocol rejection before engine playback lands.
        return

    async def broadcast_motion_plan_preview(
        self,
        *,
        plan: Any,
        mode: str = "preview",
        source: str = "debug_port",
        turn_id: str | None = None,
    ) -> bool:
        if not isinstance(plan, dict):
            return False

        resolved_turn_id = turn_id if turn_id is not None else self.session_state.current_turn_id
        payload = {
            "mode": str(mode or "preview"),
            "plan": plan,
            "source": str(source or "debug_port"),
        }
        sent = await self._send_json(
            build_message_envelope(
                TYPE_ENGINE_MOTION_PLAN,
                session_id=self.session_state.client_uid,
                turn_id=resolved_turn_id,
                source=SOURCE_ENGINE,
                payload=payload,
            )
        )
        if sent:
            logger.info(
                "Broadcasted engine motion plan preview from debug ingress "
                "(mode=%s, turn_id=%s).",
                payload["mode"],
                resolved_turn_id or "",
            )
        return sent

    def _schedule_realtime_motion_plan_preview(
        self,
        *,
        reply_text: str,
        origin_turn_id: str | None = None,
    ) -> None:
        if self._generate_realtime_motion_plan is None:
            return

        assistant_text = (reply_text or "").strip()
        if not assistant_text:
            return

        user_text = str(getattr(self.session_state, "last_user_text", "") or "")
        if origin_turn_id is None:
            origin_turn_id = self.session_state.current_turn_id
        self._spawn_background_task(
            self._generate_and_broadcast_realtime_motion_plan(
                user_text=user_text,
                assistant_text=assistant_text,
                origin_turn_id=origin_turn_id,
            )
        )

    async def _generate_and_broadcast_realtime_motion_plan(
        self,
        *,
        user_text: str,
        assistant_text: str,
        origin_turn_id: str | None,
    ) -> None:
        if self._generate_realtime_motion_plan is None:
            return

        try:
            plan = await self._generate_realtime_motion_plan(
                user_text=user_text,
                assistant_text=assistant_text,
            )
        except Exception as exc:
            logger.warning("Realtime motion plan generation failed: %s", exc)
            return

        if not isinstance(plan, dict):
            return

        steps = plan.get("steps")
        if not isinstance(steps, list) or not steps:
            return

        current_turn_id = self.session_state.current_turn_id
        if origin_turn_id and current_turn_id and current_turn_id != origin_turn_id:
            logger.debug(
                "Skip realtime motion plan for stale turn_id=%s current_turn_id=%s",
                origin_turn_id,
                current_turn_id,
            )
            return

        mode = "realtime"
        if self._realtime_motion_mode_getter is not None:
            resolved_mode = str(self._realtime_motion_mode_getter() or "").strip()
            if resolved_mode:
                mode = resolved_mode

        await self.broadcast_motion_plan_preview(
            plan=plan,
            mode=mode,
            source="engine.realtime_motion_plan",
            turn_id=origin_turn_id,
        )

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
                session_id=self.session_state.client_uid,
                turn_id=current_turn_id,
                success=success,
                reason=reason,
            )
        )
        self._mark_turn_timing("turn_completed_at")
        if self.session_state.waiting_for_playback_complete:
            self.session_state.mark_playback_complete()
        else:
            self.session_state.reset_to_idle()

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


def _iter_message_chain(message_chain) -> list[Any]:
    if message_chain is None:
        return []
    if hasattr(message_chain, "chain") and isinstance(message_chain.chain, list):
        return message_chain.chain
    if isinstance(message_chain, list):
        return message_chain
    return [message_chain]


def _extract_outbound_message_parts(message_chain) -> tuple[list[str], list[str], list[str]]:
    texts: list[str] = []
    picture_paths: list[str] = []
    record_paths: list[str] = []

    for component in _iter_message_chain(message_chain):
        component_text = getattr(component, "text", None)
        if isinstance(component, Plain) and isinstance(component_text, str) and component_text.strip():
            texts.append(component_text.strip())
            continue

        image_path = getattr(component, "file", None)
        if isinstance(component, Image) and isinstance(image_path, str) and image_path:
            picture_paths.append(image_path)
            continue

        if not isinstance(component, Record):
            continue

        if isinstance(component_text, str) and component_text.strip():
            texts.append(component_text.strip())

        if isinstance(image_path, str) and image_path:
            record_paths.append(image_path)

    return texts, picture_paths, record_paths


def _coerce_perf_counter(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _extract_inline_motion_plan(text: str) -> tuple[str, dict[str, Any] | None, str | None]:
    normalized = str(text or "")
    if not normalized:
        return "", None, None

    matches = list(INLINE_ANIM_TAG_PATTERN.finditer(normalized))
    cleaned_text = _strip_inline_anim_tags(normalized)
    if not matches:
        return cleaned_text, None, None

    for match in reversed(matches):
        payload = _parse_inline_anim_tag(match.group(0))
        if not isinstance(payload, dict):
            continue
        plan, mode = _normalize_inline_anim_payload(payload)
        if isinstance(plan, dict):
            return cleaned_text, plan, mode

    return cleaned_text, None, None


def _parse_inline_anim_tag(tag_text: str) -> dict[str, Any] | None:
    text = str(tag_text or "")
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    payload_text = text[start : end + 1]
    try:
        payload = json.loads(payload_text)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _normalize_inline_anim_payload(
    payload: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    mode_value = payload.get("mode")
    mode = str(mode_value).strip() if isinstance(mode_value, str) else "inline"
    mode = mode or "inline"

    if isinstance(payload.get("plan"), dict):
        plan = payload["plan"]
    else:
        plan = payload

    steps = plan.get("steps") if isinstance(plan, dict) else None
    if not isinstance(steps, list) or not steps:
        return None, None

    return plan, mode


def _strip_inline_anim_tags(text: str) -> str:
    cleaned = INLINE_ANIM_TAG_PATTERN.sub("", str(text or ""))

    while True:
        marker = INLINE_ANIM_START_PATTERN.search(cleaned)
        if marker is None:
            break

        start = marker.start()
        end_gt = cleaned.find(">", start)
        end_newline = cleaned.find("\n", start)

        if end_gt != -1 and (end_newline == -1 or end_gt < end_newline):
            end = end_gt + 1
        elif end_newline != -1:
            end = end_newline
        else:
            end = len(cleaned)

        cleaned = cleaned[:start] + cleaned[end:]

    return cleaned.strip()
