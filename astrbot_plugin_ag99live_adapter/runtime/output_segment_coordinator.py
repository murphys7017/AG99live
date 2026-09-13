"""Aggregate and publish one connection's logical output segments."""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

from astrbot.api import logger

from ..motion.inline_motion import extract_official_inline_anim_motion_intent
from ..motion.motion_intent import normalize_motion_intent_payload
from ..motion.output_sanitizer import sanitize_assistant_output_text
from ..motion.payload_dispatch import (
    resolve_engine_motion_message_type,
    resolve_motion_payload_schema_version,
)
from ..motion.payload_validation import validate_normalized_motion_intent_payload
from ..motion.resource_catalog import ModelInfoRuntimeContext
from ..protocol.builder import (
    build_control_error,
    build_control_synth_finished,
    build_output_segment,
)
from ..protocol.constants import TYPE_ENGINE_MOTION_INTENT
from ..protocol.schema_versions import MOTION_INTENT_V4_SCHEMA_VERSION
from .message_utils import (
    extract_outbound_message_parts,
    iter_platform_motion_client_objects,
    resolve_platform_segment_message_id,
)
from .motion_observation_recorder import MotionObservationRecorder
from .output_segment import PendingOutputSegment
from .performance_curve_coordinator import PerformanceCurveCoordinator


