"""Optional performance-curve lifecycle for output segments."""

from __future__ import annotations

from typing import Any

from astrbot.api import logger

from ..motion.performance_curve import (
    PerformanceCurveInput,
    attach_performance_curve_hint,
    extract_assistant_reply_keywords,
    summarize_motion_for_curve,
)
from ..protocol.schema_versions import PERFORMANCE_CURVE_HINT_SCHEMA_VERSION


class PerformanceCurveCoordinator:
    """Manage optional curve work without owning output or turn lifecycle."""

    def __init__(self, *, runtime_state: Any, observations: Any) -> None:
        self.runtime_state = runtime_state
        self.observations = observations

    def cancel_turn(self, turn_id: str | None) -> None:
        runtime = getattr(self.runtime_state, "performance_curve_runtime", None)
        cancel_turn = getattr(runtime, "cancel_turn", None)
        if callable(cancel_turn):
            cancel_turn(turn_id)

    def owns_request(self, *, turn_id: str | None, request_id: str | None) -> bool:
        runtime = getattr(self.runtime_state, "performance_curve_runtime", None)
        owns_request = getattr(runtime, "owns_request", None)
        return bool(
            callable(owns_request)
            and owns_request(turn_id=turn_id, request_id=request_id)
        )

    def cancel_turns(self, turn_ids: set[str]) -> list[str]:
        failures: list[str] = []
        for turn_id in turn_ids:
            try:
                self.cancel_turn(turn_id)
            except Exception:  # noqa: BLE001 - cleanup continues for every turn.
                failures.append(f"{turn_id}:curve_cancel_failed")
                logger.exception(
                    "Failed to cancel performance curve: turn_id=%s",
                    turn_id,
                )
        return failures

    def start_request(
        self,
        *,
        turn_id: str | None,
        tts_turn_id: str | None,
        message_id: str | None,
        request_id: str | None,
        assistant_text: str,
        motion_payload: Any,
    ) -> str | None:
        if not self.runtime_state.enable_performance_curve:
            return None

        normalized_turn_id = str(turn_id or "").strip()
        normalized_tts_turn_id = str(tts_turn_id or "").strip()
        normalized_message_id = str(message_id or "").strip()
        normalized_request_id = str(request_id or "").strip()
        normalized_assistant_text = str(assistant_text or "").strip()
        runtime = getattr(self.runtime_state, "performance_curve_runtime", None)
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
            self.record_outcome(
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
            request = PerformanceCurveInput(
                turn_id=normalized_turn_id,
                tts_turn_id=normalized_tts_turn_id,
                message_id=normalized_message_id,
                request_id=normalized_request_id,
                assistant_text=normalized_assistant_text,
                assistant_reply_keywords=extract_assistant_reply_keywords(
                    normalized_assistant_text
                ),
                motion_intent_tags=[
                    str(item).strip()
                    for item in motion_summary.get("intent_tags", [])
                    if str(item).strip()
                ],
                motion_effect_summary=motion_summary,
                chat_context=self.observations.motion_lab_chat_context(),
            )
            if runtime.start(request):
                return normalized_request_id
        except Exception as exc:  # noqa: BLE001 - optional curve cannot block output.
            logger.exception(
                "Performance curve request start failed: turn_id=%s request_id=%s",
                normalized_turn_id,
                normalized_request_id,
            )
            self.record_outcome(
                event_type="performance_curve.failed",
                reason=f"start_exception:{exc}",
                turn_id=normalized_turn_id,
                message_id=normalized_message_id,
                assistant_text=normalized_assistant_text,
                tts_turn_id=normalized_tts_turn_id,
                request_id=normalized_request_id,
            )
            return None

        self.record_outcome(
            event_type="performance_curve.skipped",
            reason="request_rejected",
            turn_id=normalized_turn_id,
            message_id=normalized_message_id,
            assistant_text=normalized_assistant_text,
            tts_turn_id=normalized_tts_turn_id,
            request_id=normalized_request_id,
        )
        return None

    def attach_ready_hint(
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
        normalized_turn_id = str(turn_id or "").strip()
        if runtime is None:
            self.record_outcome(
                event_type="performance_curve.skipped",
                reason="runtime_unavailable_before_egress",
                turn_id=normalized_turn_id,
                message_id=message_id,
                assistant_text="",
                tts_turn_id="",
                request_id=normalized_request_id,
            )
            return motion_payload
        try:
            hint = runtime.get_ready(
                turn_id=turn_id,
                request_id=normalized_request_id,
            )
        except Exception as exc:  # noqa: BLE001 - optional curve cannot block output.
            logger.exception(
                "Performance curve result lookup failed: turn_id=%s request_id=%s",
                turn_id,
                normalized_request_id,
            )
            self.record_outcome(
                event_type="performance_curve.failed",
                reason=f"result_lookup_exception:{exc}",
                turn_id=normalized_turn_id,
                message_id=message_id,
                assistant_text="",
                tts_turn_id="",
                request_id=normalized_request_id,
            )
            return motion_payload
        if not isinstance(hint, dict):
            return motion_payload

        try:
            next_payload, attached_hint = attach_performance_curve_hint(
                motion_payload,
                hint,
            )
            if attached_hint is None:
                raise ValueError("performance_curve_runtime_hint_invalid")
            return next_payload
        except Exception as exc:  # noqa: BLE001 - optional curve cannot block output.
            logger.exception(
                "Performance curve hint attachment failed: turn_id=%s request_id=%s",
                turn_id,
                normalized_request_id,
            )
            self.record_outcome(
                event_type="performance_curve.failed",
                reason=f"hint_invalid:{exc}",
                turn_id=normalized_turn_id,
                message_id=message_id,
                assistant_text="",
                tts_turn_id="",
                request_id=normalized_request_id,
            )
            return motion_payload

    def commit_output_side_effects(self, segment: Any, motion_slot: dict[str, Any]) -> None:
        payload = motion_slot.get("payload")
        if not isinstance(payload, dict):
            return

        request_id = str(segment.performance_curve_request_id or "").strip()
        if not request_id:
            return
        hint = payload.get("performance_curve_hint")
        runtime = getattr(self.runtime_state, "performance_curve_runtime", None)
        try:
            if isinstance(hint, dict):
                self.observations.record_motion_lab_raw_event(
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
            elif runtime is not None and runtime.discard_if_not_ready(
                turn_id=segment.turn_id,
                request_id=request_id,
            ):
                self.observations.record_motion_lab_raw_event(
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
        except Exception as exc:  # noqa: BLE001 - optional curve cannot block closure.
            logger.exception(
                "Performance curve output side effect failed: turn_id=%s request_id=%s",
                segment.turn_id,
                request_id,
            )
            self.record_outcome(
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
                    logger.exception(
                        "Performance curve request cleanup failed: turn_id=%s request_id=%s",
                        segment.turn_id,
                        request_id,
                    )
                    self.record_outcome(
                        event_type="performance_curve.failed",
                        reason=f"clear_exception:{exc}",
                        turn_id=segment.turn_id,
                        message_id=segment.message_id,
                        assistant_text=segment.semantic_text,
                        tts_turn_id="",
                        request_id=request_id,
                    )

    def record_outcome(
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
        self.observations.record_motion_lab_raw_event(
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
