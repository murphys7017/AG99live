from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable

from astrbot.api import logger
from astrbot.api.message_components import Image, Plain, Record
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.platform.message_type import MessageType
from astrbot.core.utils.active_event_registry import active_event_registry

from .payload_builder import (
    build_audio_payload,
    build_backend_synth_complete,
    build_control,
    build_error,
    build_force_new_message,
    build_full_text,
)
from .protocol import ProtocolError
from .speech_ingress import SpeechIngressService


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
        handle_frontend_compat: Callable[[dict[str, Any]], Awaitable[None]],
        refresh_runtime_settings: Callable[[], None],
        send_current_model_and_conf: Callable[[], Awaitable[None]],
        send_json: Callable[[dict[str, Any]], Awaitable[bool]],
        build_platform_event: Callable[[Any], Any],
        commit_event: Callable[[Any], None],
        ensure_vad_engine: Callable[[], Any],
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
        self.speech_ingress = SpeechIngressService(
            media_service=self.media_service,
            runtime_state=self.runtime_state,
            ensure_vad_engine=self._ensure_vad_engine,
            send_json=self._send_json,
            build_message_object=self._build_message_object,
        )

        self._turn_lock = asyncio.Lock()
        self._turn_timing: dict[str, Any] = {}

    async def handle_msg(self, message: dict[str, Any]) -> None:
        msg_type = message.get("type")

        if msg_type in {
            "fetch-backgrounds",
            "fetch-history-list",
            "create-new-history",
            "fetch-and-set-history",
            "delete-history",
            "heartbeat",
            "audio-play-start",
        }:
            await self._handle_frontend_compat(message)
            return

        if msg_type == "frontend-playback-complete":
            success_raw = message.get("success")
            success = success_raw if isinstance(success_raw, bool) else True
            reason_raw = message.get("reason")
            reason = reason_raw.strip() if isinstance(reason_raw, str) and reason_raw.strip() else None
            await self.finalize_turn(success=success, reason=reason)
            return

        if msg_type == "interrupt-signal":
            await self._handle_interrupt_signal()
            return

        if msg_type == "audio-stream-start":
            await self.speech_ingress.handle_audio_stream_start(message)
            return

        if msg_type == "audio-stream-chunk":
            await self.speech_ingress.handle_audio_stream_chunk(message)
            return

        if msg_type == "audio-stream-end":
            message_obj = await self.speech_ingress.handle_audio_stream_end(message)
            if message_obj is not None:
                await self._commit_inbound_message(message_obj)
            return

        if msg_type == "audio-stream-interrupt":
            await self.speech_ingress.handle_audio_stream_interrupt(message.get("stream_id"))
            return

        if msg_type == "mic-audio-data":
            await self.speech_ingress.handle_audio_data(message)
            return

        if msg_type == "raw-audio-data":
            await self.speech_ingress.handle_raw_audio_data(message)
            return

        if msg_type == "mic-audio-end":
            await self._handle_audio_end(message)
            return

        try:
            message_obj = self._convert_message(message)
        except ProtocolError as exc:
            logger.debug("Ignoring unsupported message: %s", exc)
            return

        await self._commit_inbound_message(message_obj)

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

        self._mark_turn_timing("emit_started_at")
        texts, picture_paths, record_paths = _extract_outbound_message_parts(message_chain)

        reply_text = "\n".join(texts).strip()
        has_audio_reply = bool(record_paths)
        actions = {"pictures": picture_paths} if picture_paths else None

        if reply_text and not has_audio_reply:
            self.chat_buffer.add("assistant", reply_text)
            await self._send_json(build_full_text(reply_text))

        if has_audio_reply:
            record_path = record_paths[0]
            cached_audio_path, audio_url = self.media_service.cache_audio_file(record_path)
            await self._send_json(
                build_audio_payload(
                    audio_path=cached_audio_path,
                    audio_url=audio_url,
                    text=reply_text,
                    speaker_name=self.speaker_name,
                    avatar="",
                    action_mapping=actions,
                )
            )
            self._mark_turn_timing("audio_payload_sent_at")
            await self._send_json(build_backend_synth_complete())
            self.session_state.mark_playing()
            return

        if actions:
            await self._send_json(
                build_audio_payload(
                    audio_path="",
                    audio_url=None,
                    text=reply_text,
                    speaker_name=self.speaker_name,
                    avatar="",
                    action_mapping=actions,
                )
            )
            self._mark_turn_timing("audio_payload_sent_at")

        if reply_text:
            self.session_state.reset_to_idle()
            await self._send_json(build_backend_synth_complete())
            await self._send_json(build_force_new_message())
            await self._send_json(build_control("conversation-chain-end"))
            self._mark_turn_timing("turn_completed_at")

    async def finalize_turn(self, *, success: bool = True, reason: str | None = None) -> None:
        if not self.session_state.waiting_for_playback_complete:
            return

        await self._send_json(build_force_new_message())
        await self._send_json(build_control("conversation-chain-end"))
        self.session_state.mark_playback_complete()
        self._mark_turn_timing("playback_completed_at")
        logger.debug(
            "Turn timing playback: turn=%s playback_ms=%.1f total_ms=%.1f success=%s reason=%s",
            self._current_turn_index(),
            self._elapsed_ms("audio_payload_sent_at", "playback_completed_at"),
            self._elapsed_ms("received_at", "playback_completed_at"),
            success,
            reason or "",
        )

    async def _commit_inbound_message(self, message_obj) -> None:
        async with self._turn_lock:
            if self.session_state.waiting_for_playback_complete:
                await self.finalize_turn()

            self.session_state.begin_turn(message_obj.message_str)
            self._begin_turn_timing(message_obj.message_str)
            self.chat_buffer.add("user", message_obj.message_str)
            await self._send_json(build_control("conversation-chain-start"))
            await self._emit_image_input_diagnostics(message_obj)

            event = self._build_platform_event(message_obj)
            self._commit_event(event)
            self._mark_turn_timing("event_committed_at")
            logger.debug(
                "Turn timing start: turn=%s text_len=%d",
                self._current_turn_index(),
                len(message_obj.message_str or ""),
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
            await self._send_json(build_error(cooldown_message))

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
        await self._send_json(build_error(message))

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

    async def _handle_audio_end(self, message: dict[str, Any]) -> None:
        message_obj = await self.speech_ingress.handle_audio_end(message)
        if message_obj is None:
            return
        await self._commit_inbound_message(message_obj)

    async def _handle_interrupt_signal(self) -> None:
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
        self.session_state.reset_to_idle()
        await self.media_service.clear_audio_buffer()

        logger.info(
            "Processed interrupt-signal for turn=%s stopped_events=%s umo=%s",
            self._current_turn_index(),
            stopped_count,
            umo,
        )

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
