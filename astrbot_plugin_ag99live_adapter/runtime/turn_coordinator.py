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
    4. emit_message_chain 把 AstrBot 物理回复链合并为 logical output segment。
    5. close_turn_output_queue 原子发送 output.segment，再发 control.synth_finished。
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
    build_control_synth_finished,
    build_control_turn_finished,
    build_control_turn_started,
    build_output_segment,
)
from ..protocol.binary_audio import parse_binary_audio_frame
from ..protocol.schema_versions import (
    MOTION_INTENT_V4_SCHEMA_VERSION,
    PERFORMANCE_CURVE_HINT_SCHEMA_VERSION,
)
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
from ..motion.payload_validation import validate_normalized_motion_intent_payload
from ..motion.payload_dispatch import (
    resolve_engine_motion_message_type as _resolve_engine_motion_message_type,
    resolve_motion_payload_schema_version as _resolve_motion_payload_schema_version,
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


MAX_REMEMBERED_TERMINAL_TURNS = 256


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
            on_vad_speech_started=self._handle_vad_speech_started,
        )

        self._turn_lock = asyncio.Lock()
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self._turn_timings: dict[str, dict[str, Any]] = {}
        self._events_by_turn_id: dict[str, Any] = {}
        self._last_prompt_motion_snapshot: dict[str, Any] | None = None
        self._pending_output_segments: dict[str, PendingOutputSegment] = {}
        self._closing_output_turn_ids: set[str] = set()
        self._closed_output_turn_ids: set[str] = set()
        self._output_emitted_turn_ids: set[str] = set()
        self._turn_terminal_results: dict[str, tuple[bool, str | None] | None] = {}
        self._active_vad_turn_by_capture_turn: dict[str, str] = {}

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

            if message.type == TYPE_INPUT_AUDIO_STREAM_CHUNK:
                await self.speech_ingress.handle_audio_stream_chunk(message)
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
        except Exception as exc:
            logger.exception(
                "Inbound turn message failed: type=%s turn_id=%s",
                message.type,
                turn_id,
            )
            try:
                await self._finish_turn(
                    turn_id=turn_id,
                    success=False,
                    reason=f"inbound_message_processing_failed:{message.type}",
                )
            except Exception:
                logger.exception(
                    "Failed to publish terminal state after inbound turn error: "
                    "type=%s turn_id=%s original_error=%s",
                    message.type,
                    turn_id,
                    exc,
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
            tracked_turn_ids.update(self._closing_output_turn_ids)
            tracked_turn_ids.update(self._closed_output_turn_ids)
            tracked_turn_ids.update(self._output_emitted_turn_ids)
            tracked_turn_ids.update(self._turn_terminal_results)
            tracked_turn_ids.update(self._events_by_turn_id)
            tracked_turn_ids.update(
                segment.turn_id for segment in self._pending_output_segments.values()
            )
            performance_curve_runtime = getattr(
                self.runtime_state,
                "performance_curve_runtime",
                None,
            )
            cancel_curve_turn = getattr(performance_curve_runtime, "cancel_turn", None)
            if callable(cancel_curve_turn):
                for turn_id in tracked_turn_ids:
                    try:
                        cancel_curve_turn(turn_id)
                    except Exception:
                        cleanup_failures.append(f"{turn_id}:curve_cancel_failed")
                        logger.exception(
                            "Failed to cancel performance curve during disconnect: "
                            "turn_id=%s",
                            turn_id,
                        )
        finally:
            self._turn_timings.clear()
            self._pending_output_segments.clear()
            self._closing_output_turn_ids.clear()
            self._closed_output_turn_ids.clear()
            self._output_emitted_turn_ids.clear()
            self._turn_terminal_results.clear()
            self._events_by_turn_id.clear()
            self._active_vad_turn_by_capture_turn.clear()
            self._last_prompt_motion_snapshot = None

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
        """Merge one physical AstrBot chain into its logical output segment."""
        del unified_msg_origin

        turn_id = self._require_turn_id_value(turn_id)
        self._require_output_queue_open(turn_id)
        platform_extras_dict = platform_extras if isinstance(platform_extras, dict) else {}
        segment_message_id = _resolve_platform_segment_message_id(platform_extras_dict)
        self._mark_turn_timing(turn_id, "emit_started_at")
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
        tts_state, audio_attachment = _extract_platform_tts_delivery_state(
            platform_extras_dict,
            expected_turn_id=turn_id,
            expected_message_id=segment_message_id,
        )
        if audio_attachment == "present" and not record_paths:
            raise ValueError(
                f"output_segment_audio_attachment_missing:{segment_message_id}"
            )
        if audio_attachment == "absent" and record_paths:
            raise ValueError(
                f"output_segment_unexpected_audio_attachment:{segment_message_id}"
            )
        if record_paths:
            segment.merge_audio(path=record_paths[0])
        if tts_state is not None:
            segment.merge_tts_terminal_state(**tts_state)
            if self.runtime_state.performance_curve_runtime.owns_request(
                turn_id=turn_id,
                request_id=tts_state["request_id"],
            ):
                segment.bind_performance_curve_request(tts_state["request_id"])

        motion_candidate, motion_resolution_failure = (
            self._resolve_output_segment_motion(
                platform_extras=platform_extras_dict,
                raw_reply_text=raw_reply_text,
            )
        )
        motion_expected, motion_failure_reason = (
            _resolve_output_segment_motion_schedule(platform_extras_dict)
        )
        if motion_expected:
            segment.require_motion()
        if motion_resolution_failure:
            segment.merge_motion_failure(motion_resolution_failure)
        elif motion_failure_reason:
            segment.merge_motion_failure(motion_failure_reason)
        if motion_candidate is not None:
            segment.merge_motion(**motion_candidate)

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

    def _require_output_queue_open(self, turn_id: str) -> None:
        if (
            turn_id in self._closing_output_turn_ids
            or turn_id in self._closed_output_turn_ids
            or turn_id in self._output_emitted_turn_ids
            or turn_id in self._turn_terminal_results
        ):
            raise RuntimeError(f"output_segment_queue_closed:{turn_id}")

    def _resolve_output_segment_motion(
        self,
        *,
        platform_extras: dict[str, Any],
        raw_reply_text: str,
    ) -> tuple[dict[str, Any] | None, str]:
        candidates = _iter_platform_motion_client_objects(platform_extras)
        if len(candidates) > 1:
            return None, "output_segment_multiple_motion_objects"
        if candidates:
            motion_object = candidates[0]
            payload = motion_object.get("motion_payload")
            if not isinstance(payload, dict):
                payload = motion_object.get("intent")
            if not isinstance(payload, dict):
                payload = motion_object.get("plan")
            if not isinstance(payload, dict):
                return None, "output_segment_motion_payload_missing"
            return (
                {
                    "payload": payload,
                    "mode": str(motion_object.get("mode") or "preview"),
                    "source": str(motion_object.get("source") or "platform_extras"),
                },
                "",
            )
        if not self._allows_official_inline_anim_compat():
            return None, ""
        payload, reason = extract_official_inline_anim_motion_intent(raw_reply_text)
        if payload is None:
            if reason != "inline_anim_missing":
                return None, f"official_inline_anim_compat_rejected:{reason}"
            return None, ""
        payload, validation_reason = validate_normalized_motion_intent_payload(
            payload,
            self.runtime_state,
            base_reason=reason,
        )
        if payload is None:
            return (
                None,
                f"official_inline_anim_compat_rejected:{validation_reason}",
            )
        return (
            {
                "payload": payload,
                "mode": "preview",
                "source": "official_inline_anim_compat",
            },
            "",
        )

    async def _flush_pending_output_segments(self, *, turn_id: str) -> int:
        segments = getattr(self, "_pending_output_segments", None)
        if not isinstance(segments, dict) or not segments:
            return 0
        flushed_count = 0
        for key, segment in list(segments.items()):
            if segment.turn_id != turn_id:
                continue
            await self._flush_output_segment(segment)
            segments.pop(key, None)
            flushed_count += 1
        return flushed_count

    async def _flush_output_segment(self, segment: PendingOutputSegment) -> None:
        if segment.tts_status == "succeeded" and not segment.audio_path:
            raise ValueError(
                f"output_segment_tts_succeeded_without_audio:{segment.message_id}"
            )
        if segment.tts_status == "failed" and segment.audio_path:
            raise ValueError(
                f"output_segment_tts_failed_with_audio:{segment.message_id}"
            )
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
        if segment.audio_failure_reason:
            audio_slot = {
                "state": "failed",
                "reason": segment.audio_failure_reason,
            }
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
        self._commit_motion_output_side_effects(segment, motion_slot)
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
            self._mark_turn_timing(segment.turn_id, "audio_payload_sent_at")
            self._mark_turn_synthesizing(segment.turn_id)
        self._mark_turn_playing(segment.turn_id)

    def _build_output_segment_motion_slot(
        self,
        segment: PendingOutputSegment,
    ) -> dict[str, Any]:
        if segment.motion_payload is None:
            if segment.motion_failure_reason:
                return {
                    "state": "failed",
                    "reason": segment.motion_failure_reason,
                }
            if segment.motion_expected:
                return {
                    "state": "failed",
                    "reason": "motion_schedule_payload_missing",
                }
            return {"state": "absent"}
        payload = segment.motion_payload
        if _resolve_motion_payload_schema_version(payload) == MOTION_INTENT_V4_SCHEMA_VERSION:
            payload = normalize_motion_intent_payload(payload)
        message_type = _resolve_engine_motion_message_type(payload)
        if message_type not in {TYPE_ENGINE_MOTION_INTENT, TYPE_ENGINE_CATALOG_MOTION}:
            raise ValueError("output_segment_motion_type_invalid")
        payload = self._attach_ready_performance_curve_hint(
            motion_payload=payload,
            turn_id=segment.turn_id,
            message_id=segment.message_id,
            request_id=segment.performance_curve_request_id,
        )
        return {
            "state": "present",
            "message_type": message_type,
            "mode": segment.motion_mode,
            "source": segment.motion_source,
            "payload": payload,
        }

    def _commit_motion_output_side_effects(
        self,
        segment: PendingOutputSegment,
        motion_slot: dict[str, Any],
    ) -> None:
        payload = motion_slot.get("payload")
        if not isinstance(payload, dict):
            return

        request_id = segment.performance_curve_request_id
        if request_id:
            hint = payload.get("performance_curve_hint")
            runtime = getattr(self.runtime_state, "performance_curve_runtime", None)
            try:
                if isinstance(hint, dict):
                    self._record_motion_lab_raw_event(
                        event_type="performance_curve.attached",
                        turn_id=segment.turn_id,
                        message_id=segment.message_id,
                        source_route="performance_curve_provider",
                        phase="performance_curve",
                        assistant_text=segment.semantic_text,
                        payload_kind=PERFORMANCE_CURVE_HINT_SCHEMA_VERSION,
                        raw={
                            "performance_curve_request_id": request_id,
                            "curve_hint": hint,
                            "motion_intent_tags": [
                                str(item).strip()
                                for item in payload.get("intent_tags", [])
                                if str(item).strip()
                            ],
                        },
                    )
                elif runtime is not None:
                    discarded = runtime.discard_if_not_ready(
                        turn_id=segment.turn_id,
                        request_id=request_id,
                    )
                    if discarded:
                        self._record_motion_lab_raw_event(
                            event_type="performance_curve.skipped",
                            turn_id=segment.turn_id,
                            message_id=segment.message_id,
                            source_route="output.segment",
                            phase="performance_curve",
                            assistant_text=segment.semantic_text,
                            payload_kind=PERFORMANCE_CURVE_HINT_SCHEMA_VERSION,
                            raw={
                                "reason": "not_ready_before_segment_egress",
                                "performance_curve_request_id": request_id,
                            },
                        )
            except Exception as exc:  # noqa: BLE001 - optional curve cannot block turn closure.
                self._record_performance_curve_outcome(
                    event_type="performance_curve.failed",
                    reason=f"cleanup_exception:{exc}",
                    turn_id=segment.turn_id,
                    message_id=segment.message_id,
                    assistant_text=segment.semantic_text,
                    tts_turn_id="",
                    request_id=request_id,
                )
            finally:
                if runtime is not None:
                    try:
                        runtime.clear(turn_id=segment.turn_id, request_id=request_id)
                    except Exception as exc:  # noqa: BLE001 - optional curve cleanup.
                        self._record_performance_curve_outcome(
                            event_type="performance_curve.failed",
                            reason=f"clear_exception:{exc}",
                            turn_id=segment.turn_id,
                            message_id=segment.message_id,
                            assistant_text=segment.semantic_text,
                            tts_turn_id="",
                            request_id=request_id,
                        )
        self._record_prompt_motion_snapshot(
            motion_payload=payload,
            source=segment.motion_source,
        )

    async def close_turn_output_queue(self, *, turn_id: str) -> None:
        """Flush at least one atomic segment, then transactionally close its queue."""
        current_turn_id = self._require_turn_id_value(turn_id)
        if current_turn_id in self._closed_output_turn_ids:
            return
        if current_turn_id in self._closing_output_turn_ids:
            return
        self._closing_output_turn_ids.add(current_turn_id)
        try:
            flushed_count = await self._flush_pending_output_segments(
                turn_id=current_turn_id
            )
            if flushed_count > 0:
                self._output_emitted_turn_ids.add(current_turn_id)
            if current_turn_id not in self._output_emitted_turn_ids:
                reason = f"output_segment_missing:{current_turn_id}"
                error_sent = await self._send_json(
                    build_control_error(
                        turn_id=current_turn_id,
                        message=reason,
                    )
                )
                if not error_sent:
                    raise RuntimeError(f"control_error_send_failed:{current_turn_id}")
                await self._finish_turn(
                    turn_id=current_turn_id,
                    success=False,
                    reason=reason,
                )
                return
            sent = await self._send_json(
                build_control_synth_finished(
                    turn_id=current_turn_id,
                )
            )
            if not sent:
                raise RuntimeError(f"synth_finished_send_failed:{current_turn_id}")
        except Exception:
            self._closing_output_turn_ids.discard(current_turn_id)
            raise
        self._closing_output_turn_ids.discard(current_turn_id)
        self._closed_output_turn_ids.add(current_turn_id)
        runtime_state = getattr(self, "runtime_state", None)
        performance_curve_runtime = getattr(
            runtime_state,
            "performance_curve_runtime",
            None,
        )
        cancel_curve_turn = getattr(performance_curve_runtime, "cancel_turn", None)
        if callable(cancel_curve_turn):
            cancel_curve_turn(current_turn_id)
        self._mark_turn_playing(current_turn_id)

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
        if (
            str(motion_payload.get("schema_version") or "").strip()
            != MOTION_INTENT_V4_SCHEMA_VERSION
        ):
            return
        axis_levels = motion_payload.get("axis_levels")
        motion_steps = motion_payload.get("motion_steps")
        has_levels = isinstance(axis_levels, dict) and bool(axis_levels)
        has_steps = isinstance(motion_steps, list) and bool(motion_steps)
        if has_levels == has_steps or "axes" in motion_payload:
            return
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
            "schema_version": MOTION_INTENT_V4_SCHEMA_VERSION,
            "source": str(source or "").strip(),
            "intent_tags": normalized_tags,
        }
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
        self._last_prompt_motion_snapshot = snapshot

    def _record_motion_lab_raw_event(
        self,
        *,
        event_type: str,
        turn_id: str,
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
            turn_id=self._require_turn_id_value(turn_id),
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

    def start_performance_curve_request(
        self,
        *,
        turn_id: str | None,
        tts_turn_id: str | None,
        message_id: str | None,
        request_id: str | None,
        assistant_text: str,
        motion_payload: Any,
    ) -> str | None:
        runtime_state = self.runtime_state
        if not runtime_state.enable_performance_curve:
            return None

        normalized_turn_id = str(turn_id or "").strip()
        normalized_tts_turn_id = str(tts_turn_id or "").strip()
        normalized_message_id = str(message_id or "").strip()
        normalized_request_id = str(request_id or "").strip()
        normalized_assistant_text = str(assistant_text or "").strip()
        runtime = getattr(runtime_state, "performance_curve_runtime", None)
        skip_reason = ""
        if runtime is None:
            skip_reason = "runtime_unavailable"
        elif not isinstance(motion_payload, dict):
            skip_reason = "pending_motion_payload_invalid"
        elif not normalized_turn_id:
            skip_reason = "turn_id_missing"
        elif not normalized_tts_turn_id:
            skip_reason = "tts_turn_id_missing"
        elif not normalized_message_id:
            skip_reason = "message_id_missing"
        elif not normalized_request_id:
            skip_reason = "tts_request_id_missing"
        elif not normalized_assistant_text:
            skip_reason = "assistant_text_missing"
        if skip_reason:
            self._record_performance_curve_outcome(
                event_type="performance_curve.skipped",
                reason=skip_reason,
                turn_id=normalized_turn_id,
                message_id=normalized_message_id,
                assistant_text=normalized_assistant_text,
                tts_turn_id=normalized_tts_turn_id,
                request_id=normalized_request_id,
            )
            return None

        try:
            motion_summary = summarize_motion_for_curve(motion_payload)
            motion_intent_tags = [
                str(item).strip()
                for item in motion_summary.get("intent_tags", [])
                if str(item).strip()
            ]
            request = PerformanceCurveInput(
                turn_id=normalized_turn_id,
                tts_turn_id=normalized_tts_turn_id,
                message_id=normalized_message_id,
                request_id=normalized_request_id,
                assistant_text=normalized_assistant_text,
                assistant_reply_keywords=extract_assistant_reply_keywords(
                    normalized_assistant_text
                ),
                motion_intent_tags=motion_intent_tags,
                motion_effect_summary=motion_summary,
                chat_context=self._motion_lab_chat_context(),
            )
            if runtime.start(request):
                return normalized_request_id
        except Exception as exc:  # noqa: BLE001
            self._record_performance_curve_outcome(
                event_type="performance_curve.failed",
                reason=f"start_exception:{exc}",
                turn_id=normalized_turn_id,
                message_id=normalized_message_id,
                assistant_text=normalized_assistant_text,
                tts_turn_id=normalized_tts_turn_id,
                request_id=normalized_request_id,
            )
            return None

        self._record_performance_curve_outcome(
            event_type="performance_curve.skipped",
            reason="request_rejected",
            turn_id=normalized_turn_id,
            message_id=normalized_message_id,
            assistant_text=normalized_assistant_text,
            tts_turn_id=normalized_tts_turn_id,
            request_id=normalized_request_id,
        )
        return None

    def _record_performance_curve_outcome(
        self,
        *,
        event_type: str,
        reason: str,
        turn_id: str,
        message_id: str,
        assistant_text: str,
        tts_turn_id: str,
        request_id: str,
    ) -> None:
        logger.warning(
            "WIRING %s reason=%s turn_id=%s message_id=%s tts_request_id=%s",
            event_type,
            reason,
            turn_id or "<missing>",
            message_id or "<missing>",
            request_id or "<missing>",
        )
        if not turn_id:
            return
        self._record_motion_lab_raw_event(
            event_type=event_type,
            turn_id=turn_id,
            message_id=message_id or None,
            source_route="performance_curve_provider",
            phase="performance_curve",
            assistant_text=assistant_text,
            payload_kind=PERFORMANCE_CURVE_HINT_SCHEMA_VERSION,
            raw={
                "reason": reason,
                "tts_turn_id": tts_turn_id,
                "tts_request_id": request_id,
            },
        )

    def _attach_ready_performance_curve_hint(
        self,
        *,
        motion_payload: dict[str, Any],
        turn_id: str | None,
        message_id: str,
        request_id: str | None,
    ) -> dict[str, Any]:
        normalized_request_id = str(request_id or "").strip()
        if not normalized_request_id:
            return motion_payload
        runtime = getattr(self.runtime_state, "performance_curve_runtime", None)
        if runtime is None:
            self._record_performance_curve_outcome(
                event_type="performance_curve.skipped",
                reason="runtime_unavailable_before_egress",
                turn_id=str(turn_id or "").strip(),
                message_id=message_id,
                assistant_text="",
                tts_turn_id="",
                request_id=normalized_request_id,
            )
            return motion_payload
        try:
            hint = runtime.get_ready(turn_id=turn_id, request_id=normalized_request_id)
        except Exception as exc:  # noqa: BLE001
            self._record_performance_curve_outcome(
                event_type="performance_curve.failed",
                reason=f"result_lookup_exception:{exc}",
                turn_id=str(turn_id or "").strip(),
                message_id=message_id,
                assistant_text="",
                tts_turn_id="",
                request_id=normalized_request_id,
            )
            return motion_payload
        if not isinstance(hint, dict):
            return motion_payload

        try:
            next_payload, attached_hint = attach_performance_curve_hint(motion_payload, hint)
            if attached_hint is None:
                raise ValueError("performance_curve_runtime_hint_invalid")
            return next_payload
        except Exception as exc:  # noqa: BLE001 - optional curve must not block egress.
            self._record_performance_curve_outcome(
                event_type="performance_curve.failed",
                reason=f"hint_invalid:{exc}",
                turn_id=str(turn_id or "").strip(),
                message_id=message_id,
                assistant_text="",
                tts_turn_id="",
                request_id=normalized_request_id,
            )
            return motion_payload

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
        pending_segments = getattr(self, "_pending_output_segments", None)
        if isinstance(pending_segments, dict):
            prefix = f"{resolved_turn_id}|"
            for key in tuple(pending_segments):
                if key.startswith(prefix):
                    pending_segments.pop(key, None)
        self._closing_output_turn_ids.discard(resolved_turn_id)
        self._closed_output_turn_ids.discard(resolved_turn_id)
        self._output_emitted_turn_ids.discard(resolved_turn_id)
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


def _extract_platform_tts_delivery_state(
    platform_extras: dict[str, Any],
    *,
    expected_turn_id: str,
    expected_message_id: str,
) -> tuple[dict[str, str] | None, str]:
    if "output_segment" not in platform_extras:
        if "audio_attachment" in platform_extras:
            raise ValueError("output_segment_metadata_missing")
        return None, ""
    output_segment = platform_extras.get("output_segment")
    if not isinstance(output_segment, dict):
        raise ValueError("output_segment_metadata_invalid")
    tts = output_segment.get("tts")
    if not isinstance(tts, dict):
        raise ValueError("output_segment_tts_metadata_missing")

    segment_turn_id = str(output_segment.get("turn_id") or "").strip()
    segment_message_id = str(output_segment.get("message_id") or "").strip()
    external_correlation_id = str(
        output_segment.get("external_correlation_id") or ""
    ).strip()
    tts_turn_id = str(tts.get("turn_id") or "").strip()
    tts_message_id = str(tts.get("message_id") or "").strip()
    tts_external_correlation_id = str(
        tts.get("external_correlation_id") or ""
    ).strip()
    if segment_turn_id != tts_turn_id:
        raise ValueError("output_segment_tts_turn_id_mismatch")
    if segment_message_id != expected_message_id or tts_message_id != expected_message_id:
        raise ValueError("output_segment_tts_message_id_mismatch")
    if external_correlation_id != expected_turn_id:
        raise ValueError("output_segment_external_correlation_id_mismatch")
    if tts_external_correlation_id != external_correlation_id:
        raise ValueError("output_segment_tts_external_correlation_id_mismatch")

    audio_attachment = str(platform_extras.get("audio_attachment") or "").strip()
    if audio_attachment not in {"present", "absent"}:
        raise ValueError(f"output_segment_audio_attachment_invalid:{audio_attachment}")
    return (
        {
            "request_id": str(tts.get("tts_request_id") or "").strip(),
            "status": str(tts.get("status") or "").strip(),
            "failure_code": str(tts.get("failure_code") or "").strip(),
        },
        audio_attachment,
    )


def _resolve_output_segment_motion_schedule(
    platform_extras: dict[str, Any],
) -> tuple[bool, str]:
    """Keep a contributor's motion expectation distinct from normal absence."""
    metadata = platform_extras.get("metadata")
    if not isinstance(metadata, dict):
        return False, ""
    schedule = metadata.get("ag99live_motion_schedule")
    if not isinstance(schedule, dict):
        return False, ""

    scheduled = schedule.get("scheduled")
    if not isinstance(scheduled, bool):
        return True, "motion_schedule_metadata_invalid"
    source = str(schedule.get("source") or "").strip()
    reason = str(schedule.get("reason") or "").strip()
    resolution_reason = str(
        schedule.get("motion_resolution_reason") or ""
    ).strip()

    if scheduled:
        if not source:
            return True, "motion_schedule_source_missing"
        return True, ""
    if reason == "motion_payload_missing":
        return (
            True,
            f"motion_schedule_failed:{resolution_reason or reason}",
        )
    return False, ""
