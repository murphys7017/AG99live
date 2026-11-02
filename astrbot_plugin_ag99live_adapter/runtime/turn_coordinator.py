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
    5. finalize_output_segment 在 Core 确认一个 logical message 的物理发送全部完成后，立即发送该段。
    6. close_turn_output_queue 确认没有 pending segment 后，再发 control.synth_finished。
    7. finalize_turn → _finish_turn 在收到前端 control.playback_finished（或被打断）
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
from collections.abc import Mapping
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
    TYPE_CONTROL_INTERRUPT,
    TYPE_CONTROL_PLAYBACK_FINISHED,
    TYPE_INPUT_AUDIO_STREAM_END,
    TYPE_INPUT_AUDIO_STREAM_SEAL,
    TYPE_INPUT_AUDIO_STREAM_START,
    TYPE_INPUT_TEXT,
    SOURCE_ADAPTER,
    SOURCE_FRONTEND,
)
from ..protocol.parser import parse_inbound_message
from ..protocol.parser import build_message_envelope
from ..providers.contracts import (
    AvatarOutputPort,
    ControlEvent,
    ConversationEvent,
    ConversationEventKind,
    ConversationInput,
    SegmentBoundary,
)
from ..services.speech_service import SpeechIngressService
from .pre_action import PreActionRuntime
from .adapter_event_context import resolve_adapter_event_context
from .persona_lifecycle import PersonaTurnIdentity
from .conversation_observation_window import ConversationObservationWindow
from .image_diagnostics import (
    emit_image_input_diagnostics,
)
from .motion_observation_recorder import MotionObservationRecorder
from .output_segment_coordinator import OutputSegmentCoordinator
from .performance_curve_coordinator import PerformanceCurveCoordinator
from .incremental_output import IncrementalOutputSession, SendPayload
from .interaction_orchestrator import (
    FrontendMessageHandlers,
    InteractionOrchestrator,
)


