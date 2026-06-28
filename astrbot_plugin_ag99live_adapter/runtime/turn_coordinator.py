"""后端轮次编排中枢。

TurnCoordinator 把"前端协议消息 ↔ AstrBot 事件总线 ↔ 出站回放"绑在一起，
是这条链路上唯一同时持有协议侧轮次身份与业务侧轮次生命周期的对象。

入站
    1. 接收 transport 解码出的 JSON dict / 二进制帧，并在本层完成协议解析。
    2. handle_msg 按 message.type 路由：
         - system.*                                        → _handle_frontend_system
         - engine.motion_intent / engine.catalog_motion    → _handle_engine_motion_payload_preview
         - control.playback_finished                       → finalize_turn
         - control.interrupt                               → _handle_interrupt_signal
         - input.audio_stream_*                            → SpeechIngressService
         - input.mic_audio_data / input.raw_audio_data     → 旧的非流式麦克风入口
         - input.text                                      → _commit_inbound_message
    3. 除 system.* 与 engine preview 入口外，交互类 message.type 都要求 turn_id 非空
       （_require_interactive_turn_id）；前端 turn_id 通过 turn_identity_map 与
       后端 turn_id 互相绑定。

出站
    4. emit_message_chain 把 AstrBot 平台回复链拆成 output.text / engine.motion_* /
       output.image / output.audio 依次发送。
    5. close_turn_output_queue 发 control.synth_finished。
    6. finalize_turn → _finish_turn 在收到前端 control.playback_finished（或被打断）
       后发 control.turn_finished 并把 session_state 切回 idle。

边界
    - 不直接读写 WebSocket：所有出站都走注入的 send_json 回调。
    - 信封形状解析集中交给 protocol/parser.py，由本层在入口调用。
    - 大多数出站信封交给 protocol/builder.py；engine preview/egress 少量路径直接使用
      build_message_envelope。
    - 不感知动作语义内部细节：动作 payload 的提取、规范化在 motion/* 与 middleware/*，
      本中枢只决定"何时把动作 payload 广播给前端"。
"""

from __future__ import annotations

