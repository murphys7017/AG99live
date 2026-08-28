"""后端轮次编排中枢。

TurnCoordinator 把"前端协议消息 ↔ AstrBot 事件总线 ↔ 出站回放"绑在一起，
是这条链路上唯一同时持有协议侧轮次身份与业务侧轮次生命周期的对象。

入站
    1. 接收 transport 解码出的 JSON dict / 二进制帧，并在本层完成协议解析。
    2. handle_msg 按 message.type 路由：
         - system.*                                        → _handle_frontend_system
         - control.playback_finished                       → finalize_turn
         - control.interrupt                               → _handle_interrupt_signal
         - input.audio_stream_*                            → SpeechIngressService
         - input.text                                      → _commit_inbound_message
    3. 除 system.* 外，交互类 message.type 都要求 turn_id 非空
       （_require_interactive_turn_id）；前端 turn_id 通过 turn_identity_map 与
       后端 turn_id 互相绑定。

出站
    4. emit_message_chain 把输出交给 OutputSegmentCoordinator 合并为 logical output segment。
    5. close_turn_output_queue 委托 OutputSegmentCoordinator 原子发送 output.segment，
       再发 control.synth_finished。
    6. finalize_turn → _finish_turn 在收到前端 control.playback_finished（或被打断）
       后发 control.turn_finished 并把 session_state 切回 idle。

边界
    - 不直接读写 WebSocket：所有出站都走注入的 send_json 回调。
    - 信封形状解析集中交给 protocol/parser.py，由本层在入口调用。
    - 出站信封交给 protocol/builder.py；动作作为 output.segment 的一个原子槽位发送。
    - 不感知动作语义内部细节：动作 payload 的提取、规范化在 motion/* 与 middleware/*，
      本中枢只决定"何时把动作 payload 广播给前端"。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable
from uuid import uuid4

from astrbot.api import logger

from ..protocol.builder import (
    build_control_error,
    build_control_interrupt,
    build_control_turn_finished,
    build_control_turn_started,
)
from ..protocol.binary_audio import parse_binary_audio_frame
from ..protocol.constants import (
    SOURCE_ADAPTER,
    TYPE_CONTROL_INTERRUPT,
    TYPE_CONTROL_PLAYBACK_FINISHED,
    TYPE_INPUT_AUDIO_STREAM_END,
    TYPE_INPUT_AUDIO_STREAM_START,
    TYPE_INPUT_TEXT,
)
from ..protocol.parser import build_message_envelope, parse_inbound_message
from ..services.speech_service import SpeechIngressService
from .image_diagnostics import (
    emit_image_input_diagnostics,
)
from .motion_observation_recorder import MotionObservationRecorder
from .output_segment_coordinator import OutputSegmentCoordinator
from .performance_curve_coordinator import PerformanceCurveCoordinator


MAX_REMEMBERED_TERMINAL_TURNS = 256
class TurnCoordinator:
    """后端单连接的协议+轮次编排器。

    一个 WebSocket 会话对应一个 TurnCoordinator 实例：内部以 _turn_lock 串行化轮次
    生命周期事件，避免"上一轮没收口就被下一轮覆盖"。它只持有 Turn 身份、终态、事件
    和连接级清理状态；输出段、观察与可选曲线状态由各自协调器持有，跨连接不共享。
    """

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
            on_vad_speech_started=self._handle_vad_speech_started,
        )

        self._turn_lock = asyncio.Lock()
        self._turn_timings: dict[str, dict[str, Any]] = {}
        self._events_by_turn_id: dict[str, Any] = {}
        self.motion_observations = MotionObservationRecorder(
            runtime_state=self.runtime_state,
            session_state=self.session_state,
            chat_buffer=self.chat_buffer,
        )
        self.performance_curves = PerformanceCurveCoordinator(
            runtime_state=self.runtime_state,
            observations=self.motion_observations,
        )
        self._turn_terminal_results: dict[str, tuple[bool, str | None] | None] = {}
        self._active_vad_turn_by_capture_turn: dict[str, str] = {}
        self.output_segments = OutputSegmentCoordinator(
            runtime_state=self.runtime_state,
            media_service=self.media_service,
            chat_buffer=self.chat_buffer,
            speaker_name=self.speaker_name,
            send_json=self._send_json,
            performance_curves=self.performance_curves,
            observations=self.motion_observations,
            is_turn_terminal=lambda turn_id: turn_id in self._turn_terminal_results,
            is_official_inline_anim_compat_enabled=(
                self._allows_official_inline_anim_compat
            ),
            finish_turn=self._finish_turn,
            mark_turn_timing=self._mark_turn_timing,
            mark_turn_synthesizing=self._mark_turn_synthesizing,
            mark_turn_playing=self._mark_turn_playing,
        )

    async def handle_msg(self, raw_message: dict[str, Any]) -> None:
        """入站文本协议消息的顶层路由。

        先经 parse_inbound_message 做协议校验，再按 message.type 分发到各个处理分支
        （详见模块 docstring 的入站表）。未识别类型回一条 control.error。
        system.* 与 engine preview 入口不要求 turn_id；其余交互类消息要求 turn_id 非空。
        """
        message = parse_inbound_message(raw_message)

        if message.type.startswith("system."):
            await self._handle_frontend_system(message)
            return


        turn_id = self._require_interactive_turn_id(message)

        if message.type == TYPE_CONTROL_PLAYBACK_FINISHED:
            success_raw = message.payload.get("success", True)
            success = success_raw if isinstance(success_raw, bool) else True
            reason_raw = message.payload.get("reason")
            reason = (
                reason_raw.strip()
                if isinstance(reason_raw, str) and reason_raw.strip()
                else None
            )
            await self.finalize_turn(turn_id=turn_id, success=success, reason=reason)
            return

        if message.type == TYPE_CONTROL_INTERRUPT:
            await self._handle_interrupt_signal(turn_id)
            return

        try:
            if message.type == TYPE_INPUT_AUDIO_STREAM_START:
                self._active_vad_turn_by_capture_turn.pop(turn_id, None)
                await self.speech_ingress.handle_audio_stream_start(message)
                return

            if message.type == TYPE_INPUT_AUDIO_STREAM_END:
                try:
                    message_obj = await self.speech_ingress.handle_audio_stream_end(message)
                    if message_obj is not None:
                        await self._commit_inbound_message(message_obj, turn_id=turn_id)
                finally:
                    self._active_vad_turn_by_capture_turn.pop(turn_id, None)
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
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "Inbound turn message failed: type=%s turn_id=%s",
                message.type,
                turn_id,
            )
            raise

    def reset_turn_tracking(self) -> None:
        """Stop active AstrBot events before discarding connection-scoped state."""
        cleanup_failures: list[str] = []
        try:
            active_events = tuple(self._events_by_turn_id.items())
            for turn_id, event in active_events:
                set_extra = getattr(event, "set_extra", None)
                if callable(set_extra):
                    try:
                        set_extra("agent_stop_requested", True)
                    except Exception:
                        cleanup_failures.append(f"{turn_id}:set_extra_failed")
                        logger.exception(
                            "Failed to mark active AstrBot event for disconnect stop: "
                            "turn_id=%s",
                            turn_id,
                        )
                else:
                    cleanup_failures.append(f"{turn_id}:set_extra_unavailable")
                    logger.error(
                        "Active AstrBot event cannot publish disconnect stop flag: "
                        "turn_id=%s",
                        turn_id,
                    )

                stop_event = getattr(event, "stop_event", None)
                if callable(stop_event):
                    try:
                        stop_event()
                    except Exception:
                        cleanup_failures.append(f"{turn_id}:stop_event_failed")
                        logger.exception(
                            "Failed to stop active AstrBot event during disconnect: "
                            "turn_id=%s",
                            turn_id,
                        )
                else:
                    cleanup_failures.append(f"{turn_id}:stop_event_unavailable")
                    logger.error(
                        "Active AstrBot event cannot be stopped during disconnect: "
                        "turn_id=%s",
                        turn_id,
                    )

            tracked_turn_ids = set(self._turn_timings)
            tracked_turn_ids.update(self.output_segments.tracked_turn_ids())
            tracked_turn_ids.update(self._turn_terminal_results)
            tracked_turn_ids.update(self._events_by_turn_id)
            cleanup_failures.extend(
                self.performance_curves.cancel_turns(tracked_turn_ids)
            )
        finally:
            self._turn_timings.clear()
            self.output_segments.reset()
            self._turn_terminal_results.clear()
            self._events_by_turn_id.clear()
            self._active_vad_turn_by_capture_turn.clear()
            self.motion_observations.reset()

        if cleanup_failures:
            raise RuntimeError(
                "turn_tracking_cleanup_incomplete:" + ",".join(cleanup_failures)
            )

    async def handle_binary_msg(self, raw_message: bytes) -> None:
        """WebSocket 二进制帧入口：解析 AG99 麦克风音频帧并交给语音入口。

        二进制路径只用于麦克风采集的 PCM16LE chunk（见 protocol/binary_audio.py）。
        持续收音的根 turn_id 只标识采集会话；每个 VAD 语音段必须使用
        SpeechIngressService 生成的 `:vad:N` 子轮次，避免多个用户输入重用同一
        播放会话身份。
        """
        frame = parse_binary_audio_frame(raw_message)
        message_obj = await self.speech_ingress.handle_audio_stream_binary_chunk(frame)
        if message_obj is not None:
            capture_turn_id = self._require_turn_id_value(frame.turn_id)
            turn_id = self._require_vad_child_turn_id(
                message_obj,
                capture_turn_id=capture_turn_id,
            )
            await self._commit_inbound_message(message_obj, turn_id=turn_id)
            self._active_vad_turn_by_capture_turn[capture_turn_id] = turn_id

    async def emit_message_chain(
        self,
        message_chain,
        turn_id: str,
        unified_msg_origin: str | None = None,
        raw_reply_text_override: str | None = None,
        platform_extras: dict[str, Any] | None = None,
    ) -> None:
        """Forward AstrBot's output callback to the segment owner."""
        await self.output_segments.emit_message_chain(
            message_chain,
            turn_id=turn_id,
            unified_msg_origin=unified_msg_origin,
            raw_reply_text_override=raw_reply_text_override,
            platform_extras=platform_extras,
        )

    async def begin_proactive_output_turn(self) -> str:
        """Create and announce a frontend turn for an AstrBot proactive send."""
        async with self._turn_lock:
            turn_id = f"proactive:{uuid4().hex}"
            current_turn_id = self.session_state.begin_turn("", turn_id=turn_id)
            self.turn_identity_map.register_frontend_turn(current_turn_id)
            self._begin_turn_timing(current_turn_id, "")
            sent = await self._send_json(
                build_control_turn_started(turn_id=current_turn_id)
            )
            if sent:
                return current_turn_id

            self.turn_identity_map.clear_frontend_turn(current_turn_id)
            self._turn_timings.pop(current_turn_id, None)
            if self.session_state.current_turn_id == current_turn_id:
                self.session_state.reset_to_idle()
            raise RuntimeError(f"turn_started_send_failed:{current_turn_id}")

    async def fail_proactive_output_turn(self, *, turn_id: str, reason: str) -> None:
        """Publish a failed proactive turn and discard its connection-owned state."""
        await self._finish_turn(
            turn_id=turn_id,
            success=False,
            reason=reason,
        )

    async def close_turn_output_queue(self, *, turn_id: str) -> None:
        """Forward output closure to the segment owner."""
        await self.output_segments.close_turn_output_queue(turn_id=turn_id)

    def _mark_turn_synthesizing(self, turn_id: str) -> None:
        if self.session_state.current_turn_id != turn_id:
            return
        mark_synthesizing = getattr(self.session_state, "mark_synthesizing", None)
        if callable(mark_synthesizing):
            mark_synthesizing()

    def _mark_turn_playing(self, turn_id: str) -> None:
        if self.session_state.current_turn_id != turn_id:
            return
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
        """收到 control.playback_finished 后收口本轮。

        播放完成信号按自身 turn_id 收口，不依赖最新输入轮次。这样 AstrBot 队列可以
        继续接收后续输入，而较早轮次仍能独立完成前端播放生命周期。
        """
        resolved_turn_id = self._normalize_optional_turn_value(turn_id)
        if not resolved_turn_id:
            raise ValueError("playback_finished_turn_id_missing")

        self._mark_turn_timing(resolved_turn_id, "playback_completed_at")
        playback_ms = self._elapsed_ms(
            resolved_turn_id,
            "audio_payload_sent_at",
            "playback_completed_at",
        )
        total_ms = self._elapsed_ms(
            resolved_turn_id,
            "received_at",
            "playback_completed_at",
        )
        await self._finish_turn(
            turn_id=resolved_turn_id,
            success=success,
            reason=reason,
        )
        logger.debug(
            "Turn timing playback: turn_id=%s playback_ms=%.1f total_ms=%.1f success=%s reason=%s",
            resolved_turn_id,
            playback_ms,
            total_ms,
            success,
            reason or "",
        )

    async def _commit_inbound_message(self, message_obj, *, turn_id: str | None = None) -> None:
        async with self._turn_lock:
            normalized_turn_id = self._require_turn_id_value(turn_id)
            backend_turn_id = self._resolve_backend_turn_id(message_obj, frontend_turn_id=normalized_turn_id)
            turn_identity_map = getattr(self, "turn_identity_map", None)
            if turn_identity_map is not None:
                turn_identity_map.register_bound_turn(
                    frontend_turn_id=normalized_turn_id,
                    backend_turn_id=backend_turn_id,
                )
            sent = await self._send_json(
                build_control_turn_started(
                    turn_id=normalized_turn_id,
                )
            )
            if not sent:
                if turn_identity_map is not None:
                    turn_identity_map.clear_frontend_turn(normalized_turn_id)
                raise RuntimeError(f"turn_started_send_failed:{normalized_turn_id}")

            current_turn_id = normalized_turn_id
            try:
                current_turn_id = self.session_state.begin_turn(
                    message_obj.message_str,
                    turn_id=normalized_turn_id,
                )
                self._begin_turn_timing(current_turn_id, message_obj.message_str)
                await self._emit_image_input_diagnostics(
                    message_obj,
                    turn_id=current_turn_id,
                )

                event = self._build_platform_event(message_obj)
                set_extra = getattr(event, "set_extra", None)
                if callable(set_extra):
                    set_extra("enable_streaming", False)
                    set_extra("output_correlation_id", current_turn_id)
                self._apply_raw_message_metadata_to_event(event, message_obj)
                self._events_by_turn_id[current_turn_id] = event
                self._commit_event(event)
            except Exception:
                self._events_by_turn_id.pop(current_turn_id, None)
                await self._finish_turn(
                    turn_id=current_turn_id,
                    success=False,
                    reason="event_commit_failed",
                )
                raise
            self.chat_buffer.add("user", message_obj.message_str)
            self.motion_observations.record_motion_lab_raw_event(
                event_type="turn.input_received",
                turn_id=current_turn_id,
                frontend_turn_id=normalized_turn_id,
                message_id=getattr(message_obj, "message_id", None),
                source_route="input.text",
                phase="input",
                user_text=message_obj.message_str,
                raw={
                    "backend_turn_id": backend_turn_id,
                    "frontend_turn_id": normalized_turn_id,
                    "message_str": message_obj.message_str,
                    "raw_message": getattr(message_obj, "raw_message", None),
                    "chat_context": self.motion_observations.motion_lab_chat_context(),
                },
            )
            self._mark_turn_timing(current_turn_id, "event_committed_at")
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
        """从后端侧主动注入一条文本作为新一轮交互（用于 remote operator 等中间件）。

        等价于"前端发了一条 input.text"：分配 turn_id 前缀 remote-operator:、
        组装一份完整信封、通过 _build_message_object 合成 message 对象、
        再走 _commit_inbound_message 进入轮次生命周期。空文本直接 return。
        metadata 会合并进 raw_message，供下游识别注入来源（如 ag99live_input_source）。
        """
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

    async def _emit_image_input_diagnostics(
        self,
        message_obj,
        *,
        turn_id: str,
    ) -> None:
        await emit_image_input_diagnostics(
            message_obj=message_obj,
            client_uid=self.session_state.client_uid,
            current_turn_id=turn_id,
            send_json=self._send_json,
        )

    async def _handle_interrupt_signal(self, turn_id: str | None) -> None:
        resolved_turn_id = self._normalize_optional_turn_value(turn_id)
        if not resolved_turn_id:
            raise ValueError("interrupt_turn_id_missing")

        stopped_count = 0
        event = self._events_by_turn_id.get(resolved_turn_id)
        if event is not None:
            set_extra = getattr(event, "set_extra", None)
            if callable(set_extra):
                set_extra("agent_stop_requested", True)
            stop_event = getattr(event, "stop_event", None)
            if callable(stop_event):
                stop_event()
                stopped_count = 1
        await self._send_json(
            build_control_interrupt(
                turn_id=resolved_turn_id,
            )
        )
        await self._finish_turn(
            turn_id=resolved_turn_id,
            success=False,
            reason="interrupted",
        )

        logger.info(
            "Processed control.interrupt for turn_id=%s stopped_events=%s",
            resolved_turn_id,
            stopped_count,
        )

    def _allows_official_inline_anim_compat(self) -> bool:
        runtime_state = getattr(self, "runtime_state", None)
        return (
            getattr(
                runtime_state,
                "ag99live_motion_persona_effect_available",
                True,
            )
            is False
        )

    async def _finish_turn(
        self,
        *,
        turn_id: str,
        success: bool,
        reason: str | None,
    ) -> None:
        resolved_turn_id = self._require_turn_id_value(turn_id)
        normalized_reason = str(reason or "").strip() or None
        terminal_result = (success, normalized_reason)
        if resolved_turn_id in self._turn_terminal_results:
            existing_result = self._turn_terminal_results[resolved_turn_id]
            if existing_result is None:
                logger.debug(
                    "Turn terminal publication already in progress: turn_id=%s",
                    resolved_turn_id,
                )
            elif existing_result != terminal_result:
                logger.warning(
                    "Conflicting Turn terminal ignored: turn_id=%s existing=%s incoming=%s",
                    resolved_turn_id,
                    existing_result,
                    terminal_result,
                )
            self._turn_timings.pop(resolved_turn_id, None)
            return

        self._turn_terminal_results[resolved_turn_id] = None
        try:
            sent = await self._send_json(
                build_control_turn_finished(
                    turn_id=resolved_turn_id,
                    success=success,
                    reason=normalized_reason,
                )
            )
            if not sent:
                raise RuntimeError(f"turn_finished_send_failed:{resolved_turn_id}")
        except Exception:
            self._turn_terminal_results.pop(resolved_turn_id, None)
            raise

        self._turn_terminal_results[resolved_turn_id] = terminal_result
        self._prune_turn_terminal_results()
        turn_identity_map = getattr(self, "turn_identity_map", None)
        if turn_identity_map is not None:
            turn_identity_map.clear_frontend_turn(resolved_turn_id)
        self._events_by_turn_id.pop(resolved_turn_id, None)
        if self.session_state.current_turn_id == resolved_turn_id:
            self.session_state.reset_to_idle()
        self.output_segments.clear_turn(resolved_turn_id)
        try:
            self.performance_curves.cancel_turn(resolved_turn_id)
        except Exception:  # noqa: BLE001 - optional cleanup cannot reopen a terminal turn.
            logger.exception(
                "Failed to cancel performance curve after Turn termination: turn_id=%s",
                resolved_turn_id,
            )
        self._clear_active_vad_turn(resolved_turn_id)
        self._turn_timings.pop(resolved_turn_id, None)

    def _prune_turn_terminal_results(self) -> None:
        completed_count = sum(
            result is not None for result in self._turn_terminal_results.values()
        )
        excess = completed_count - MAX_REMEMBERED_TERMINAL_TURNS
        if excess <= 0:
            return
        for turn_id, result in tuple(self._turn_terminal_results.items()):
            if excess <= 0:
                break
            if result is None:
                continue
            self._turn_terminal_results.pop(turn_id, None)
            excess -= 1

    async def _handle_vad_speech_started(self, capture_turn_id: str) -> None:
        normalized_capture_turn_id = self._require_turn_id_value(capture_turn_id)
        active_turn_id = self._active_vad_turn_by_capture_turn.get(
            normalized_capture_turn_id
        )
        if not active_turn_id:
            return
        if active_turn_id not in self._events_by_turn_id:
            self._active_vad_turn_by_capture_turn.pop(normalized_capture_turn_id, None)
            return
        await self._handle_interrupt_signal(active_turn_id)

    def _require_vad_child_turn_id(
        self,
        message_obj,
        *,
        capture_turn_id: str,
    ) -> str:
        raw_message = getattr(message_obj, "raw_message", None)
        if not isinstance(raw_message, dict):
            raise ValueError("vad_message_raw_message_missing")
        child_turn_id = self._normalize_optional_turn_value(raw_message.get("turn_id"))
        expected_prefix = f"{capture_turn_id}:vad:"
        if not child_turn_id or not child_turn_id.startswith(expected_prefix):
            raise ValueError(
                f"vad_message_turn_id_invalid:{capture_turn_id}:{child_turn_id or 'missing'}"
            )
        child_sequence = child_turn_id[len(expected_prefix):]
        if not child_sequence.isdecimal() or int(child_sequence) <= 0:
            raise ValueError(f"vad_message_turn_sequence_invalid:{child_turn_id}")
        return child_turn_id

    def _clear_active_vad_turn(self, turn_id: str) -> None:
        for capture_turn_id, active_turn_id in tuple(
            self._active_vad_turn_by_capture_turn.items()
        ):
            if active_turn_id == turn_id:
                self._active_vad_turn_by_capture_turn.pop(capture_turn_id, None)

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

    @staticmethod
    def _normalize_optional_turn_value(value: object) -> str | None:
        if not isinstance(value, str):
            return None
        normalized = value.strip()
        return normalized or None

    def _current_turn_index(self) -> int:
        return int(getattr(self.session_state, "turn_index", 0) or 0)

    def _begin_turn_timing(self, turn_id: str, user_text: str) -> None:
        self._turn_timings[turn_id] = {
            "turn_index": self._current_turn_index(),
            "received_at": time.perf_counter(),
            "user_text_len": len(user_text or ""),
        }

    def _mark_turn_timing(
        self,
        turn_id: str,
        key: str,
        value: float | None = None,
    ) -> None:
        timing = self._turn_timings.setdefault(
            turn_id,
            {"turn_index": self._current_turn_index()},
        )
        timing[key] = time.perf_counter() if value is None else value

    def _elapsed_ms(self, turn_id: str, start_key: str, end_key: str) -> float:
        timing = self._turn_timings.get(turn_id, {})
        start_value = _coerce_perf_counter(timing.get(start_key))
        end_value = _coerce_perf_counter(timing.get(end_key))
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
