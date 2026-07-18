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
         - input.text                                      → _commit_inbound_message
    3. 除 system.* 与 engine preview 入口外，交互类 message.type 都要求 turn_id 非空
       （_require_interactive_turn_id）；前端 turn_id 通过 turn_identity_map 与
       后端 turn_id 互相绑定。

出站
    4. emit_message_chain 把 AstrBot 物理回复链合并为 logical output segment。
    5. close_turn_output_queue 原子发送 output.segment，再发 control.synth_finished。
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
import time
from typing import Any, Awaitable, Callable
from uuid import uuid4

from astrbot.api import logger
from astrbot.core.platform.message_session import MessageSession
from astrbot.core.platform.message_type import MessageType
from astrbot.core.utils.active_event_registry import active_event_registry

from ..protocol.builder import (
    build_control_error,
    build_control_interrupt,
    build_control_synth_finished,
    build_control_turn_finished,
    build_control_turn_started,
    build_output_segment,
)
from ..protocol.binary_audio import parse_binary_audio_frame
from ..protocol import (
    SOURCE_ADAPTER,
    TYPE_ENGINE_CATALOG_MOTION,
    TYPE_CONTROL_INTERRUPT,
    TYPE_CONTROL_PLAYBACK_FINISHED,
    TYPE_ENGINE_MOTION_INTENT,
    TYPE_INPUT_AUDIO_STREAM_CHUNK,
    TYPE_INPUT_AUDIO_STREAM_END,
    TYPE_INPUT_AUDIO_STREAM_START,
    TYPE_INPUT_TEXT,
    build_message_envelope,
    parse_inbound_message,
)
from ..services.speech_service import SpeechIngressService
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
    extract_official_inline_anim_motion_intent,
)
from ..motion.payload_dispatch import (
    extract_message_motion_payload as _extract_message_motion_payload,
    resolve_engine_motion_message_type as _resolve_engine_motion_message_type,
    resolve_motion_payload_schema_version as _resolve_motion_payload_schema_version,
    summarize_motion_payload as _summarize_motion_payload,
)
from ..motion.output_sanitizer import sanitize_assistant_output_text
from .message_utils import (
    extract_outbound_message_parts as _extract_outbound_message_parts,
    iter_platform_motion_client_objects as _iter_platform_motion_client_objects,
    resolve_platform_segment_message_id as _resolve_platform_segment_message_id,
)
from .image_diagnostics import (
    emit_image_input_diagnostics,
)
from ..motion.observation import record_motion_observation
from .output_segment import PendingOutputSegment

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
        self._last_prompt_motion_snapshot: dict[str, Any] | None = None
        self._current_performance_curve_context: dict[str, Any] | None = None
        self._pending_output_segments: dict[str, PendingOutputSegment] = {}
        self._flushed_output_segment_count = 0

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
        raw_reply_text_override: str | None = None,
        platform_extras: dict[str, Any] | None = None,
    ) -> None:
        """Merge one physical AstrBot chain into its logical output segment."""
        del unified_msg_origin

        turn_id = str(self.session_state.current_turn_id or "").strip()
        if not turn_id:
            raise ValueError("output_segment_requires_turn_id")
        platform_extras_dict = platform_extras if isinstance(platform_extras, dict) else {}
        segment_message_id = _resolve_platform_segment_message_id(platform_extras_dict)
        self._mark_turn_timing("emit_started_at")
        texts, picture_paths, record_paths, record_texts = _extract_outbound_message_parts(message_chain)
        logger.info(
            "WIRING output_parts turn_id=%s message_id=%s text_count=%s image_count=%s record_count=%s",
            turn_id or "",
            segment_message_id or "",
            len(texts),
            len(picture_paths),
            len(record_paths),
        )
        raw_reply_text = str(raw_reply_text_override or "").strip() or "\n".join(texts).strip()
        raw_record_text = "\n".join(record_texts).strip()
        record_text = sanitize_assistant_output_text(raw_record_text)
        reply_text = sanitize_assistant_output_text("\n".join(texts).strip())
        semantic_text = str(platform_extras_dict.get("semantic_text") or "").strip()
        canonical_text = _resolve_canonical_assistant_text(
            semantic_text=semantic_text,
            plain_text=reply_text,
            record_text=record_text,
            raw_reply_text=raw_reply_text,
        )
        segment = self._get_pending_output_segment(turn_id, segment_message_id)
        segment.merge_text(canonical_text)
        segment.merge_semantic_text(canonical_text)
        segment.merge_images(picture_paths)
        if len(record_paths) > 1:
            raise ValueError(f"output_segment_multiple_audio_files:{segment_message_id}")
        if record_paths:
            segment.merge_audio(path=record_paths[0])

        motion_candidate = self._resolve_output_segment_motion(
            platform_extras=platform_extras_dict,
            raw_reply_text=raw_reply_text,
        )
        if motion_candidate is not None:
            segment.merge_motion(**motion_candidate)
        self._try_start_performance_curve_request(
            segment=segment,
            platform_extras=platform_extras_dict,
        )

    def _get_pending_output_segment(
        self,
        turn_id: str,
        message_id: str,
    ) -> PendingOutputSegment:
        segments = getattr(self, "_pending_output_segments", None)
        if not isinstance(segments, dict):
            segments = {}
            self._pending_output_segments = segments
        key = f"{turn_id}|{message_id}"
        segment = segments.get(key)
        if segment is None:
            segment = PendingOutputSegment(turn_id=turn_id, message_id=message_id)
            segments[key] = segment
        return segment

    def _resolve_output_segment_motion(
        self,
        *,
        platform_extras: dict[str, Any],
        raw_reply_text: str,
    ) -> dict[str, Any] | None:
        candidates = _iter_platform_motion_client_objects(platform_extras)
        if len(candidates) > 1:
            raise ValueError("output_segment_multiple_motion_objects")
        if candidates:
            motion_object = candidates[0]
            payload = motion_object.get("motion_payload")
            if not isinstance(payload, dict):
                payload = motion_object.get("intent")
            if not isinstance(payload, dict):
                payload = motion_object.get("plan")
            if not isinstance(payload, dict):
                raise ValueError("output_segment_motion_payload_missing")
            return {
                "payload": payload,
                "mode": str(motion_object.get("mode") or "preview"),
                "source": str(motion_object.get("source") or "platform_extras"),
            }
        if not self._allows_official_inline_anim_compat():
            return None
        payload, reason = extract_official_inline_anim_motion_intent(raw_reply_text)
        if payload is None:
            if reason != "inline_anim_missing":
                raise ValueError(f"official_inline_anim_compat_rejected:{reason}")
            return None
        return {
            "payload": payload,
            "mode": "preview",
            "source": "official_inline_anim_compat",
        }

    async def _flush_pending_output_segments(self) -> None:
        segments = getattr(self, "_pending_output_segments", None)
        if not isinstance(segments, dict) or not segments:
            return
        for key, segment in list(segments.items()):
            await self._flush_output_segment(segment)
            segments.pop(key, None)
            self._flushed_output_segment_count += 1

    async def _flush_output_segment(self, segment: PendingOutputSegment) -> None:
        audio_slot: dict[str, Any] = {"state": "absent"}
        if segment.audio_path:
            if not segment.text:
                raise ValueError(
                    f"output_segment_audio_text_missing:{segment.message_id}"
                )
            _, audio_url = await asyncio.to_thread(
                self.media_service.cache_audio_file,
                segment.audio_path,
            )
            audio_slot = {
                "state": "present",
                "url": audio_url,
            }

        motion_slot = self._build_output_segment_motion_slot(segment)
        text_slot = (
            {"state": "present", "content": segment.text}
            if segment.text
            else {"state": "absent"}
        )
        sent = await self._send_json(
            build_output_segment(
                turn_id=segment.turn_id,
                message_id=segment.message_id,
                text=text_slot,
                audio=audio_slot,
                motion=motion_slot,
                images=segment.images,
                speaker_name=self.speaker_name,
                avatar="",
            )
        )
        if not sent:
            raise RuntimeError(f"output_segment_send_failed:{segment.message_id}")
        if segment.text:
            self.chat_buffer.add("assistant", segment.text)
        self._record_motion_lab_raw_event(
            event_type="turn.assistant_output",
            turn_id=segment.turn_id,
            message_id=segment.message_id,
            source_route="output.segment",
            phase="assistant_output",
            assistant_text=segment.semantic_text,
            raw={
                "reply_text": segment.text,
                "images": list(segment.images),
                "motion": motion_slot,
                "chat_context": self._motion_lab_chat_context(),
            },
        )
        if audio_slot["state"] == "present":
            self._mark_turn_timing("audio_payload_sent_at")
            self._mark_turn_synthesizing()
        self._mark_turn_playing()

    def _build_output_segment_motion_slot(
        self,
        segment: PendingOutputSegment,
    ) -> dict[str, Any]:
        if segment.motion_payload is None:
            return {"state": "absent"}
        payload = segment.motion_payload
        if _resolve_motion_payload_schema_version(payload) in {
            "engine.motion_intent.v3",
            "engine.motion_intent.v4",
        }:
            payload = normalize_motion_intent_payload(payload)
        message_type = _resolve_engine_motion_message_type(payload)
        if message_type not in {TYPE_ENGINE_MOTION_INTENT, TYPE_ENGINE_CATALOG_MOTION}:
            raise ValueError("output_segment_motion_type_invalid")
        payload = self._attach_ready_performance_curve_hint(
            motion_payload=payload,
            turn_id=segment.turn_id,
            message_id=segment.message_id,
        )
        hint = payload.get("performance_curve_hint")
        runtime = getattr(getattr(self, "runtime_state", None), "performance_curve_runtime", None)
        if not isinstance(hint, dict):
            reason = {
                "disabled": "performance_curve_disabled",
                "failed": "performance_curve_request_rejected",
                "pending": "performance_curve_request_not_started",
            }.get(
                segment.curve_request_state,
                "not_ready_before_segment_egress",
            )
            fail_if_not_ready = getattr(runtime, "fail_if_not_ready", None)
            if segment.curve_request_state == "started" and callable(fail_if_not_ready):
                fail_if_not_ready(
                    turn_id=segment.turn_id,
                    message_id=segment.message_id,
                    reason=reason,
                )
            self._record_motion_lab_raw_event(
                event_type="performance_curve.skipped",
                turn_id=segment.turn_id,
                message_id=segment.message_id,
                source_route="output.segment",
                phase="performance_curve",
                assistant_text=segment.semantic_text,
                payload_kind="ag99.performance_curve_hint.v1",
                raw={"reason": reason},
            )
        clear = getattr(runtime, "clear", None)
        if callable(clear):
            clear(turn_id=segment.turn_id, message_id=segment.message_id)
        self._record_prompt_motion_snapshot(
            motion_payload=payload,
            source=segment.motion_source,
        )
        return {
            "state": "present",
            "message_type": message_type,
            "mode": segment.motion_mode,
            "source": segment.motion_source,
            "payload": payload,
        }

    async def close_turn_output_queue(self) -> None:
        """Flush at least one atomic segment, then transactionally close its queue."""
        current_turn_id = self.session_state.current_turn_id
        if current_turn_id is None:
            return

        if not self.session_state.begin_output_queue_close(current_turn_id):
            return
        try:
            await self._flush_pending_output_segments()
            if self._flushed_output_segment_count < 1:
                raise RuntimeError(f"output_segment_missing:{current_turn_id}")
            sent = await self._send_json(
                build_control_synth_finished(
                    turn_id=current_turn_id,
                )
            )
            if not sent:
                raise RuntimeError(f"synth_finished_send_failed:{current_turn_id}")
        except Exception:
            self.session_state.abort_output_queue_close(current_turn_id)
            raise
        self.session_state.complete_output_queue_close(current_turn_id)
        runtime_state = getattr(self, "runtime_state", None)
        performance_curve_runtime = getattr(
            runtime_state,
            "performance_curve_runtime",
            None,
        )
        cancel_curve_turn = getattr(performance_curve_runtime, "cancel_turn", None)
        if callable(cancel_curve_turn):
            cancel_curve_turn(current_turn_id)
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
                await self._send_json(
                    build_control_error(
                        turn_id=turn_id,
                        message="input_turn_replacement_requires_interrupt",
                    )
                )
                logger.error(
                    "Rejecting input turn=%s while prior turn=%s still waits for playback; "
                    "control.interrupt is required first.",
                    turn_id,
                    self.session_state.current_turn_id,
                )
                return

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
            self._flushed_output_segment_count = 0
            await self._send_json(
                build_control_turn_started(
                    turn_id=current_turn_id,
                )
            )
            await self._emit_image_input_diagnostics(message_obj)

            event = self._build_platform_event(message_obj)
            set_extra = getattr(event, "set_extra", None)
            if callable(set_extra):
                set_extra("enable_streaming", False)
            self._apply_raw_message_metadata_to_event(event, message_obj)
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

    async def _emit_image_input_diagnostics(self, message_obj) -> None:
        await emit_image_input_diagnostics(
            message_obj=message_obj,
            client_uid=self.session_state.client_uid,
            current_turn_id=self.session_state.current_turn_id,
            send_json=self._send_json,
        )

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

    def get_last_prompt_motion_snapshot(self) -> dict[str, Any] | None:
        snapshot = getattr(self, "_last_prompt_motion_snapshot", None)
        if not isinstance(snapshot, dict):
            return None
        cloned_snapshot = dict(snapshot)
        axes = snapshot.get("axes")
        axis_levels = snapshot.get("axis_levels")
        motion_steps = snapshot.get("motion_steps")
        if isinstance(axes, dict):
            cloned_snapshot["axes"] = dict(axes)
        if isinstance(axis_levels, dict):
            cloned_snapshot["axis_levels"] = dict(axis_levels)
        if isinstance(motion_steps, list):
            cloned_snapshot["motion_steps"] = [
                {
                    **step,
                    "axis_levels": dict(step.get("axis_levels") or {}),
                }
                for step in motion_steps
                if isinstance(step, dict)
            ]
        return cloned_snapshot

    def _record_prompt_motion_snapshot(
        self,
        *,
        motion_payload: dict[str, Any],
        source: str,
    ) -> None:
        if str(motion_payload.get("schema_version") or "").strip() not in {
            "engine.motion_intent.v3",
            "engine.motion_intent.v4",
        }:
            return
        schema_version = str(motion_payload.get("schema_version") or "").strip()
        axes = motion_payload.get("axes")
        axis_levels = motion_payload.get("axis_levels")
        motion_steps = motion_payload.get("motion_steps")
        if schema_version == "engine.motion_intent.v4":
            has_levels = isinstance(axis_levels, dict) and bool(axis_levels)
            has_steps = isinstance(motion_steps, list) and bool(motion_steps)
            if has_levels == has_steps or "axes" in motion_payload:
                return
        elif not isinstance(axes, dict) or not axes or "axis_levels" in motion_payload:
            return

        normalized_axes: dict[str, float] = {}
        if isinstance(axes, dict):
            for axis_id, axis_value in axes.items():
                if not isinstance(axis_value, (int, float)) or isinstance(axis_value, bool):
                    continue
                normalized_axis_id = str(axis_id or "").strip()
                if not normalized_axis_id:
                    continue
                normalized_axes[normalized_axis_id] = round(float(axis_value), 4)
        normalized_levels = dict(axis_levels) if isinstance(axis_levels, dict) else {}

        intent_tags = motion_payload.get("intent_tags")
        normalized_tags = []
        if isinstance(intent_tags, list):
            normalized_tags = [
                str(item).strip()
                for item in intent_tags
                if str(item).strip()
            ][:6]

        snapshot = {
            "schema_version": schema_version,
            "source": str(source or "").strip(),
            "intent_tags": normalized_tags,
        }
        if schema_version == "engine.motion_intent.v4":
            if normalized_levels:
                snapshot["axis_levels"] = normalized_levels
            if isinstance(motion_steps, list):
                snapshot["motion_steps"] = [
                    {
                        "axis_levels": dict(step.get("axis_levels") or {}),
                        "duration_weight": step.get("duration_weight"),
                    }
                    for step in motion_steps
                    if isinstance(step, dict)
                ]
            snapshot["expression_resource_id"] = str(
                motion_payload.get("expression_resource_id") or ""
            ).strip()
            snapshot["motion_resource_id"] = str(
                motion_payload.get("motion_resource_id") or ""
            ).strip()
        else:
            snapshot["axes"] = normalized_axes
            snapshot["resource_id"] = str(
                motion_payload.get("resource_id") or ""
            ).strip()
        self._last_prompt_motion_snapshot = snapshot

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
        return record_motion_observation(
            getattr(runtime_state, "motion_lab_recorder", None),
            event_type=event_type,
            conversation_uid=getattr(self.session_state, "client_uid", None),
            turn_id=turn_id if turn_id is not None else self.session_state.current_turn_id,
            frontend_turn_id=frontend_turn_id,
            message_id=message_id,
            source_route=source_route,
            phase=phase,
            model_name=str((profile or {}).get("model_id") or "").strip(),
            profile_id=str((profile or {}).get("profile_id") or "").strip(),
            profile_revision=(profile or {}).get("revision"),
            user_text=user_text,
            assistant_text=assistant_text,
            payload_kind=payload_kind,
            raw=raw or {},
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

    def _try_start_performance_curve_request(
        self,
        *,
        segment: PendingOutputSegment,
        platform_extras: dict[str, Any],
    ) -> None:
        if segment.curve_request_state != "pending":
            return
        if segment.motion_payload is None or not segment.semantic_text:
            return

        runtime_state = getattr(self, "runtime_state", None)
        if not bool(getattr(runtime_state, "enable_performance_curve", False)):
            segment.curve_request_state = "disabled"
            return

        self._current_performance_curve_context = {
            "turn_id": segment.turn_id,
            "message_id": segment.message_id,
            "assistant_text": segment.semantic_text,
            "assistant_reply_keywords": extract_assistant_reply_keywords(
                segment.semantic_text
            ),
            "chat_context": self._motion_lab_chat_context(),
            "platform_extras": platform_extras,
        }
        try:
            started = self._start_performance_curve_request(
                motion_payload=segment.motion_payload,
            )
        finally:
            self._current_performance_curve_context = None
        segment.curve_request_state = "started" if started else "failed"
        if not started:
            logger.error(
                "Performance curve request rejected after canonical text and motion "
                "were ready. turn_id=%s message_id=%s",
                segment.turn_id,
                segment.message_id,
            )

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
        pending_segments = getattr(self, "_pending_output_segments", None)
        if isinstance(pending_segments, dict):
            pending_segments.clear()
        self._flushed_output_segment_count = 0

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


def _resolve_canonical_assistant_text(
    *,
    semantic_text: str,
    plain_text: str,
    record_text: str,
    raw_reply_text: str,
) -> str:
    candidates = [
        ("semantic_text", sanitize_assistant_output_text(semantic_text)),
        ("plain_text", sanitize_assistant_output_text(plain_text)),
        ("record_text", sanitize_assistant_output_text(record_text)),
    ]
    populated = [(source, value) for source, value in candidates if value]
    distinct_values = {value for _source, value in populated}
    if len(distinct_values) > 1:
        sources = ",".join(source for source, _value in populated)
        raise ValueError(f"output_segment_canonical_text_conflict:{sources}")
    if populated:
        return populated[0][1]
    return sanitize_assistant_output_text(raw_reply_text)