class OutputSegmentCoordinator:
    """Own logical output segments without owning Turn lifecycle."""

    def __init__(
        self,
        *,
        runtime_state: ModelInfoRuntimeContext,
        media_service: Any,
        chat_buffer: Any,
        speaker_name: str,
        send_json: Callable[[dict[str, Any]], Awaitable[bool]],
        performance_curves: PerformanceCurveCoordinator,
        observations: MotionObservationRecorder,
        is_turn_terminal: Callable[[str], bool],
        is_official_inline_anim_compat_enabled: Callable[[], bool],
        finish_turn: Callable[..., Awaitable[None]],
        mark_turn_timing: Callable[[str, str], None],
    ) -> None:
        self.runtime_state = runtime_state
        self.media_service = media_service
        self.chat_buffer = chat_buffer
        self.speaker_name = speaker_name
        self._send_json = send_json
        self.performance_curves = performance_curves
        self.observations = observations
        self._is_turn_terminal = is_turn_terminal
        self._is_official_inline_anim_compat_enabled = (
            is_official_inline_anim_compat_enabled
        )
        self._finish_turn = finish_turn
        self._mark_turn_timing = mark_turn_timing
        self._pending_segments: dict[str, PendingOutputSegment] = {}
        self._segment_sequences: dict[str, dict[int, str]] = {}
        self._next_sequence_by_turn: dict[str, int] = {}
        self._flushed_segment_keys: set[str] = set()
        self._turn_locks: dict[str, asyncio.Lock] = {}
        self._closing_turn_ids: set[str] = set()
        self._closed_turn_ids: set[str] = set()
        self._emitted_turn_ids: set[str] = set()

    def reset(self) -> None:
        self._pending_segments.clear()
        self._segment_sequences.clear()
        self._next_sequence_by_turn.clear()
        self._flushed_segment_keys.clear()
        self._turn_locks.clear()
        self._closing_turn_ids.clear()
        self._closed_turn_ids.clear()
        self._emitted_turn_ids.clear()

    def tracked_turn_ids(self) -> set[str]:
        return (
            set(self._closing_turn_ids)
            | set(self._closed_turn_ids)
            | set(self._emitted_turn_ids)
            | {segment.turn_id for segment in self._pending_segments.values()}
        )

    def clear_turn(self, turn_id: str) -> None:
        prefix = f"{turn_id}|"
        for key in tuple(self._pending_segments):
            if key.startswith(prefix):
                self._pending_segments.pop(key, None)
        flushed_keys_for_turn = tuple(
            key for key in self._flushed_segment_keys if key.startswith(prefix)
        )
        self._flushed_segment_keys.difference_update(flushed_keys_for_turn)
        self._segment_sequences.pop(turn_id, None)
        self._next_sequence_by_turn.pop(turn_id, None)
        self._turn_locks.pop(turn_id, None)
        self._closing_turn_ids.discard(turn_id)
        self._closed_turn_ids.discard(turn_id)
        self._emitted_turn_ids.discard(turn_id)

    async def emit_message_chain(
        self,
        message_chain: Any,
        *,
        turn_id: str,
        unified_msg_origin: str | None = None,
        raw_reply_text_override: str | None = None,
        platform_extras: dict[str, Any] | None = None,
    ) -> None:
        del unified_msg_origin

        normalized_turn_id = _require_turn_id_value(turn_id)
        extras = platform_extras if isinstance(platform_extras, dict) else {}
        segment_message_id = resolve_platform_segment_message_id(extras)
        async with self._get_turn_lock(normalized_turn_id):
            self._require_output_queue_open(normalized_turn_id)
            key = self._segment_key(normalized_turn_id, segment_message_id)
            if key in self._flushed_segment_keys:
                logger.info(
                    "WIRING output_segment_duplicate_ignored turn_id=%s message_id=%s",
                    normalized_turn_id,
                    segment_message_id,
                )
                return
            segment_sequence = _require_segment_sequence(
                extras.get("logical_segment_index")
            )
            self._register_segment_sequence(
                turn_id=normalized_turn_id,
                message_id=segment_message_id,
                sequence=segment_sequence,
            )
            self._mark_turn_timing(normalized_turn_id, "emit_started_at")
            texts, picture_paths, record_paths, record_texts = extract_outbound_message_parts(
                message_chain
            )
            logger.info(
                "WIRING output_parts turn_id=%s message_id=%s text_count=%s "
                "image_count=%s record_count=%s",
                normalized_turn_id,
                segment_message_id,
                len(texts),
                len(picture_paths),
                len(record_paths),
            )
            raw_reply_text = (
                str(raw_reply_text_override or "").strip()
                or "\n".join(texts).strip()
            )
            record_text = sanitize_assistant_output_text("\n".join(record_texts).strip())
            reply_text = sanitize_assistant_output_text("\n".join(texts).strip())
            semantic_text = str(extras.get("semantic_text") or "").strip()
            canonical_text = _resolve_canonical_assistant_text(
                semantic_text=semantic_text,
                plain_text=reply_text,
                record_text=record_text,
                raw_reply_text=raw_reply_text,
            )
            segment = self._get_pending_segment(normalized_turn_id, segment_message_id)
            segment.merge_sequence(segment_sequence)
            segment.merge_text(canonical_text)
            segment.merge_semantic_text(canonical_text)
            segment.merge_images(picture_paths)
            if len(record_paths) > 1:
                raise ValueError(
                    f"output_segment_multiple_audio_files:{segment_message_id}"
                )
            tts_state, audio_attachment = _extract_platform_tts_delivery_state(
                extras,
                expected_turn_id=normalized_turn_id,
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
                if self.performance_curves.owns_request(
                    turn_id=normalized_turn_id,
                    request_id=tts_state["request_id"],
                ):
                    segment.bind_performance_curve_request(tts_state["request_id"])

            if "ag99live_speech_cues" in extras:
                segment.merge_speech_cues(extras.get("ag99live_speech_cues"))

            motion_candidate, motion_resolution_failure = self._resolve_motion(
                platform_extras=extras,
                raw_reply_text=raw_reply_text,
            )
            motion_expected, motion_failure_reason = _resolve_motion_schedule(extras)
            if motion_expected:
                segment.require_motion()
            if motion_resolution_failure:
                segment.merge_motion_failure(motion_resolution_failure)
            elif motion_failure_reason:
                segment.merge_motion_failure(motion_failure_reason)
            if motion_candidate is not None:
                segment.merge_motion(**motion_candidate)

    async def finalize_output_segment(self, *, turn_id: str, message_id: str) -> None:
        """Publish a completed logical message without closing its Turn."""
        normalized_turn_id = _require_turn_id_value(turn_id)
        normalized_message_id = _require_message_id_value(message_id)
        async with self._get_turn_lock(normalized_turn_id):
            self._require_output_queue_open(normalized_turn_id)
            key = self._segment_key(normalized_turn_id, normalized_message_id)
            if key in self._flushed_segment_keys:
                return
            segment = self._pending_segments.get(key)
            if segment is None:
                raise ValueError(
                    f"output_segment_missing:{normalized_turn_id}:{normalized_message_id}"
                )
            segment.finalize()
            await self._flush_finalized_segments_in_order(normalized_turn_id)

    async def close_turn_output_queue(self, *, turn_id: str) -> None:
        normalized_turn_id = _require_turn_id_value(turn_id)
        async with self._get_turn_lock(normalized_turn_id):
            if normalized_turn_id in self._closed_turn_ids:
                return
            if normalized_turn_id in self._closing_turn_ids:
                return
            self._closing_turn_ids.add(normalized_turn_id)
            try:
                pending_segment = self._first_pending_segment(normalized_turn_id)
                if pending_segment is not None:
                    reason = (
                        "output_segment_not_finalized:"
                        f"{normalized_turn_id}:{pending_segment.message_id}"
                    )
                    error_sent = await self._send_json(
                        build_control_error(turn_id=normalized_turn_id, message=reason)
                    )
                    if not error_sent:
                        raise RuntimeError(f"control_error_send_failed:{normalized_turn_id}")
                    await self._finish_turn(
                        turn_id=normalized_turn_id,
                        success=False,
                        reason=reason,
                    )
                    return
                if normalized_turn_id not in self._emitted_turn_ids:
                    reason = f"output_segment_missing:{normalized_turn_id}"
                    error_sent = await self._send_json(
                        build_control_error(turn_id=normalized_turn_id, message=reason)
                    )
                    if not error_sent:
                        raise RuntimeError(
                            f"control_error_send_failed:{normalized_turn_id}"
                        )
                    await self._finish_turn(
                        turn_id=normalized_turn_id,
                        success=False,
                        reason=reason,
                    )
                    return
                sent = await self._send_json(
                    build_control_synth_finished(turn_id=normalized_turn_id)
                )
                if not sent:
                    raise RuntimeError(f"synth_finished_send_failed:{normalized_turn_id}")
                self._closed_turn_ids.add(normalized_turn_id)
                try:
                    self.performance_curves.cancel_turn(normalized_turn_id)
                except Exception:  # noqa: BLE001 - optional cleanup must not reopen output.
                    logger.exception(
                        "Failed to cancel performance curve after output closure: turn_id=%s",
                        normalized_turn_id,
                    )
            finally:
                self._closing_turn_ids.discard(normalized_turn_id)

    def _get_pending_segment(self, turn_id: str, message_id: str) -> PendingOutputSegment:
        key = f"{turn_id}|{message_id}"
        segment = self._pending_segments.get(key)
        if segment is None:
            segment = PendingOutputSegment(turn_id=turn_id, message_id=message_id)
            self._pending_segments[key] = segment
        return segment

    def _require_output_queue_open(self, turn_id: str) -> None:
        if (
            turn_id in self._closing_turn_ids
            or turn_id in self._closed_turn_ids
            or self._is_turn_terminal(turn_id)
        ):
            raise RuntimeError(f"output_segment_queue_closed:{turn_id}")

    def _resolve_motion(
        self,
        *,
        platform_extras: dict[str, Any],
        raw_reply_text: str,
    ) -> tuple[dict[str, Any] | None, str]:
        candidates = iter_platform_motion_client_objects(platform_extras)
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
            return {
                "payload": payload,
                "mode": str(motion_object.get("mode") or "preview"),
                "source": str(motion_object.get("source") or "platform_extras"),
            }, ""

        if not self._is_official_inline_anim_compat_enabled():
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
            return None, f"official_inline_anim_compat_rejected:{validation_reason}"
        return {
            "payload": payload,
            "mode": "preview",
            "source": "official_inline_anim_compat",
        }, ""

    async def _flush_segment(self, segment: PendingOutputSegment) -> None:
        if segment.sequence is None:
            raise RuntimeError(f"output_segment_sequence_missing:{segment.message_id}")
        audio_slot: dict[str, Any] = {"state": "absent"}
        if segment.audio_path:
            _, audio_url = await asyncio.to_thread(
                self.media_service.cache_audio_file,
                segment.audio_path,
            )
            audio_slot = {"state": "present", "url": audio_url}

        motion_slot = self._build_motion_slot(segment)
        speech_slot = (
            {"state": "present", "cues": segment.speech_cues}
            if segment.speech_cues
            else {"state": "absent"}
        )
        if segment.audio_failure_reason:
            audio_slot = {"state": "failed", "reason": segment.audio_failure_reason}
        text_slot = (
            {"state": "present", "content": segment.text}
            if segment.text
            else {"state": "absent"}
        )
        sent = await self._send_json(
            build_output_segment(
                turn_id=segment.turn_id,
                message_id=segment.message_id,
                sequence=segment.sequence,
                text=text_slot,
                audio=audio_slot,
                motion=motion_slot,
                speech=speech_slot,
                images=segment.images,
                speaker_name=self.speaker_name,
                avatar="",
            )
        )
        if not sent:
            raise RuntimeError(f"output_segment_send_failed:{segment.message_id}")

        key = self._segment_key(segment.turn_id, segment.message_id)
        self._pending_segments.pop(key, None)
        self._flushed_segment_keys.add(key)
        self._emitted_turn_ids.add(segment.turn_id)

        self.performance_curves.commit_output_side_effects(segment, motion_slot)
        self.observations.record_motion_slot(motion_slot, source=segment.motion_source)
        if segment.text:
            self.chat_buffer.add("assistant", segment.text)
        self.observations.record_motion_lab_raw_event(
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
                "chat_context": self.observations.motion_lab_chat_context(),
            },
        )
        if audio_slot["state"] == "present":
            self._mark_turn_timing(segment.turn_id, "audio_payload_sent_at")

    async def _flush_finalized_segments_in_order(self, turn_id: str) -> None:
        next_sequence = self._next_sequence_by_turn.setdefault(turn_id, 0)
        while True:
            message_id = self._segment_sequences.get(turn_id, {}).get(next_sequence)
            if message_id is None:
                return
            segment = self._pending_segments.get(self._segment_key(turn_id, message_id))
            if segment is None:
                raise RuntimeError(
                    f"output_segment_sequence_state_missing:{turn_id}:{next_sequence}"
                )
            if not segment.finalized:
                return
            await self._flush_segment(segment)
            next_sequence += 1
            self._next_sequence_by_turn[turn_id] = next_sequence

    def _register_segment_sequence(
        self,
        *,
        turn_id: str,
        message_id: str,
        sequence: int,
    ) -> None:
        sequences = self._segment_sequences.setdefault(turn_id, {})
        existing_message_id = sequences.get(sequence)
        if existing_message_id is not None and existing_message_id != message_id:
            raise ValueError(
                f"output_segment_sequence_conflict:{turn_id}:{sequence}"
            )
        sequences[sequence] = message_id

    def _get_turn_lock(self, turn_id: str) -> asyncio.Lock:
        return self._turn_locks.setdefault(turn_id, asyncio.Lock())

    @staticmethod
    def _segment_key(turn_id: str, message_id: str) -> str:
        return f"{turn_id}|{message_id}"

    def _first_pending_segment(self, turn_id: str) -> PendingOutputSegment | None:
        return next(
            (
                segment
                for segment in self._pending_segments.values()
                if segment.turn_id == turn_id
            ),
            None,
        )
    def _build_motion_slot(self, segment: PendingOutputSegment) -> dict[str, Any]:
        if segment.motion_payload is None:
            if segment.motion_failure_reason:
                return {"state": "failed", "reason": segment.motion_failure_reason}
            if segment.motion_expected:
                return {"state": "failed", "reason": "motion_schedule_payload_missing"}
            return {"state": "absent"}
        payload = segment.motion_payload
        if resolve_motion_payload_schema_version(payload) == MOTION_INTENT_V4_SCHEMA_VERSION:
            payload = normalize_motion_intent_payload(payload)
        message_type = resolve_engine_motion_message_type(payload)
        if message_type != TYPE_ENGINE_MOTION_INTENT:
            raise ValueError("output_segment_motion_type_invalid")
        payload = self.performance_curves.attach_ready_hint(
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


def _require_segment_sequence(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("output_segment_sequence_missing_or_invalid")
    return value


def _require_turn_id_value(turn_id: str | None) -> str:
    normalized = str(turn_id or "").strip()
    if not normalized:
        raise ValueError("Interactive protocol messages require a non-empty turn_id.")
    return normalized


def _require_message_id_value(message_id: str | None) -> str:
    normalized = str(message_id or "").strip()
    if not normalized:
        raise ValueError("Output segments require a non-empty message_id.")
    return normalized


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
    return {
        "request_id": str(tts.get("tts_request_id") or "").strip(),
        "status": str(tts.get("status") or "").strip(),
        "failure_code": str(tts.get("failure_code") or "").strip(),
    }, audio_attachment


def _resolve_motion_schedule(platform_extras: dict[str, Any]) -> tuple[bool, str]:
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
    resolution_reason = str(schedule.get("motion_resolution_reason") or "").strip()
    if scheduled:
        if not source:
            return True, "motion_schedule_source_missing"
        return True, ""
    if reason == "motion_payload_missing":
        return True, f"motion_schedule_failed:{resolution_reason or reason}"
    return False, ""