MAX_REMEMBERED_TERMINAL_TURNS = 256
def _resolve_motion_work_turn_id(event: Any, fallback_turn_id: str) -> str:
    try:
        runtime_turn_id = resolve_adapter_event_context(event).core_turn_id
    except Exception:  # noqa: BLE001 - cleanup must retain its fallback.
        runtime_turn_id = ""
    if runtime_turn_id:
        return runtime_turn_id
    return str(fallback_turn_id or "").strip()


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
        output_port: AvatarOutputPort | None = None,
        build_platform_event: Callable[[Any], Any],
        commit_event: Callable[[Any], None],
        create_vad_engine: Callable[[], Any],
        input_preparation=None,
        external_conversation_submitter: Callable[[ConversationInput], Awaitable[None]] | None = None,
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
        self._output_port = output_port
        self._interaction_orchestrator = None
        self._build_platform_event = build_platform_event
        self._commit_event = commit_event
        self._create_vad_engine = create_vad_engine
        self._input_preparation = input_preparation
        self._external_conversation_submitter = external_conversation_submitter
        self._active_speech_capture_turns: set[str] = set()
        self._pre_action_input_id: str | None = None
        self.pre_action = PreActionRuntime(
            runtime_state=self.runtime_state, send_json=self._send_json,
            build_event=lambda: self._build_platform_event(
                self._build_message_object(text="", raw_message={})
            ),
        )
        self._passive_behavior_interrupt_handler: Callable[[], Awaitable[None]] | None = None
        self.speech_ingress = SpeechIngressService(
            media_service=self.media_service,
            runtime_state=self.runtime_state,
            create_vad_engine=self._create_vad_engine,
            send_json=self._send_json,
            build_message_object=self._build_message_object,
            on_vad_speech_started=self._handle_vad_speech_started,
            on_vad_speech_ended=self._handle_vad_speech_ended,
            on_capture_abandoned=self._handle_capture_abandoned,
            on_valid_transcription=self._handle_pre_action_text,
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
            runtime=self.runtime_state.performance_curve_runtime,
            is_enabled=lambda: self.runtime_state.enable_performance_curve,
            observations=self.motion_observations,
        )
        self._turn_terminal_results: dict[str, tuple[bool, str | None] | None] = {}
        self._turn_terminal_waiters: dict[
            str, list[asyncio.Future[tuple[bool, str | None]]]
        ] = {}
        self._terminating_turn_ids: set[str] = set()
        self._active_vad_turn_by_capture_turn: dict[str, str] = {}
        self._preparing_inputs: set[str] = set()
        self.observation_window = ConversationObservationWindow(
            lambda: bool(
                self._active_speech_capture_turns
                or self._events_by_turn_id
                or self._turn_timings
                or self._preparing_inputs
                or self._turn_lock.locked()
            )
        )
        self.output_segments = OutputSegmentCoordinator(
            runtime_state=self.runtime_state,
            media_service=self.media_service,
            chat_buffer=self.chat_buffer,
            speaker_name=self.speaker_name,
            send_json=self._send_json,
            output_port=self._output_port,
            interaction_orchestrator=self._interaction_orchestrator,
            performance_curves=self.performance_curves,
            observations=self.motion_observations,
            is_turn_terminal=lambda turn_id: turn_id in self._turn_terminal_results,
            finish_turn=self._finish_turn,
            mark_turn_timing=self._mark_turn_timing,
        )

    def attach_interaction_orchestrator(self, orchestrator) -> None:
        """Attach the neutral state owner without changing protocol behavior."""

        self._interaction_orchestrator = orchestrator
        self._turn_terminal_results = orchestrator.terminal_results
        self._turn_terminal_waiters = orchestrator.terminal_waiters
        self._terminating_turn_ids = orchestrator.terminating_turn_ids
        self._turn_timings = orchestrator.turn_timings
        self._events_by_turn_id = orchestrator.active_events
        self.output_segments.set_interaction_orchestrator(orchestrator)
        orchestrator.attach_turn_lifecycle(
            cleanup_terminal_turn=self._cleanup_after_terminal,
            mark_event_stop_requested=self._mark_event_stop_requested,
            control_sender=self._send_control_event,
        )

    @staticmethod
    def _mark_event_stop_requested(event: Any) -> None:
        resolve_adapter_event_context(event).set_agent_stop_requested(event)

    async def _send_control_event(self, event: ControlEvent) -> bool:
        return await self._send_json(
            build_message_envelope(
                event.type,
                source=SOURCE_ADAPTER,
                turn_id=event.turn_id,
                payload=dict(event.payload),
            )
        )

    async def _cleanup_after_terminal(
        self,
        turn_id: str,
        event: Any | None,
    ) -> None:
        """Release AstrBot/runtime-owned resources after neutral terminal commit."""

        self.observation_window.note_output_finished()
        self._prune_turn_terminal_results()
        self.turn_identity_map.clear_frontend_turn(turn_id)
        if self.session_state.current_turn_id == turn_id:
            self.session_state.reset_to_idle()
        self.output_segments.clear_turn(turn_id)
        try:
            self.performance_curves.cancel_turn(turn_id)
        except Exception:  # noqa: BLE001 - optional cleanup cannot reopen a terminal turn.
            logger.exception(
                "Failed to cancel performance curve after Turn termination: turn_id=%s",
                turn_id,
            )
        self._clear_active_vad_turn(turn_id)
        self._turn_timings.pop(turn_id, None)
        motion_work_turn_id = _resolve_motion_work_turn_id(event, turn_id)
        self.runtime_state.persona_sessions.clear_turn(
            PersonaTurnIdentity(motion_work_turn_id)
        )

    async def submit_provider_message(self, request: ConversationInput) -> None:
        """Submit a neutral ConversationProvider message through the current path.

        This is the first text vertical slice. It builds the same normalized
        ``input.text`` envelope used by the desktop client, then reuses the
        existing message conversion, Turn admission, AstrBot event creation,
        and output aggregation path. No alternate output or protocol path is
        introduced.
        """

        metadata = request.metadata
        images = metadata.get("images", []) if isinstance(metadata, Mapping) else []
        if not isinstance(images, list):
            raise ValueError("conversation_provider_images_invalid")
        raw_message = build_message_envelope(
            TYPE_INPUT_TEXT,
            source=SOURCE_FRONTEND,
            turn_id=request.turn_id,
            message_id=request.message_id,
            payload={"text": request.text, "images": list(images)},
        )
        message_obj = self._convert_message(raw_message)
        await self._commit_inbound_message(message_obj, turn_id=request.turn_id)

    def _frontend_message_handlers(self) -> FrontendMessageHandlers:
        """Bind AstrBot-specific operations to the neutral message dispatcher."""

        return FrontendMessageHandlers(
            require_turn_id=self._require_interactive_turn_id,
            handle_system=self._dispatch_system_message,
            handle_audio_credit=self._dispatch_audio_credit,
            handle_playback_finished=self._dispatch_playback_finished,
            handle_interrupt=self._dispatch_interrupt,
            handle_audio_start=self._dispatch_audio_start,
            handle_audio_seal=self._dispatch_audio_seal,
            handle_audio_end=self._dispatch_audio_end,
            handle_text=self._dispatch_text,
            handle_unhandled=self._dispatch_unhandled,
            handle_error=self._dispatch_error,
            handle_finally=self._dispatch_finally,
        )

    async def _dispatch_system_message(self, message: Any) -> None:
        if message.type in {
            "system.history_create",
            "system.history_load",
            "system.history_delete",
            "system.semantic_axis_profile_save",
        }:
            self._pre_action_input_id = None
            await self.pre_action.cancel()
        await self._handle_frontend_system(message)

    def _dispatch_audio_credit(
        self,
        turn_id: str,
        payload: Mapping[str, Any],
    ) -> None:
        self.output_segments.release_audio_credit(
            turn_id=turn_id,
            payload=payload,
        )

    async def _dispatch_playback_finished(
        self,
        turn_id: str,
        payload: Mapping[str, Any],
    ) -> None:
        success_raw = payload.get("success", True)
        success = success_raw if isinstance(success_raw, bool) else True
        reason_raw = payload.get("reason")
        reason = (
            reason_raw.strip()
            if isinstance(reason_raw, str) and reason_raw.strip()
            else None
        )
        await self.finalize_turn(turn_id=turn_id, success=success, reason=reason)

    async def _dispatch_interrupt(self, turn_id: str) -> None:
        await self._handle_interrupt_signal(turn_id)

    async def _dispatch_audio_start(self, message: Any, turn_id: str) -> None:
        self._active_vad_turn_by_capture_turn.pop(turn_id, None)
        self._active_speech_capture_turns.discard(turn_id)
        is_ptt = message.payload.get("capture_mode", "ptt") == "ptt"
        if is_ptt:
            self.observation_window.note_input()
            self._preparing_inputs.add(turn_id)
        await self.speech_ingress.handle_audio_stream_start(message)
        self._pre_action_input_id = turn_id
        await self.pre_action.begin(turn_id)
        if is_ptt:
            self._active_speech_capture_turns.add(turn_id)
            if self._input_preparation is not None:
                self._input_preparation.start(turn_id)
            async with self._turn_lock:
                await self._interrupt_passive_work()

    async def _dispatch_audio_seal(self, message: Any) -> None:
        await self.speech_ingress.handle_audio_stream_seal(message)

    async def _dispatch_audio_end(self, message: Any, turn_id: str) -> None:
        message_obj = None
        try:
            message_obj = await self.speech_ingress.handle_audio_stream_end(message)
            if message_obj is not None:
                await self._commit_inbound_message(message_obj, turn_id=turn_id)
        finally:
            if message_obj is None:
                await self.pre_action.cancel(turn_id)
            if self._input_preparation is not None:
                self._input_preparation.cancel(turn_id)
            self._active_vad_turn_by_capture_turn.pop(turn_id, None)
            self._active_speech_capture_turns.discard(turn_id)

    async def _dispatch_text(self, message: Any, turn_id: str) -> None:
        self.observation_window.note_input()
        self._preparing_inputs.add(turn_id)
        message_obj = self._convert_message(message.raw)
        self._pre_action_input_id = turn_id
        await self.pre_action.begin(turn_id)
        self.pre_action.trigger(message_obj.message_str, turn_id)
        await self._commit_inbound_message(message_obj, turn_id=turn_id)

    async def _dispatch_unhandled(self, message_type: str, turn_id: str) -> None:
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        message = f"Unhandled message type: {message_type}"
        if orchestrator is not None:
            await orchestrator.publish_protocol_error(
                turn_id=turn_id,
                code="unhandled_message_type",
                message=message,
            )
            return
        await self._send_json(build_control_error(turn_id=turn_id, message=message))

    async def _dispatch_error(self, turn_id: str, message: Any) -> None:
        await self.pre_action.cancel(turn_id)
        logger.exception(
            "Inbound turn message failed: type=%s turn_id=%s",
            message.type,
            turn_id,
        )

    def _dispatch_finally(self, message: Any, turn_id: str) -> None:
        if message.type in {TYPE_INPUT_TEXT, TYPE_INPUT_AUDIO_STREAM_START}:
            self._preparing_inputs.discard(turn_id)

    async def handle_msg(self, raw_message: dict[str, Any]) -> None:
        """入站文本协议消息的顶层路由。

        先经 parse_inbound_message 做协议校验，再按 message.type 分发到各个处理分支
        （详见模块 docstring 的入站表）。未识别类型回一条 control.error。
        system.* 与 engine preview 入口不要求 turn_id；其余交互类消息要求 turn_id 非空。
        """
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            await orchestrator.route_frontend_message(
                raw_message,
                self._frontend_message_handlers(),
            )
            return
        message = parse_inbound_message(raw_message)
        handlers_factory = getattr(self, "_frontend_message_handlers", None)
        if callable(handlers_factory):
            await InteractionOrchestrator.dispatch_frontend_message(
                message,
                handlers_factory(),
            )
            return
        # Test-only/minimal hosts may provide only the legacy method surface.
        await TurnCoordinator._handle_parsed_message(self, message)

    async def _handle_parsed_message(self, message) -> None:

        if message.type.startswith("system."):
            if message.type in {"system.history_create", "system.history_load", "system.history_delete",
                                "system.semantic_axis_profile_save"}:
                self._pre_action_input_id = None
                await self.pre_action.cancel()
            await self._handle_frontend_system(message)
            return


        turn_id = self._require_interactive_turn_id(message)

        if message.type == "control.audio_credit":
            self.output_segments.release_audio_credit(turn_id=turn_id, payload=message.payload)
            return

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
                self._active_speech_capture_turns.discard(turn_id)
                is_ptt = message.payload.get("capture_mode", "ptt") == "ptt"
                if is_ptt:
                    self.observation_window.note_input()
                    self._preparing_inputs.add(turn_id)
                await self.speech_ingress.handle_audio_stream_start(message)
                self._pre_action_input_id = turn_id
                await self.pre_action.begin(turn_id)
                if is_ptt:
                    self._active_speech_capture_turns.add(turn_id)
                    if self._input_preparation is not None:
                        self._input_preparation.start(turn_id)
                    async with self._turn_lock:
                        await self._interrupt_passive_work()
                return

            if message.type == TYPE_INPUT_AUDIO_STREAM_SEAL:
                await self.speech_ingress.handle_audio_stream_seal(message)
                return

            if message.type == TYPE_INPUT_AUDIO_STREAM_END:
                message_obj = None
                try:
                    message_obj = await self.speech_ingress.handle_audio_stream_end(message)
                    if message_obj is not None:
                        await self._commit_inbound_message(message_obj, turn_id=turn_id)
                finally:
                    if message_obj is None:
                        await self.pre_action.cancel(turn_id)
                    if self._input_preparation is not None:
                        self._input_preparation.cancel(turn_id)
                    self._active_vad_turn_by_capture_turn.pop(turn_id, None)
                    self._active_speech_capture_turns.discard(turn_id)
                return

            if message.type == TYPE_INPUT_TEXT:
                self.observation_window.note_input()
                self._preparing_inputs.add(turn_id)
                message_obj = self._convert_message(message.raw)
                self._pre_action_input_id = turn_id
                await self.pre_action.begin(turn_id)
                self.pre_action.trigger(message_obj.message_str, turn_id)
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
            await self.pre_action.cancel(turn_id)
            logger.exception(
                "Inbound turn message failed: type=%s turn_id=%s",
                message.type,
                turn_id,
            )
            raise

        finally:
            if message.type in {TYPE_INPUT_TEXT, TYPE_INPUT_AUDIO_STREAM_START}:
                self._preparing_inputs.discard(turn_id)

    def reset_turn_tracking(self) -> None:
        """Stop active AstrBot events before discarding connection-scoped state."""
        self.observation_window.note_input()
        self._preparing_inputs.clear()
        self.pre_action.reset()
        self._pre_action_input_id = None
        if self._input_preparation is not None:
            self._input_preparation.cancel()
        cleanup_failures: list[str] = []
        try:
            orchestrator = getattr(self, "_interaction_orchestrator", None)
            if orchestrator is not None:
                cleanup_failures.extend(orchestrator.reset_active_events())
            else:
                for turn_id, event in tuple(self._events_by_turn_id.items()):
                    cleanup_failures.extend(
                        self.cleanup_active_event(turn_id, event)
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
            orchestrator = getattr(self, "_interaction_orchestrator", None)
            if orchestrator is not None:
                orchestrator.clear_lifecycle_state()
                orchestrator.clear_active_events()
            self._turn_terminal_results.clear()
            for waiters in self._turn_terminal_waiters.values():
                for waiter in waiters:
                    if not waiter.done():
                        waiter.set_result(
                            (False, "turn_coordinator_reset_before_completion")
                        )
            self._turn_terminal_waiters.clear()
            self._events_by_turn_id.clear()
            self._active_vad_turn_by_capture_turn.clear()
            self._active_speech_capture_turns.clear()
            self.motion_observations.reset()
            self.runtime_state.persona_sessions.reset()

        if cleanup_failures:
            raise RuntimeError(
                "turn_tracking_cleanup_incomplete:" + ",".join(cleanup_failures)
            )

    def cleanup_active_event(self, turn_id: str, event: Any) -> list[str]:
        """Stop one AstrBot event for the Orchestrator's disconnect owner."""

        failures: list[str] = []
        self._cancel_turn_owned_motion_task(
            event,
            turn_id=turn_id,
            reason="transport_disconnected",
        )
        set_extra = getattr(event, "set_extra", None)
        if callable(set_extra):
            try:
                set_extra("agent_stop_requested", True)
            except Exception:
                failures.append(f"{turn_id}:set_extra_failed")
                logger.exception(
                    "Failed to mark active AstrBot event for disconnect stop: "
                    "turn_id=%s",
                    turn_id,
                )
        else:
            failures.append(f"{turn_id}:set_extra_unavailable")
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
                failures.append(f"{turn_id}:stop_event_failed")
                logger.exception(
                    "Failed to stop active AstrBot event during disconnect: "
                    "turn_id=%s",
                    turn_id,
                )
        else:
            failures.append(f"{turn_id}:stop_event_unavailable")
            logger.error(
                "Active AstrBot event cannot be stopped during disconnect: "
                "turn_id=%s",
                turn_id,
            )
        return failures

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
            try:
                await self._commit_inbound_message(message_obj, turn_id=turn_id)
            finally:
                if self._input_preparation is not None:
                    self._input_preparation.cancel(capture_turn_id)
                self._active_speech_capture_turns.discard(capture_turn_id)
            self._active_vad_turn_by_capture_turn[capture_turn_id] = turn_id

    async def open_incremental_output(
        self, *, turn_id: str, core_turn_id: str, persona_result_id: str,
        send_payload: SendPayload,
    ) -> IncrementalOutputSession:
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            return await orchestrator.open_incremental_output(
                turn_id=turn_id,
                core_turn_id=core_turn_id,
                persona_result_id=persona_result_id,
                send_payload=send_payload,
                require_turn_active=lambda: self.require_incremental_turn_active(
                    turn_id=turn_id,
                    core_turn_id=core_turn_id,
                ),
            )

        return await self.output_segments.open_incremental_output(
            turn_id=turn_id, core_turn_id=core_turn_id, persona_result_id=persona_result_id,
            send_payload=send_payload, require_turn_active=lambda: self.require_incremental_turn_active(
                turn_id=turn_id, core_turn_id=core_turn_id,
            ),
        )

    def require_incremental_turn_active(
        self,
        *,
        turn_id: str,
        core_turn_id: str,
    ) -> None:
        if (
            turn_id in self._turn_terminal_results
            or turn_id in self._terminating_turn_ids
            or self.turn_identity_map.resolve_astrbot_turn(turn_id) != core_turn_id
        ):
            raise RuntimeError("incremental_output_turn_binding_invalid")

    async def discard_incremental_output(
        self, *, turn_id: str, persona_result_id: str
    ) -> bool:
        """Release an admitted writer that has not produced a segment."""
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            return await orchestrator.discard_incremental_output(
                turn_id=turn_id,
                persona_result_id=persona_result_id,
            )
        return await self.output_segments.discard_incremental_output(
            turn_id=turn_id,
            persona_result_id=persona_result_id,
        )

    async def emit_message_chain(
        self,
        message_chain,
        turn_id: str,
        unified_msg_origin: str | None = None,
        raw_reply_text_override: str | None = None,
        platform_extras: dict[str, Any] | None = None,
    ) -> None:
        """Forward AstrBot's output callback to the segment owner."""
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            await orchestrator.emit_message_chain(
                message_chain,
                turn_id=turn_id,
                unified_msg_origin=unified_msg_origin,
                raw_reply_text_override=raw_reply_text_override,
                platform_extras=platform_extras,
            )
            return
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
            return await self._begin_proactive_output_turn_locked("proactive")

    @property
    def has_active_speech_input(self) -> bool:
        return bool(self._active_speech_capture_turns)

    def set_passive_behavior_interrupt_handler(
        self,
        handler: Callable[[], Awaitable[None]] | None,
    ) -> None:
        self._passive_behavior_interrupt_handler = handler

    async def _begin_proactive_output_turn_locked(self, prefix: str) -> str:
        turn_id = f"{prefix}:{uuid4().hex}"
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        current_turn_id = self.session_state.begin_turn("", turn_id=turn_id)
        self.turn_identity_map.register_frontend_turn(current_turn_id)
        if orchestrator is not None:
            orchestrator.admit_turn(current_turn_id, "")
        self._begin_turn_timing(current_turn_id, "")
        try:
            if orchestrator is not None:
                await orchestrator.publish_turn_started(current_turn_id)
                sent = True
            else:
                sent = await self._send_json(
                    build_control_turn_started(turn_id=current_turn_id)
                )
        except Exception as exc:
            sent = False
            logger.debug(
                "Proactive turn start publication failed: turn_id=%s error=%s",
                current_turn_id,
                exc,
            )
        if sent:
            return current_turn_id

        self.turn_identity_map.clear_frontend_turn(current_turn_id)
        self._turn_timings.pop(current_turn_id, None)
        if orchestrator is not None:
            orchestrator.discard_turn(current_turn_id)
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

    async def close_turn_output_queue(
        self, *, turn_id: str, failure_reason: str | None = None
    ) -> None:
        """Forward output closure to the segment owner."""
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            await orchestrator.close_turn_output_queue(
                turn_id=turn_id,
                failure_reason=failure_reason,
            )
            return
        await self.output_segments.close_turn_output_queue(
            turn_id=turn_id, failure_reason=failure_reason
        )

    async def finalize_output_segment(
        self,
        *,
        turn_id: str,
        message_id: str,
    ) -> None:
        """Forward one completed logical output to the segment owner."""
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            await orchestrator.finalize_output_segment(
                turn_id=turn_id,
                message_id=message_id,
            )
            await orchestrator.publish_conversation_event(
                ConversationEvent(
                    kind=ConversationEventKind.SEGMENT_BOUNDARY,
                    turn_id=turn_id,
                    provider_event_id=f"segment-boundary:{message_id}",
                    boundary=SegmentBoundary(
                        provider_boundary_id=message_id,
                        reason="output_segment_finalized",
                    ),
                    metadata={"message_id": message_id},
                )
            )
            return
        await self.output_segments.finalize_output_segment(
            turn_id=turn_id,
            message_id=message_id,
        )

    def has_pending_persona_segment(self, *, turn_id: str, message_id: str) -> bool:
        """Return whether a physical output segment already carries Persona metadata."""
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            return orchestrator.has_pending_persona_segment(
                turn_id=turn_id,
                message_id=message_id,
            )
        return self.output_segments.has_pending_persona_segment(
            turn_id=turn_id,
            message_id=message_id,
        )

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

        await self.output_segments.require_playback_queue_closed(resolved_turn_id)

        output_failure = self.output_segments.output_failure_reason(resolved_turn_id)
        if output_failure:
            success = False
            reason = output_failure

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

    async def wait_for_turn_finished(
        self,
        *,
        turn_id: str,
        timeout_seconds: float,
    ) -> tuple[bool, str | None]:
        """Wait for the frontend's terminal result after playback settles."""

        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            return await orchestrator.wait_for_turn_finished(
                turn_id=turn_id,
                timeout_seconds=timeout_seconds,
            )
        resolved_turn_id = self._require_turn_id_value(turn_id)
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or timeout_seconds <= 0
        ):
            raise ValueError("turn_finished_wait_timeout_invalid")
        terminal = self._turn_terminal_results.get(resolved_turn_id)
        if terminal is not None:
            return terminal

        future = asyncio.get_running_loop().create_future()
        waiters = self._turn_terminal_waiters.setdefault(resolved_turn_id, [])
        waiters.append(future)
        try:
            return await asyncio.wait_for(
                asyncio.shield(future), timeout=float(timeout_seconds)
            )
        except asyncio.TimeoutError as exc:
            raise TimeoutError(
                f"turn_finished_ack_timeout:{resolved_turn_id}"
            ) from exc
        finally:
            current_waiters = self._turn_terminal_waiters.get(resolved_turn_id)
            if current_waiters is not None:
                if future in current_waiters:
                    current_waiters.remove(future)
                if not current_waiters:
                    self._turn_terminal_waiters.pop(resolved_turn_id, None)
            if not future.done():
                future.cancel()

    async def _commit_inbound_message(self, message_obj, *, turn_id: str | None = None) -> None:
        self.observation_window.note_input()
        async with self._turn_lock:
            normalized_turn_id = self._require_turn_id_value(turn_id)
            await self._interrupt_passive_work()
            await self._abort_active_frontend_turn_before_new_input(
                next_turn_id=normalized_turn_id,
            )
            backend_turn_id = (
                normalized_turn_id
                if self._external_conversation_submitter is not None
                else self._resolve_backend_turn_id(
                    message_obj,
                    frontend_turn_id=normalized_turn_id,
                )
            )
            turn_identity_map = self.turn_identity_map
            turn_identity_map.register_bound_turn(
                frontend_turn_id=normalized_turn_id,
                backend_turn_id=backend_turn_id,
            )
            orchestrator = getattr(self, "_interaction_orchestrator", None)
            try:
                if orchestrator is not None:
                    await orchestrator.publish_turn_started(normalized_turn_id)
                    sent = True
                else:
                    sent = await self._send_json(
                        build_control_turn_started(
                            turn_id=normalized_turn_id,
                        )
                    )
            except Exception as exc:
                raise RuntimeError(
                    f"turn_started_send_failed:{normalized_turn_id}"
                ) from exc
            if not sent:
                turn_identity_map.clear_frontend_turn(normalized_turn_id)
                raise RuntimeError(f"turn_started_send_failed:{normalized_turn_id}")

            current_turn_id = normalized_turn_id
            try:
                current_turn_id = self.session_state.begin_turn(
                    message_obj.message_str,
                    turn_id=normalized_turn_id,
                )
                orchestrator = getattr(self, "_interaction_orchestrator", None)
                if orchestrator is not None:
                    orchestrator.admit_turn(
                        current_turn_id,
                        message_obj.message_str,
                    )
                self._begin_turn_timing(current_turn_id, message_obj.message_str)
                await self._emit_image_input_diagnostics(
                    message_obj,
                    turn_id=current_turn_id,
                )

                if self._external_conversation_submitter is not None:
                    if orchestrator is not None:
                        await orchestrator.publish_conversation_event(
                            ConversationEvent(
                                kind=ConversationEventKind.TURN_STARTED,
                                turn_id=current_turn_id,
                                provider_event_id=f"turn-started:{current_turn_id}",
                                metadata={
                                    "frontend_turn_id": normalized_turn_id,
                                    "backend_turn_id": backend_turn_id,
                                    "platform": "dsh",
                                },
                            )
                        )
                    await self._external_conversation_submitter(
                        ConversationInput(
                            turn_id=current_turn_id,
                            message_id=getattr(message_obj, "message_id", None),
                            text=message_obj.message_str,
                            metadata={
                                "images": getattr(message_obj, "raw_message", {}).get(
                                    "resolved_images", []
                                )
                                if isinstance(getattr(message_obj, "raw_message", None), dict)
                                else [],
                                "dsh_session_id": (
                                    f"ag99live:{self.session_state.client_uid}"
                                    if self.session_state.client_uid
                                    else "ag99live:default"
                                ),
                            },
                        )
                    )
                    self.chat_buffer.add("user", message_obj.message_str)
                    self._mark_turn_timing(current_turn_id, "event_committed_at")
                    return

                event = self._build_platform_event(message_obj)
                set_extra = getattr(event, "set_extra", None)
                if callable(set_extra):
                    event_context = resolve_adapter_event_context(event)
                    existing_core_id = event_context.core_turn_id
                    if existing_core_id and existing_core_id != backend_turn_id:
                        raise RuntimeError("input_event_turn_identity_conflict")
                    # Core's PlatformTurnContextFactory explicitly adopts this
                    # server-created input identity. The map and admitted Turn
                    # must not independently mint different IDs for one input.
                    event_context.set_turn_identity(
                        event,
                        core_turn_id=backend_turn_id,
                        delivery_turn_id=current_turn_id,
                    )
                    set_extra("enable_streaming", False)
                    logger.debug(
                        "DIAG input.turn_bound: frontend_turn_id=%s core_turn_id=%s",
                        current_turn_id, backend_turn_id,
                    )
                orchestrator = getattr(self, "_interaction_orchestrator", None)
                if orchestrator is not None:
                    orchestrator.register_active_event(current_turn_id, event)
                else:
                    self._events_by_turn_id[current_turn_id] = event
                self._commit_event(event)
                if orchestrator is not None:
                    await orchestrator.publish_conversation_event(
                        ConversationEvent(
                            kind=ConversationEventKind.TURN_STARTED,
                            turn_id=current_turn_id,
                            provider_event_id=f"turn-started:{current_turn_id}",
                            metadata={
                                "frontend_turn_id": normalized_turn_id,
                                "backend_turn_id": backend_turn_id,
                            },
                        )
                    )
            except Exception:
                orchestrator = getattr(self, "_interaction_orchestrator", None)
                if orchestrator is not None:
                    orchestrator.remove_active_event(current_turn_id)
                else:
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

    async def _abort_active_frontend_turn_before_new_input(
        self,
        *,
        next_turn_id: str,
    ) -> None:
        """End an older visible turn before announcing a replacement turn.

        This is intentionally an adapter-side lifecycle transition.  It keeps
        the client from observing two active playback queues while Core later
        cancels the superseded execution through Personal Runtime.
        """
        active_turn_id = self.session_state.current_turn_id
        if not active_turn_id or active_turn_id == next_turn_id:
            return
        await self.abort_turn_from_backend(
            turn_id=active_turn_id,
            reason="superseded_by_new_user_input",
        )

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

        input_only = ((resolved_turn_id.startswith("input:")
                       or self.pre_action.turn_id == resolved_turn_id
                       or resolved_turn_id in self._active_speech_capture_turns)
                      and resolved_turn_id not in self._events_by_turn_id
                      and self.session_state.current_turn_id != resolved_turn_id)
        await self.speech_ingress.handle_audio_stream_interrupt(turn_id=resolved_turn_id)
        await self._handle_capture_abandoned(resolved_turn_id)
        if input_only:
            return
        stopped_count = await self.abort_turn_from_backend(
            turn_id=resolved_turn_id,
            reason="interrupted",
        )
        logger.info(
            "Processed control.interrupt for turn_id=%s stopped_events=%s",
            resolved_turn_id,
            stopped_count,
        )

    async def abort_turn_from_backend(self, *, turn_id: str, reason: str) -> int:
        """Terminate a frontend turn after AstrBot accepts a superseding input.

        The normal inbound ``control.interrupt`` path and Core-side
        preemption must publish the same client protocol facts. Otherwise an
        old playback queue remains open while the next AstrBot turn begins.
        """
        resolved_turn_id = self._require_turn_id_value(turn_id)
        normalized_reason = str(reason or "").strip() or "interrupted"
        await self.pre_action.cancel(resolved_turn_id)
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            return await orchestrator.abort_turn(
                turn_id=resolved_turn_id,
                reason=normalized_reason,
            )

        if (
            resolved_turn_id in self._turn_terminal_results
            or resolved_turn_id in self._terminating_turn_ids
        ):
            return 0
        self._terminating_turn_ids.add(resolved_turn_id)
        stopped_count = 0
        try:
            event = self._events_by_turn_id.get(resolved_turn_id)
            if event is not None:
                self._cancel_turn_owned_motion_task(
                    event,
                    turn_id=resolved_turn_id,
                    reason=normalized_reason,
                )
                set_extra = getattr(event, "set_extra", None)
                if callable(set_extra):
                    resolve_adapter_event_context(event).set_agent_stop_requested(
                        event,
                    )
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
                reason=normalized_reason,
            )
            return stopped_count
        finally:
            self._terminating_turn_ids.discard(resolved_turn_id)

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
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            await orchestrator.finish_turn(
                turn_id=resolved_turn_id,
                success=success,
                reason=normalized_reason,
            )
            return

        started = resolved_turn_id not in self._turn_terminal_results
        existing_result = (
            self._turn_terminal_results.get(resolved_turn_id)
            if not started
            else None
        )
        if started:
            self._turn_terminal_results[resolved_turn_id] = None
        if not started:
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
        event = self._events_by_turn_id.get(resolved_turn_id)
        if event is not None:
            self._cancel_turn_owned_motion_task(
                event,
                turn_id=resolved_turn_id,
                reason=normalized_reason or "turn_finished",
            )
            set_extra = getattr(event, "set_extra", None)
            if callable(set_extra):
                resolve_adapter_event_context(event).set_agent_stop_requested(event)
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
            failure_reason = f"turn_finished_send_failed:{resolved_turn_id}"
            self._turn_terminal_results.pop(resolved_turn_id, None)
            for waiter in self._turn_terminal_waiters.pop(resolved_turn_id, []):
                if not waiter.done():
                    waiter.set_result((False, failure_reason))
            raise

        self._turn_terminal_results[resolved_turn_id] = terminal_result
        self.observation_window.note_output_finished()
        for waiter in self._turn_terminal_waiters.pop(resolved_turn_id, []):
            if not waiter.done():
                waiter.set_result(terminal_result)
        self._prune_turn_terminal_results()
        self.turn_identity_map.clear_frontend_turn(resolved_turn_id)
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
        motion_work_turn_id = _resolve_motion_work_turn_id(
            event,
            resolved_turn_id,
        )
        self.runtime_state.persona_sessions.clear_turn(
            PersonaTurnIdentity(motion_work_turn_id)
        )

    def _cancel_turn_owned_motion_task(
        self,
        event: Any,
        *,
        turn_id: str,
        reason: str,
    ) -> None:
        """Cancel motion work owned by a turn before its event is discarded.

        Persona-hook motion work is tracked in RuntimeState because AstrBot
        isolates hook-local event extras from later output contributors.
        """
        motion_work_turn_id = _resolve_motion_work_turn_id(event, turn_id)
        session = self.runtime_state.persona_sessions.get_session(
            PersonaTurnIdentity(motion_work_turn_id)
        )
        tasks = tuple(session.tasks) if session is not None else ()
        self.runtime_state.persona_sessions.clear_turn(
            PersonaTurnIdentity(motion_work_turn_id)
        )
        for task in tasks:
            if task.done():
                continue
            logger.info(
                "WIRING independent_motion.task_cancelled turn_id=%s "
                "reason=%s task_name=%s",
                turn_id,
                reason,
                task.get_name(),
            )

    def _prune_turn_terminal_results(self) -> None:
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            orchestrator.prune_terminal_results(MAX_REMEMBERED_TERMINAL_TURNS)
            return
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
        self.observation_window.note_input()
        normalized_capture_turn_id = self._require_turn_id_value(capture_turn_id)
        if self._input_preparation is not None:
            self._input_preparation.cancel()
            self._input_preparation.start(normalized_capture_turn_id)
        self._active_speech_capture_turns.add(normalized_capture_turn_id)
        active_turn_id = self._active_vad_turn_by_capture_turn.get(
            normalized_capture_turn_id
        )
        if active_turn_id:
            if active_turn_id in self._events_by_turn_id:
                await self._handle_interrupt_signal(active_turn_id)
            else:
                self._active_vad_turn_by_capture_turn.pop(
                    normalized_capture_turn_id,
                    None,
                )

        async with self._turn_lock:
            await self._interrupt_passive_work()

    async def _interrupt_passive_work(self) -> None:
        interrupt_handler = self._passive_behavior_interrupt_handler
        if callable(interrupt_handler):
            await interrupt_handler()

    async def _handle_vad_speech_ended(self, capture_turn_id: str) -> None:
        self.observation_window.note_input()
        normalized_capture_turn_id = self._require_turn_id_value(capture_turn_id)
        self._active_speech_capture_turns.discard(normalized_capture_turn_id)

    async def _handle_capture_abandoned(self, capture_turn_id: str) -> None:
        if self._pre_action_input_id == capture_turn_id:
            self._pre_action_input_id = None
            await self.pre_action.cancel()
        else:
            await self.pre_action.cancel(capture_turn_id)
        if self._input_preparation is not None:
            self._input_preparation.cancel(capture_turn_id)
        self._active_speech_capture_turns.discard(capture_turn_id)

    async def _handle_pre_action_text(self, text: str, turn_id: str) -> None:
        input_id = self._pre_action_input_id
        if input_id is None:
            return
        if turn_id != input_id:
            prefix = f"{input_id}:vad:"
            suffix = turn_id.removeprefix(prefix)
            if (
                not turn_id.startswith(prefix)
                or not suffix.isascii()
                or not suffix.isdigit()
                or int(suffix) < 1
            ):
                return
        if self.pre_action.turn_id != turn_id:
            await self.pre_action.begin(turn_id)
        self.pre_action.trigger(text, turn_id)

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
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            orchestrator.begin_turn_timing(
                turn_id,
                user_text,
                self._current_turn_index(),
            )
            return
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
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            orchestrator.mark_turn_timing(
                turn_id,
                key,
                value,
                turn_index=self._current_turn_index(),
            )
            return
        timing = self._turn_timings.setdefault(
            turn_id,
            {"turn_index": self._current_turn_index()},
        )
        timing[key] = time.perf_counter() if value is None else value

    def _elapsed_ms(self, turn_id: str, start_key: str, end_key: str) -> float:
        orchestrator = getattr(self, "_interaction_orchestrator", None)
        if orchestrator is not None:
            return orchestrator.elapsed_turn_ms(turn_id, start_key, end_key)
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