import asyncio
import json
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
    TYPE_ENGINE_PERFORMANCE_CURVE_HINT,
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
from ..motion.axis_constraints import apply_motion_constraints_to_intent_payload
from ..motion.motion_intent import (
    normalize_motion_intent_payload,
    resolve_selected_semantic_axis_profile,
)
from ..motion.performance_curve import (
    PerformanceCurveInput,
    attach_performance_curve_hint,
    extract_assistant_reply_keywords,
    summarize_motion_for_curve,
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
from .motion_lab import enqueue_motion_lab_raw_event

class TurnCoordinator:
    """后端单连接的协议+轮次编排器。

    一个 WebSocket 会话对应一个 TurnCoordinator 实例：内部以 _turn_lock 串行化轮次
    生命周期事件，避免"上一轮没收口就被下一轮覆盖"。背景任务、轮次计时、平台动作
    去重集合都由它持有，跨连接不共享。
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
        )

        self._turn_lock = asyncio.Lock()
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self._turn_timing: dict[str, Any] = {}
        self._dispatched_platform_motion_keys: set[str] = set()
        self._last_prompt_motion_snapshot: dict[str, Any] | None = None
        self._current_performance_curve_context: dict[str, Any] | None = None
        self._pending_performance_curve_motions: dict[str, dict[str, Any]] = {}

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
        """WebSocket 二进制帧入口：解析 AG99 麦克风音频帧并交给语音入口。

        二进制路径只用于麦克风采集的 PCM16LE chunk（见 protocol/binary_audio.py）。
        当一段采集已经收到 end 时，speech_ingress 会回传一条 message 对象，
        本方法负责把它作为新一轮交互 commit 进去。
        """
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
        """把 AstrBot 平台层产出的回复链拆成出站消息序列发给前端。

        发送顺序固定为 text → motion → image → audio：
            1. _extract_outbound_message_parts 抽出文本/图片/音频路径；
               _extract_inline_motion_plan 剥离 inline 动作标记得到可见文本。
            2. 若有可见文本，写聊天缓存并发 output.text。
            3. _broadcast_platform_motion_client_objects 优先派发平台 motion client object；
               若未派发且 motion_generation_mode 是 inline_first 且 inline_payload 是 dict，
               直接派发 inline payload；split_after_reply/secondary 路径由上游补齐
               platform_extras 后再走本方法。
            4. 有图片就发 output.image。
            5. 有音频文件就 media_service.cache_audio_file → 取 URL → 发 output.audio，
               并把会话状态推进到 synthesizing → playing。
        无音频时直接 mark_playing，不进入 synthesizing 阶段。
        """
        del unified_msg_origin
        del inline_base_expression
        del inline_motion_id

        turn_id = self.session_state.current_turn_id
        platform_extras_dict = platform_extras if isinstance(platform_extras, dict) else {}
        segment_message_id = _resolve_platform_segment_message_id(platform_extras_dict)

        self._mark_turn_timing("emit_started_at")
        texts, picture_paths, record_paths = _extract_outbound_message_parts(message_chain)
        logger.info(
            "WIRING output_parts turn_id=%s message_id=%s text_count=%s image_count=%s record_count=%s",
            turn_id or "",
            segment_message_id or "",
            len(texts),
            len(picture_paths),
            len(record_paths),
        )
        override_text = str(raw_reply_text_override or "").strip()
        raw_reply_text = override_text or "\n".join(texts).strip()
        motion_generation_mode = _resolve_motion_generation_mode(self.runtime_state)
        inline_anim_detected = INLINE_ANIM_START_PATTERN.search(raw_reply_text) is not None
        reply_text, inline_payload, inline_mode = _extract_inline_motion_plan(
            raw_reply_text,
            runtime_state=self.runtime_state,
        )

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

        self._record_motion_lab_raw_event(
            event_type="turn.assistant_output",
            turn_id=turn_id,
            message_id=segment_message_id,
            source_route="emit_message_chain",
            phase="assistant_output",
            assistant_text=reply_text or raw_reply_text,
            raw={
                "raw_reply_text": raw_reply_text,
                "visible_reply_text": reply_text,
                "text_count": len(texts),
                "image_count": len(picture_paths),
                "record_count": len(record_paths),
                "inline_anim_detected": inline_anim_detected,
                "inline_mode": inline_mode,
                "inline_payload": inline_payload,
                "platform_extras": platform_extras_dict,
                "chat_context": self._motion_lab_chat_context(),
            },
        )
        self._current_performance_curve_context = {
            "turn_id": turn_id,
            "message_id": segment_message_id,
            "assistant_text": reply_text or raw_reply_text,
            "assistant_reply_keywords": extract_assistant_reply_keywords(reply_text or raw_reply_text),
            "chat_context": self._motion_lab_chat_context(),
            "platform_extras": platform_extras_dict,
        }
        self._start_performance_curve_request(
            motion_payload=_resolve_initial_performance_curve_motion_payload(
                platform_extras=platform_extras_dict,
                inline_payload=inline_payload,
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
            try:
                _, audio_url = self.media_service.cache_audio_file(record_path)
            except Exception as exc:
                logger.warning(
                    "WIRING audio_payload_egress_failed turn_id=%s message_id=%s error=%s",
                    turn_id or "",
                    segment_message_id or "",
                    exc,
                )
                raise
            await self._flush_performance_curve_motion_before_audio(
                turn_id=turn_id,
                message_id=segment_message_id,
            )
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
            logger.info(
                "WIRING audio_payload_egress turn_id=%s message_id=%s audio_url=%s",
                turn_id or "",
                segment_message_id or "",
                audio_url,
            )
            self._mark_turn_timing("audio_payload_sent_at")
            self._mark_turn_synthesizing()
            self._mark_turn_playing()
            self._current_performance_curve_context = None
            return

        self._mark_turn_playing()
        self._fail_pending_performance_curve_motion(
            turn_id=turn_id,
            message_id=segment_message_id,
            reason="audio_absent_before_curve_check",
        )
        self._current_performance_curve_context = None

    async def close_turn_output_queue(self) -> None:
        """发 control.synth_finished。

        借助 session_state.mark_output_queue_closed 做幂等保护：第一次调用时它会
        返回 True 并允许发送，重复调用直接 return；老 session_state 没有该方法时
        退化成读写 output_queue_closed 属性。current_turn_id 为 None 时不发。
        """
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
        """收到 control.playback_finished 后收口本轮。

        只在 session_state.waiting_for_playback_complete=True 时生效，避免把还在
        合成中或已 idle 的轮次误结束。若信号携带的 turn_id 不属于当前轮（脏数据
        或乱序），直接忽略。
        """
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
            self._get_dispatched_platform_motion_keys().clear()
            self._begin_turn_timing(message_obj.message_str)
            self.chat_buffer.add("user", message_obj.message_str)
            self._record_motion_lab_raw_event(
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
                    "chat_context": self._motion_lab_chat_context(),
                },
            )
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
        """把一份动作载荷以 engine.* 出站到前端。

        - schema 是 engine.motion_intent.v2/v3 时先经 normalize_motion_intent_payload 规范化；
          规范化失败直接拒发。
        - 根据 _resolve_engine_motion_message_type 选择信封类型（intent / catalog / 旧版 plan），
          并按类型选择 payload 子键 (intent/motion/plan)。
        - source 字段表明这份载荷的来源（inline、catalog、platform_extras 等），用于诊断。
        返回 True 表示已成功提交到 send_json。
        """
        if not isinstance(motion_payload, dict):
            return False

        if _resolve_motion_payload_schema_version(motion_payload) in {
            "engine.motion_intent.v2",
            "engine.motion_intent.v3",
        }:
            try:
                motion_payload = normalize_motion_intent_payload(motion_payload)
            except ValueError as exc:
                logger.warning("WIRING motion_payload_egress rejected: %s", exc)
                return False

        if str(motion_payload.get("schema_version") or "").strip() == "engine.motion_intent.v3":
            semantic_profile = None
            try:
                semantic_profile = resolve_selected_semantic_axis_profile(
                    runtime_state=self.runtime_state,
                )
            except Exception:  # noqa: BLE001
                semantic_profile = None
            motion_payload, _constraint_result = apply_motion_constraints_to_intent_payload(
                payload=motion_payload,
                semantic_profile=semantic_profile,
            )
            motion_payload = self._attach_ready_performance_curve_hint(
                motion_payload=motion_payload,
                turn_id=turn_id,
                message_id=message_id,
            )
            if "performance_curve_hint" in motion_payload:
                self._clear_pending_performance_curve_motion(
                    turn_id=turn_id,
                    message_id=message_id,
                )
            else:
                self._record_pending_performance_curve_motion(
                    motion_payload=motion_payload,
                    mode=mode,
                    source=source,
                    turn_id=turn_id,
                    message_id=message_id,
                )

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
            self._record_prompt_motion_snapshot(
                motion_payload=motion_payload,
                source=payload["source"],
            )
            self._record_motion_lab_raw_event(
                event_type="motion.egress_sent",
                turn_id=resolved_turn_id,
                message_id=message_id,
                source_route=payload["source"],
                phase="egress",
                payload_kind=payload_key,
                raw={
                    "message_type": message_type,
                    "mode": payload["mode"],
                    "payload_key": payload_key,
                    "motion_payload": motion_payload,
                    "envelope_payload": payload,
                },
            )
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

    def get_last_prompt_motion_snapshot(self) -> dict[str, Any] | None:
        snapshot = getattr(self, "_last_prompt_motion_snapshot", None)
        if not isinstance(snapshot, dict):
            return None
        axes = snapshot.get("axes")
        cloned_snapshot = dict(snapshot)
        if isinstance(axes, dict):
            cloned_snapshot["axes"] = dict(axes)
        return cloned_snapshot

    def _record_prompt_motion_snapshot(
        self,
        *,
        motion_payload: dict[str, Any],
        source: str,
    ) -> None:
        if str(motion_payload.get("schema_version") or "").strip() != "engine.motion_intent.v3":
            return
        axes = motion_payload.get("axes")
        if not isinstance(axes, dict):
            return

        normalized_axes: dict[str, float] = {}
        for axis_id, axis_value in axes.items():
            if not isinstance(axis_value, (int, float)) or isinstance(axis_value, bool):
                continue
            normalized_axis_id = str(axis_id or "").strip()
            if not normalized_axis_id:
                continue
            normalized_axes[normalized_axis_id] = round(float(axis_value), 4)
        if not normalized_axes:
            return

        intent_tags = motion_payload.get("intent_tags")
        normalized_tags = []
        if isinstance(intent_tags, list):
            normalized_tags = [
                str(item).strip()
                for item in intent_tags
                if str(item).strip()
            ][:6]

        self._last_prompt_motion_snapshot = {
            "schema_version": "engine.motion_intent.v3",
            "source": str(source or "").strip(),
            "resource_id": str(motion_payload.get("resource_id") or "").strip(),
            "intent_tags": normalized_tags,
            "axes": normalized_axes,
        }

    def _record_motion_lab_raw_event(
        self,
        *,
        event_type: str,
        turn_id: str | None = None,
        frontend_turn_id: str | None = None,
        message_id: str | None = None,
        source_route: str = "",
        phase: str = "",
        user_text: str = "",
        assistant_text: str = "",
        payload_kind: str = "",
        raw: dict[str, Any] | None = None,
    ) -> bool:
        runtime_state = getattr(self, "runtime_state", None)
        if runtime_state is None:
            return False
        profile = None
        try:
            profile = resolve_selected_semantic_axis_profile(runtime_state=runtime_state)
        except Exception:  # noqa: BLE001
            profile = None
        return enqueue_motion_lab_raw_event(
            runtime_state,
            {
                "event_type": event_type,
                "conversation_uid": getattr(self.session_state, "client_uid", None),
                "turn_id": turn_id if turn_id is not None else self.session_state.current_turn_id,
                "frontend_turn_id": frontend_turn_id,
                "message_id": message_id,
                "source_route": source_route,
                "phase": phase,
                "model_name": str((profile or {}).get("model_id") or "").strip(),
                "profile_id": str((profile or {}).get("profile_id") or "").strip(),
                "profile_revision": (profile or {}).get("revision"),
                "user_text": user_text,
                "assistant_text": assistant_text,
                "payload_kind": payload_kind,
                "raw": raw or {},
            },
        )

    def _motion_lab_chat_context(self) -> list[dict[str, str]]:
        chat_buffer = getattr(self, "chat_buffer", None)
        to_list = getattr(chat_buffer, "to_list", None)
        if not callable(to_list):
            return []
        try:
            value = to_list()
        except Exception:  # noqa: BLE001
            return []
        return value if isinstance(value, list) else []

    def _start_performance_curve_request(
        self,
        *,
        motion_payload: dict[str, Any] | None,
    ) -> bool:
        context = getattr(self, "_current_performance_curve_context", None)
        if not isinstance(context, dict):
            return False
        runtime_state = getattr(self, "runtime_state", None)
        runtime = getattr(runtime_state, "performance_curve_runtime", None)
        start = getattr(runtime, "start", None)
        if not callable(start):
            return False

        turn_id = str(context.get("turn_id") or "").strip()
        message_id = str(context.get("message_id") or "").strip()
        assistant_text = str(context.get("assistant_text") or "").strip()
        if not turn_id or not assistant_text:
            return False

        motion_summary = summarize_motion_for_curve(motion_payload)
        motion_intent_tags = [
            str(item).strip()
            for item in motion_summary.get("intent_tags", [])
            if str(item).strip()
        ]
        request = PerformanceCurveInput(
            turn_id=turn_id,
            message_id=message_id,
            assistant_text=assistant_text,
            assistant_reply_keywords=[
                str(item).strip()
                for item in context.get("assistant_reply_keywords", [])
                if str(item).strip()
            ],
            motion_intent_tags=motion_intent_tags,
            motion_effect_summary=motion_summary,
            chat_context=[
                item
                for item in context.get("chat_context", [])
                if isinstance(item, dict)
            ],
        )
        return bool(start(request))

    def _attach_ready_performance_curve_hint(
        self,
        *,
        motion_payload: dict[str, Any],
        turn_id: str | None,
        message_id: str | None,
    ) -> dict[str, Any]:
        runtime_state = getattr(self, "runtime_state", None)
        runtime = getattr(runtime_state, "performance_curve_runtime", None)
        get_ready = getattr(runtime, "get_ready", None)
        if not callable(get_ready):
            return motion_payload

        hint = get_ready(turn_id=turn_id, message_id=message_id)
        if not isinstance(hint, dict):
            return motion_payload

        next_payload, attached_hint = attach_performance_curve_hint(motion_payload, hint)
        if attached_hint is None:
            return motion_payload
        self._record_motion_lab_raw_event(
            event_type="performance_curve.attached",
            turn_id=turn_id,
            message_id=message_id,
            source_route="performance_curve_provider",
            phase="performance_curve",
            assistant_text=str(
                (getattr(self, "_current_performance_curve_context", None) or {}).get(
                    "assistant_text",
                    "",
                )
            ),
            payload_kind="ag99.performance_curve_hint.v1",
            raw={
                "curve_hint": attached_hint,
                "motion_intent_tags": [
                    str(item).strip()
                    for item in motion_payload.get("intent_tags", [])
                    if str(item).strip()
                ],
            },
        )
        clear = getattr(runtime, "clear", None)
        if callable(clear):
            clear(turn_id=turn_id, message_id=message_id)
        return next_payload

    def _record_pending_performance_curve_motion(
        self,
        *,
        motion_payload: dict[str, Any],
        mode: str,
        source: str,
        turn_id: str | None,
        message_id: str | None,
    ) -> None:
        normalized_turn_id = str(turn_id or "").strip()
        normalized_message_id = str(message_id or "").strip()
        if (
            not normalized_turn_id
            or not normalized_message_id
            or str(motion_payload.get("schema_version") or "").strip() != "engine.motion_intent.v3"
        ):
            return
        pending_key = self._performance_curve_pending_key(
            turn_id=normalized_turn_id,
            message_id=normalized_message_id,
        )
        if not pending_key:
            return
        pending_motions = getattr(self, "_pending_performance_curve_motions", None)
        if not isinstance(pending_motions, dict):
            pending_motions = {}
            self._pending_performance_curve_motions = pending_motions
        pending_motions[pending_key] = {
            "turn_id": normalized_turn_id,
            "message_id": normalized_message_id,
            "mode": str(mode or "preview").strip() or "preview",
            "source": str(source or "engine.motion_payload").strip() or "engine.motion_payload",
            "motion_payload": dict(motion_payload),
        }

    @staticmethod
    def _performance_curve_pending_key(
        *,
        turn_id: str | None,
        message_id: str | None,
    ) -> str:
        normalized_turn_id = str(turn_id or "").strip()
        normalized_message_id = str(message_id or "").strip()
        if not normalized_turn_id or not normalized_message_id:
            return ""
        return f"{normalized_turn_id}:{normalized_message_id}"

    def _clear_pending_performance_curve_motion(
        self,
        *,
        turn_id: str | None,
        message_id: str | None,
    ) -> None:
        pending_motions = getattr(self, "_pending_performance_curve_motions", None)
        if not isinstance(pending_motions, dict):
            return
        pending_key = self._performance_curve_pending_key(
            turn_id=turn_id,
            message_id=message_id,
        )
        if pending_key:
            pending_motions.pop(pending_key, None)

    async def _flush_performance_curve_motion_before_audio(
        self,
        *,
        turn_id: str | None,
        message_id: str | None,
    ) -> bool:
        pending_motions = getattr(self, "_pending_performance_curve_motions", None)
        if not isinstance(pending_motions, dict):
            return False
        normalized_turn_id = str(turn_id or "").strip()
        normalized_message_id = str(message_id or "").strip()
        pending_key = self._performance_curve_pending_key(
            turn_id=normalized_turn_id,
            message_id=normalized_message_id,
        )
        if not pending_key:
            return False
        pending = pending_motions.get(pending_key)
        if not isinstance(pending, dict):
            return False

        motion_payload = pending.get("motion_payload")
        if not isinstance(motion_payload, dict):
            pending_motions.pop(pending_key, None)
            return False

        runtime_state = getattr(self, "runtime_state", None)
        runtime = getattr(runtime_state, "performance_curve_runtime", None)
        get_ready = getattr(runtime, "get_ready", None)
        hint = get_ready(
            turn_id=normalized_turn_id,
            message_id=normalized_message_id,
        ) if callable(get_ready) else None
        _updated_payload, curve_hint = attach_performance_curve_hint(
            dict(motion_payload),
            hint,
        )
        if curve_hint is None:
            self._fail_pending_performance_curve_motion(
                turn_id=normalized_turn_id,
                message_id=normalized_message_id,
                reason="not_ready_before_audio_egress",
            )
            return False
        clear = getattr(runtime, "clear", None)
        if callable(clear):
            clear(turn_id=normalized_turn_id, message_id=normalized_message_id)

        pending_motions.pop(pending_key, None)
        sent = await self._send_json(
            build_message_envelope(
                TYPE_ENGINE_PERFORMANCE_CURVE_HINT,
                turn_id=normalized_turn_id,
                message_id=normalized_message_id,
                source=SOURCE_ENGINE,
                payload=curve_hint,
            )
        )
        if sent:
            self._record_motion_lab_raw_event(
                event_type="performance_curve.egress_sent",
                turn_id=normalized_turn_id,
                message_id=normalized_message_id,
                source_route=f"{str(pending.get('source') or 'engine.motion_payload')}.performance_curve_hint",
                phase="performance_curve",
                payload_kind="ag99.performance_curve_hint.v1",
                raw={
                    "curve_hint": curve_hint,
                    "motion_intent_tags": [
                        str(item).strip()
                        for item in motion_payload.get("intent_tags", [])
                        if str(item).strip()
                    ],
                },
            )
            logger.info(
                "WIRING performance_curve_hint_egress turn_id=%s message_id=%s source=%s",
                normalized_turn_id,
                normalized_message_id,
                str(pending.get("source") or "engine.motion_payload"),
            )
        return sent

    def _fail_pending_performance_curve_motion(
        self,
        *,
        turn_id: str | None,
        message_id: str | None,
        reason: str,
    ) -> bool:
        pending_motions = getattr(self, "_pending_performance_curve_motions", None)
        if not isinstance(pending_motions, dict):
            return False
        pending_key = self._performance_curve_pending_key(
            turn_id=turn_id,
            message_id=message_id,
        )
        pending = pending_motions.get(pending_key) if pending_key else None
        if not isinstance(pending, dict):
            return False
        pending_motions.pop(pending_key, None)
        return self._fail_pending_performance_curve_if_not_ready(
            turn_id=turn_id,
            message_id=message_id,
            reason=reason,
        )

    def _fail_pending_performance_curve_if_not_ready(
        self,
        *,
        turn_id: str | None,
        message_id: str | None,
        reason: str,
    ) -> bool:
        runtime_state = getattr(self, "runtime_state", None)
        runtime = getattr(runtime_state, "performance_curve_runtime", None)
        fail_if_not_ready = getattr(runtime, "fail_if_not_ready", None)
        if not callable(fail_if_not_ready):
            return False
        return bool(
            fail_if_not_ready(
                turn_id=turn_id,
                message_id=message_id,
                reason=reason,
            )
        )

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

            dispatch_key = self._resolve_platform_motion_dispatch_key(
                platform_extras=platform_extras,
                turn_id=turn_id,
                motion_object=motion_object,
                motion_payload=motion_payload,
            )
            dispatched_keys = self._get_dispatched_platform_motion_keys()
            if dispatch_key in dispatched_keys:
                logger.info(
                    "WIRING motion_payload_egress skipped_duplicate_client_object "
                    "turn_id=%s message_id=%s message_kind=%s",
                    turn_id or "",
                    message_id or "",
                    str(platform_extras.get("message_kind") or ""),
                )
                continue

            sent = await self.broadcast_motion_payload(
                motion_payload=motion_payload,
                mode=str(motion_object.get("mode") or "preview"),
                source=str(motion_object.get("source") or "platform_extras"),
                turn_id=turn_id,
                message_id=message_id,
            )
            if sent:
                dispatched_keys.add(dispatch_key)
            dispatched = dispatched or sent
        return dispatched

    def _get_dispatched_platform_motion_keys(self) -> set[str]:
        keys = getattr(self, "_dispatched_platform_motion_keys", None)
        if not isinstance(keys, set):
            keys = set()
            self._dispatched_platform_motion_keys = keys
        return keys

    @staticmethod
    def _resolve_platform_motion_dispatch_key(
        *,
        platform_extras: dict[str, Any],
        turn_id: str | None,
        motion_object: dict[str, Any],
        motion_payload: dict[str, Any],
    ) -> str:
        message_kind = str(platform_extras.get("message_kind") or "").strip()
        semantic_text = str(platform_extras.get("semantic_text") or "").strip()
        visible_message_id = str(platform_extras.get("visible_message_id") or "").strip()
        visible_group = TurnCoordinator._strip_segment_suffix(visible_message_id)
        try:
            motion_signature = json.dumps(
                motion_payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        except TypeError:
            motion_signature = str(motion_payload)
        return "|".join(
            [
                str(turn_id or "").strip(),
                message_kind,
                visible_group or visible_message_id,
                semantic_text,
                str(motion_object.get("source") or "").strip(),
                str(motion_object.get("mode") or "").strip(),
                motion_signature,
            ]
        )

    @staticmethod
    def _strip_segment_suffix(message_id: str) -> str:
        parts = message_id.rsplit("::", 1)
        if len(parts) != 2:
            return message_id
        suffix = parts[1]
        if len(suffix) == 4 and suffix.isdigit():
            return parts[0]
        return message_id

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
        self._get_dispatched_platform_motion_keys().clear()

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


def _resolve_initial_performance_curve_motion_payload(
    *,
    platform_extras: dict[str, Any],
    inline_payload: Any,
) -> dict[str, Any] | None:
    if isinstance(inline_payload, dict):
        return inline_payload
    for motion_object in _iter_platform_motion_client_objects(platform_extras):
        motion_payload = motion_object.get("motion_payload")
        if not isinstance(motion_payload, dict):
            motion_payload = motion_object.get("intent")
        if not isinstance(motion_payload, dict):
            motion_payload = motion_object.get("plan")
        if isinstance(motion_payload, dict):
            return motion_payload
    return None


def _coerce_perf_counter(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return None
