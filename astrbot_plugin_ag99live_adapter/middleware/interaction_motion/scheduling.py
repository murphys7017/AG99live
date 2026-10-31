from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from astrbot.api import logger

from ...core_compatibility import get_interaction_capabilities
from ...motion.observation import (
    record_persona_motion_sample,
    resolve_persona_delivery_mode,
    resolve_persona_motion_source_route,
)
from ...motion.output_sanitizer import (
    contains_hidden_output_markup,
    sanitize_assistant_output_segment_text,
    sanitize_assistant_output_text,
)
from ...runtime.persona_lifecycle import (
    PersonaResultState,
    PersonaSegmentIdentity,
    PersonaTtsBinding,
    PersonaTurnIdentity,
)
from ...runtime.adapter_event_context import resolve_adapter_event_context
from .effects import (
    _effect_call_get,
    _extract_ag99live_motion_effect_arguments,
    _extract_effect_calls_for_motion,
    _persona_segment_count,
    _resolve_persona_effect_motion_payload_with_reason,
)
from .independent import IndependentMotionResult
from .shared import (
    AG99LIVE_MOTION_EFFECT_NAME,
    INTERACTION_ROUTE_DECISION_EXTRA_KEY,
    _append_resolution_reason,
    _call_event_method,
    _FrontendIdentitySnapshot,
    _MotionRuntimeBundle,
    _normalize_optional_string,
    _resolve_frontend_identity_snapshot,
    _resolve_motion_runtime_bundle,
    _resolve_result_phase,
    _thaw_snapshot_value,
)


@dataclass(slots=True)
class _InteractionReplyPlanSnapshot:
    route_mode: str | None
    should_emit_immediate_reply: bool | None
    source: str


@dataclass(slots=True)
class _MotionSchedulePolicy:
    should_schedule: bool
    source: str | None
    reason: str


@dataclass(slots=True)
class _MotionScheduleAttempt:
    phase: str
    source: str | None
    scheduled_frontend_turn_id: str | None
    event_frontend_turn_id: str | None
    reply_plan_route_mode: str | None
    reply_plan_should_emit_immediate_reply: bool | None
    reply_plan_source: str | None
    scheduled: bool
    reason: str
    assistant_text: str
    motion_payload: dict[str, Any] | None = None
    motion_payloads_by_segment: dict[int, dict[str, Any]] | None = None
    persona_segment_count: int | None = None
    motion_resolution_reason: str | None = None

    def to_metadata(self) -> dict[str, Any]:
        metadata = {
            "phase": self.phase,
            "source": self.source,
            "scheduled_frontend_turn_id": self.scheduled_frontend_turn_id,
            "event_frontend_turn_id": self.event_frontend_turn_id,
            "reply_plan_route_mode": self.reply_plan_route_mode,
            "reply_plan_should_emit_immediate_reply": self.reply_plan_should_emit_immediate_reply,
            "reply_plan_source": self.reply_plan_source,
            "scheduled": self.scheduled,
            "reason": self.reason,
        }
        if self.motion_resolution_reason:
            metadata["motion_resolution_reason"] = self.motion_resolution_reason
        if self.persona_segment_count is not None:
            metadata["persona_segment_count"] = self.persona_segment_count
            if self.motion_payloads_by_segment is not None or self.reason == "motion_payload_missing":
                metadata["persona_segmented"] = True
        if self.motion_payloads_by_segment is not None:
            metadata["persona_motion_segment_indexes"] = sorted(
                self.motion_payloads_by_segment
            )
        return metadata


def _build_persona_segment_motion_schedule(
    *,
    segment_count: int,
    motion_resolution_reason: str | None = None,
    failure_reasons: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Build the shared schedule metadata for segmented Provider output."""
    metadata: dict[str, Any] = {
        "scheduled": True,
        "source": "independent_provider",
        "persona_segmented": True,
        "persona_segment_count": segment_count,
    }
    normalized_reason = str(motion_resolution_reason or "").strip()
    if normalized_reason:
        metadata["motion_resolution_reason"] = normalized_reason
    if failure_reasons:
        metadata["persona_motion_failure_reasons"] = dict(failure_reasons)
    return metadata


def _build_result_contribution_metadata(
    *,
    attempt: _MotionScheduleAttempt | None,
    deferred_work: PersonaResultState | None,
    persona_result_id: str,
    persona_segment_count: int,
) -> dict[str, Any]:
    if attempt is not None:
        return {"ag99live_motion_schedule": attempt.to_metadata()}
    if deferred_work is None:
        return {}
    return {
        "ag99live_motion_generation_deferred": True,
        "persona_result_id": persona_result_id,
        "ag99live_motion_schedule": _build_persona_segment_motion_schedule(
            segment_count=(
                deferred_work.expected_segment_count or persona_segment_count
            ),
            motion_resolution_reason="motion_finalization_incomplete",
        ),
    }


def _resolve_hidden_markup_text_override(
    event: Any,
    view: Any,
    *,
    raw_assistant_text: str,
    persona_speech_segments: tuple[str, ...],
) -> str | None:
    if not raw_assistant_text or not contains_hidden_output_markup(raw_assistant_text):
        return None

    resolve_adapter_event_context(event).set_raw_reply_text(event, raw_assistant_text)
    raw_segments = _extract_raw_persona_speech_segments(view)
    if not raw_segments:
        return sanitize_assistant_output_text(raw_assistant_text)
    if "".join(raw_segments).strip() != raw_assistant_text:
        logger.warning(
            "WIRING persona_speech_sanitization_skipped "
            "reason=segment_text_mismatch segment_count=%s",
            len(persona_speech_segments),
        )
        return None
    return "".join(persona_speech_segments)


def _collect_persona_motion_failure_reasons(
    results_by_index: Any,
    speech_segments: tuple[str, ...],
    *,
    incremental: bool,
    segment_index: int | None,
) -> dict[str, str]:
    expected_indexes = (
        [segment_index]
        if incremental and segment_index is not None
        else [
            index
            for index, speech in enumerate(speech_segments)
            if speech.strip()
        ]
    )
    failures: dict[str, str] = {}
    for index in expected_indexes:
        result = (
            results_by_index.get(index)
            if isinstance(results_by_index, dict)
            else None
        )
        if not isinstance(result, IndependentMotionResult):
            failures[str(index)] = "motion_result_unavailable"
        elif result.motion_payload is None:
            failures[str(index)] = result.reason or "motion_payload_missing"
    return failures


def _persona_tts_binding_failure_reason(
    binding: PersonaTtsBinding | None,
    *,
    turn_id: str,
    parent_message_id: str,
    persona_result_id: str,
    segment_index: int,
    segment_count: int,
) -> str | None:
    if binding is None:
        return "tts_binding_missing"
    identity = binding.identity
    if (
        identity.turn.turn_id != str(turn_id or "").strip()
        or binding.parent_message_id != str(parent_message_id or "").strip()
        or identity.persona_result_id != str(persona_result_id or "").strip()
        or identity.segment_index != segment_index
        or identity.segment_count != segment_count
        or not str(identity.segment_message_id or "").strip()
        or not binding.tts_request_id.strip()
    ):
        return "tts_binding_identity_mismatch"
    return None


class AG99liveMotionResultContributor:
    plugin_id = "ag99live.motion.result"
    priority = 40

    async def collect(self, event, plugin_context, view):
        del plugin_context
        capabilities = get_interaction_capabilities()
        if capabilities is None:
            return None
        event_context = resolve_adapter_event_context(event)
        event_context.set_pending_performance_curve(event, None)
        event_context.set_raw_reply_text(event, None)
        bundle = _resolve_motion_runtime_bundle(event)
        persona_result_id = str(
            (
                getattr(view, "metadata", {}).get("persona_result_id")
                if isinstance(getattr(view, "metadata", None), Mapping)
                else ""
            )
            or ""
        ).strip()
        turn_id = str(
            getattr(view, "turn_id", None)
            or event_context.core_turn_id
            or ""
        ).strip()
        deferred_work = (
            bundle.runtime_state.persona_sessions.get_result(
                PersonaTurnIdentity(turn_id),
                persona_result_id,
            )
            if bundle is not None and turn_id and persona_result_id
            else None
        )
        source_route = (
            resolve_persona_motion_source_route(
                event,
                bundle.runtime_state,
                capture_if_missing=True,
            )
            if bundle is not None
            else None
        )
        if deferred_work is not None:
            deferred_work.view = view
            output_draft = getattr(view, "output_draft", None)
            if isinstance(output_draft, Mapping):
                candidate_message_id = str(
                    output_draft.get("message_id") or ""
                ).strip()
                if candidate_message_id:
                    deferred_work.set_parent_message_id(candidate_message_id)
            attempt = None
        else:
            attempt = await _schedule_motion_from_interaction_result(event, view)
        logger.debug(
            "WIRING motion.contributor phase=%s independent_enabled=%s "
            "attempt_present=%s",
            _resolve_result_phase(view),
            source_route == "independent_motion",
            attempt is not None,
        )
        if attempt is None and deferred_work is None:
            return None

        persona_speech_segments = _extract_persona_speech_segments(view)
        persona_segment_count = len(persona_speech_segments)
        empty_persona_speech_indexes = [
            segment_index
            for segment_index, speech in enumerate(persona_speech_segments)
            if not speech.strip()
        ]
        if persona_speech_segments and not any(
            speech.strip() for speech in persona_speech_segments
        ):
            logger.debug(
                "WIRING persona_tts_segment_tracking_skipped "
                "reason=no_nonempty_speech_segments count=%s",
                persona_segment_count,
            )

        client_objects = []
        raw_assistant_text = _extract_raw_assistant_text(view)
        final_text_override = _resolve_hidden_markup_text_override(
            event,
            view,
            raw_assistant_text=raw_assistant_text,
            persona_speech_segments=tuple(persona_speech_segments),
        )
        if attempt is not None and attempt.motion_payloads_by_segment is not None:
            for segment_index, motion_payload in sorted(
                attempt.motion_payloads_by_segment.items()
            ):
                client_objects.append(
                    {
                        "type": "ag99live.motion_payload",
                        "motion_payload": motion_payload,
                        "mode": "preview",
                        "source": attempt.source or "persona_effect",
                        "persona_segment_index": segment_index,
                        "persona_segment_count": attempt.persona_segment_count,
                    }
                )
        elif attempt is not None and attempt.motion_payload is not None:
            client_objects.append(
                {
                    "type": "ag99live.motion_payload",
                    "motion_payload": attempt.motion_payload,
                    "mode": "preview",
                    "source": attempt.source or "persona_effect",
                }
            )
            _defer_optional_performance_curve_request(event, attempt=attempt)
        logger.debug(
            "WIRING motion.contributor_result phase=%s "
            "scheduled=%s payload_present=%s source=%s reason=%s "
            "client_object_count=%s",
            attempt.phase if attempt is not None else _resolve_result_phase(view),
            attempt.scheduled if attempt is not None else False,
            bool(
                attempt is not None
                and (
                    attempt.motion_payload is not None
                    or attempt.motion_payloads_by_segment is not None
                )
            ),
            attempt.source if attempt is not None else "<none>",
            attempt.reason if attempt is not None else "<none>",
            len(client_objects),
        )
        platform_extras = {}
        if persona_speech_segments:
            platform_extras["persona_speech_segments"] = persona_speech_segments
            if empty_persona_speech_indexes:
                platform_extras["persona_speech_empty_indexes"] = (
                    empty_persona_speech_indexes
                )
        contribution = capabilities.interaction_result_contribution(
            plugin_id=self.plugin_id,
            platform_extras=platform_extras,
            final_text_override=final_text_override,
            client_objects=client_objects,
            metadata=_build_result_contribution_metadata(
                attempt=attempt,
                deferred_work=deferred_work,
                persona_result_id=persona_result_id,
                persona_segment_count=persona_segment_count,
            ),
            priority=self.priority,
        )
        if deferred_work is not None:
            contribution.supports_segment_materialization = True
            finalizers = getattr(contribution, "post_materialization", None)
            if isinstance(finalizers, list):
                finalizers.append(self.finalize_output)
                timeout_seconds = _persona_motion_finalization_timeout(
                    bundle.runtime_state if bundle is not None else None,
                    persona_speech_segments,
                )
                if hasattr(contribution, "post_materialization_timeout_seconds"):
                    contribution.post_materialization_timeout_seconds = timeout_seconds
            else:
                logger.warning(
                    "WIRING independent_motion.finalization_unavailable "
                    "reason=core_post_materialization_hook_missing "
                    "persona_result_id=%s",
                    persona_result_id,
                )
        return contribution

    async def finalize_output(
        self,
        event,
        plugin_context,
        *,
        turn_id: str,
        phase: str,
        parent_message_id: str,
        persona_result_id: str | None,
        materialization: Mapping[str, Any],
        defer_motion: bool = True,
    ):
        del plugin_context
        normalized_result_id = str(persona_result_id or "").strip()
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_result_id or not normalized_turn_id:
            return None
        bundle = _resolve_motion_runtime_bundle(event)
        if bundle is None:
            return None
        sessions = bundle.runtime_state.persona_sessions
        work = sessions.get_result(
            PersonaTurnIdentity(normalized_turn_id), normalized_result_id
        )
        if work is None:
            return None
        if (
            work.turn.turn_id != normalized_turn_id
            or work.phase != str(phase or "").strip()
            or work.parent_message_id != str(parent_message_id or "").strip()
        ):
            logger.warning(
                "WIRING independent_motion.finalization_rejected "
                "reason=persona_result_identity_mismatch turn_id=%s "
                "persona_result_id=%s phase=%s",
                turn_id or "<missing>",
                normalized_result_id,
                phase or "<missing>",
            )
            return None
        segment_index = materialization.get("persona_segment_index")
        incremental = isinstance(segment_index, int) and not isinstance(segment_index, bool)
        last_segment = bool(materialization.get("persona_last_output_segment"))
        if incremental and defer_motion:
            segment_state = work.segments.get(segment_index)
            future = segment_state.result_future if segment_state is not None else None
            binding = segment_state.tts_binding if segment_state is not None else None
            identity = _resolve_frontend_identity_snapshot(event)
            tts_items = materialization.get("tts") or []
            tts_ready = bool(tts_items) and not tts_items[0].get("tts_failed")
            if (
                future is not None and not future.done() and tts_ready
                and identity.event_frontend_turn_id
                and _persona_tts_binding_failure_reason(
                    binding, turn_id=turn_id, parent_message_id=parent_message_id,
                    persona_result_id=normalized_result_id, segment_index=segment_index,
                    segment_count=work.expected_segment_count or len(work.segments),
                ) is None
            ):
                async def resolve_late_motion():
                    contribution = await self.finalize_output(
                        event, None, turn_id=turn_id, phase=phase,
                        parent_message_id=parent_message_id, persona_result_id=persona_result_id,
                        materialization=materialization, defer_motion=False,
                    )
                    objects = getattr(contribution, "client_objects", ())
                    for obj in objects:
                        if obj.get("persona_segment_index") == segment_index:
                            from ...runtime.output_segment import PendingOutputSegment
                            segment = PendingOutputSegment(
                                turn_id=identity.event_frontend_turn_id,
                                message_id=binding.identity.segment_message_id or "",
                                tts_request_id=binding.tts_request_id,
                                semantic_text=str(tts_items[0].get("tts_source_text") or ""),
                            )
                            segment.merge_motion(
                                payload=obj["motion_payload"], mode=obj.get("mode", "preview"),
                                source=obj.get("source", "independent_provider"),
                            )
                            outputs = bundle.turn_coordinator.output_segments
                            if outputs.performance_curves.owns_request(
                                turn_id=segment.turn_id, request_id=segment.tts_request_id,
                            ):
                                segment.bind_performance_curve_request(segment.tts_request_id)
                            slot = outputs.build_motion_slot(segment)
                            outputs.performance_curves.commit_output_side_effects(segment, slot)
                            outputs.observations.record_motion_slot(slot, source=segment.motion_source)
                            return slot
                    return {"state": "failed", "reason": "deferred_motion_payload_unavailable"}

                registered = bundle.turn_coordinator.output_segments.deferred_motion.register(
                    identity.event_frontend_turn_id,
                    binding.identity.segment_message_id or "",
                    resolve_late_motion,
                    timeout_seconds=_persona_motion_finalization_timeout(
                        bundle.runtime_state,
                        tuple(
                            state.speech or ""
                            for _, state in sorted(work.segments.items())
                        ),
                    ),
                )
                capabilities = get_interaction_capabilities()
                if not registered:
                    segment_count = work.expected_segment_count or len(work.segments)
                    return capabilities.interaction_result_contribution(
                        plugin_id=self.plugin_id, priority=self.priority,
                        metadata={"ag99live_motion_schedule": _build_persona_segment_motion_schedule(
                            segment_count=segment_count,
                            motion_resolution_reason="deferred_motion_capacity_exceeded",
                            failure_reasons={str(segment_index): "deferred_motion_capacity_exceeded"},
                        )},
                    ) if capabilities else None
                return capabilities.interaction_result_contribution(
                    plugin_id=self.plugin_id, priority=self.priority,
                    metadata={"ag99live_motion_schedule": _build_persona_segment_motion_schedule(
                        segment_count=work.expected_segment_count or len(work.segments),
                    )},
                ) if capabilities else None
        try:
            if incremental:
                segment_state = work.segments.get(segment_index)
                future = (
                    segment_state.result_future
                    if segment_state is not None
                    else None
                )
                result = await asyncio.shield(future) if future is not None else None
                results_by_index = {segment_index: result}
            else:
                task = work.generation_task
                if task is None:
                    return None
                results_by_index = await asyncio.shield(task)
        except asyncio.CancelledError:
            if incremental and last_segment:
                sessions.clear_result(
                    PersonaTurnIdentity(normalized_turn_id), normalized_result_id
                )
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "WIRING independent_motion.finalization_failed turn_id=%s "
                "persona_result_id=%s error=%s",
                turn_id,
                normalized_result_id,
                exc,
                exc_info=True,
            )
            results_by_index = {}

        if resolve_adapter_event_context(event).agent_stop_requested:
            logger.debug(
                "WIRING independent_motion.finalization_discarded "
                "reason=turn_terminated turn_id=%s persona_result_id=%s",
                turn_id,
                normalized_result_id,
            )
            results_by_index = {}

        expected_count = work.expected_segment_count or (max(work.segments, default=-1) + 1)
        speech_segments = tuple(
            (work.segments[index].speech or "")
            if index in work.segments
            else ""
            for index in range(expected_count)
        )
        bindings_by_index = {
            index: segment.tts_binding
            for index, segment in work.segments.items()
            if segment.tts_binding is not None
        }
        identity = _resolve_frontend_identity_snapshot(event)
        client_objects: list[dict[str, Any]] = []
        tts_binding_metadata: list[dict[str, Any]] = []
        failure_reasons = _collect_persona_motion_failure_reasons(
            results_by_index,
            speech_segments,
            incremental=incremental,
            segment_index=segment_index,
        )
        if isinstance(results_by_index, dict):
            for segment_index, result in sorted(results_by_index.items()):
                if not isinstance(segment_index, int) or not isinstance(
                    result, IndependentMotionResult
                ):
                    continue
                if segment_index < 0 or segment_index >= len(speech_segments):
                    logger.warning(
                        "WIRING independent_motion.result_rejected "
                        "reason=segment_index_out_of_range turn_id=%s "
                        "persona_result_id=%s segment_index=%s segment_count=%s",
                        turn_id,
                        normalized_result_id,
                        segment_index,
                        len(speech_segments),
                    )
                    continue
                if result.motion_payload is None:
                    continue

                binding = bindings_by_index.get(segment_index)
                binding_failure_reason = _persona_tts_binding_failure_reason(
                    binding,
                    turn_id=turn_id,
                    parent_message_id=parent_message_id,
                    persona_result_id=normalized_result_id,
                    segment_index=segment_index,
                    segment_count=len(speech_segments),
                )
                if binding_failure_reason:
                    failure_reasons[str(segment_index)] = binding_failure_reason
                    logger.warning(
                        "WIRING independent_motion.tts_binding_rejected "
                        "reason=%s turn_id=%s persona_result_id=%s "
                        "segment_index=%s message_id=%s",
                        binding_failure_reason,
                        turn_id,
                        normalized_result_id,
                        segment_index,
                        binding.identity.segment_message_id
                        if binding is not None
                        else "<missing>",
                    )
                    continue

                segment_state = work.segments[segment_index]
                tts_binding_metadata.append(
                    {
                        "persona_segment_index": segment_index,
                        "turn_id": turn_id,
                        "parent_message_id": parent_message_id,
                        "message_id": binding.identity.segment_message_id,
                        "tts_request_id": binding.tts_request_id,
                    }
                )
                start_deferred_performance_curve_request(
                    event,
                    turn_id=binding.identity.turn.turn_id,
                    message_id=binding.identity.segment_message_id or "",
                    tts_request_id=binding.tts_request_id,
                    external_correlation_id=binding.external_correlation_id,
                    stage="interaction.outbound_tts",
                    status="generating",
                    parent_message_id=parent_message_id,
                    persona_result_id=normalized_result_id,
                    persona_segment_index=segment_index,
                    persona_segment_count=len(speech_segments),
                )
                logger.debug(
                    "WIRING independent_motion.segment_tts_bound "
                    "turn_id=%s parent_message_id=%s persona_result_id=%s "
                    "segment_index=%s message_id=%s tts_request_id=%s",
                    turn_id,
                    parent_message_id,
                    normalized_result_id,
                    segment_index,
                    binding.identity.segment_message_id or "<missing>",
                    binding.tts_request_id or "<missing>",
                )

                client_objects.append(
                    {
                        "type": "ag99live.motion_payload",
                        "motion_payload": result.motion_payload,
                        "mode": "preview",
                        "source": "independent_provider",
                        "persona_segment_index": segment_index,
                        "persona_segment_count": len(speech_segments),
                    }
                )

        if not incremental or last_segment:
            sessions.clear_result(
                PersonaTurnIdentity(normalized_turn_id), normalized_result_id
            )
        logger.debug(
            "WIRING independent_motion.segment_finalized turn_id=%s "
            "parent_message_id=%s persona_result_id=%s phase=%s "
            "segment_count=%s payload_count=%s tts_binding_count=%s",
            turn_id,
            parent_message_id,
            normalized_result_id,
            phase,
            len(speech_segments),
            len(client_objects),
            len(tts_binding_metadata),
        )
        capabilities = get_interaction_capabilities()
        if capabilities is None:
            return None
        return capabilities.interaction_result_contribution(
            plugin_id=self.plugin_id,
            client_objects=client_objects,
            metadata={
                "ag99live_persona_tts_bindings": tts_binding_metadata,
                "ag99live_motion_schedule": _build_persona_segment_motion_schedule(
                    segment_count=len(speech_segments),
                    failure_reasons=failure_reasons,
                ),
            },
            priority=self.priority,
        )


def _persona_motion_finalization_timeout(
    runtime_state: Any,
    speech_segments: tuple[str, ...],
) -> float:
    nonempty_count = sum(bool(speech.strip()) for speech in speech_segments)
    if nonempty_count == 0:
        return 1.0

    try:
        segment_timeout = max(
            0.0,
            min(
                float(
                    getattr(
                        runtime_state,
                        "independent_motion_segment_timeout_seconds",
                        5.0,
                    )
                ),
                60.0,
            ),
        )
    except (TypeError, ValueError):
        segment_timeout = 5.0

    parallel = bool(
        getattr(runtime_state, "independent_motion_parallel", False)
    )
    if parallel:
        try:
            concurrency = max(
                1,
                min(
                    int(
                        getattr(
                            runtime_state,
                            "independent_motion_max_concurrency",
                            4,
                        )
                    ),
                    8,
                ),
            )
        except (TypeError, ValueError):
            concurrency = 4
    else:
        concurrency = 1

    waves = (nonempty_count + concurrency - 1) // concurrency
    # Keep the join bounded while allowing the already-running action requests
    # to overlap the complete TTS materialization.
    if segment_timeout == 0:
        return 30.0
    return min(30.0, max(1.0, segment_timeout * (waves + 1) + 1.0))


def _get_interaction_reply_plan(event: Any) -> Any:
    capabilities = get_interaction_capabilities()
    if capabilities is None:
        return None
    return capabilities.get_interaction_route_decision(event)


def _defer_optional_performance_curve_request(
    event: Any,
    *,
    attempt: _MotionScheduleAttempt,
) -> None:
    if attempt.motion_payload is None or not attempt.assistant_text:
        return
    resolve_adapter_event_context(event).set_pending_performance_curve(
        event,
        {
            "assistant_text": attempt.assistant_text,
            "motion_payload": attempt.motion_payload,
        },
    )

def start_deferred_performance_curve_request(
    event: Any,
    *,
    turn_id: str,
    message_id: str,
    tts_request_id: str,
    external_correlation_id: str | None,
    stage: str,
    status: str,
    parent_message_id: str | None = None,
    persona_result_id: str | None = None,
    persona_segment_index: int | None = None,
    persona_segment_count: int | None = None,
) -> str | None:
    if stage != "interaction.outbound_tts":
        return None

    event_context = resolve_adapter_event_context(event)
    if event_context.persona_segment_stream_active:
        # Stream delivery binds each TTS part to its runtime-owned motion Future.
        # The ordinary Persona result path requires the complete segment count.
        logger.debug(
            "WIRING performance_curve.skipped turn_id=%s "
            "reason=persona_stream_delivery_owns_binding",
            turn_id or "<missing>",
        )
        return None

    has_persona_identity = bool(
        str(persona_result_id or "").strip()
        or persona_segment_index is not None
        or persona_segment_count is not None
    )
    bundle = _resolve_motion_runtime_bundle(event)
    persona_segment = None
    if has_persona_identity:
        if bundle is None:
            logger.warning(
                "WIRING persona_tts_binding_rejected "
                "reason=motion_runtime_unavailable turn_id=%s "
                "persona_result_id=%s segment_index=%s",
                turn_id or "<missing>",
                persona_result_id or "<missing>",
                persona_segment_index,
            )
            return None
        persona_segment = _track_persona_tts_request(
            runtime_state=bundle.runtime_state,
            turn_id=turn_id,
            message_id=message_id,
            tts_request_id=tts_request_id,
            external_correlation_id=external_correlation_id,
            parent_message_id=parent_message_id,
            persona_result_id=persona_result_id,
            persona_segment_index=persona_segment_index,
            persona_segment_count=persona_segment_count,
        )
        if persona_segment is None:
            return None
        if status != "generating":
            return None
        result_state = bundle.runtime_state.persona_sessions.get_result(
            PersonaTurnIdentity(turn_id),
            persona_result_id,
        ) if turn_id else None
        segment_state = (
            result_state.segments.get(persona_segment_index)
            if result_state is not None
            else None
        )
        provider_result = None
        future = segment_state.result_future if segment_state is not None else None
        if future is not None and future.done() and not future.cancelled():
            try:
                provider_result = future.result()
            except Exception:  # noqa: BLE001 - the optional motion result is unavailable.
                provider_result = None
        motion_payload = getattr(provider_result, "motion_payload", None)
        assistant_text = persona_segment.speech
    else:
        if status != "generating":
            return None
        pending = event_context.pending_performance_curve
        if not isinstance(pending, dict):
            return None
        event_context.set_pending_performance_curve(event, None)
        motion_payload = pending.get("motion_payload")
        assistant_text = str(pending.get("assistant_text") or "")

    if not isinstance(motion_payload, dict) or not assistant_text.strip():
        return None
    if bundle is None:
        logger.warning(
            "WIRING performance_curve.skipped reason=motion_runtime_unavailable "
            "turn_id=%s message_id=%s tts_request_id=%s",
            external_correlation_id or "<missing>",
            message_id or "<missing>",
            tts_request_id or "<missing>",
        )
        return None
    request_id = bundle.turn_coordinator.performance_curves.start_request(
        turn_id=external_correlation_id,
        tts_turn_id=turn_id,
        message_id=message_id,
        request_id=tts_request_id,
        assistant_text=assistant_text,
        motion_payload=motion_payload,
    )
    if request_id:
        logger.debug(
            "WIRING performance_curve_started turn_id=%s message_id=%s "
            "tts_request_id=%s",
            turn_id,
            message_id,
            tts_request_id,
        )
    return request_id


def _track_persona_tts_request(
    *,
    runtime_state: Any,
    turn_id: str,
    message_id: str,
    tts_request_id: str,
    external_correlation_id: str | None,
    parent_message_id: str | None,
    persona_result_id: str | None,
    persona_segment_index: int | None,
    persona_segment_count: int | None,
) -> PersonaTtsBinding | None:
    normalized_message_id = str(message_id or "").strip()
    normalized_turn_id = str(turn_id or "").strip()
    normalized_request_id = str(tts_request_id or "").strip()
    normalized_parent_id = str(parent_message_id or "").strip()
    normalized_result_id = str(persona_result_id or "").strip()
    if (
        not normalized_message_id
        or not normalized_turn_id
        or not normalized_request_id
        or not normalized_parent_id
        or not normalized_result_id
        or type(persona_segment_index) is not int
        or type(persona_segment_count) is not int
        or persona_segment_count <= 0
        or persona_segment_index < 0
        or persona_segment_index >= persona_segment_count
    ):
        logger.warning(
            "WIRING persona_tts_binding_rejected reason=identity_invalid "
            "turn_id=%s parent_message_id=%s persona_result_id=%s "
            "segment_index=%s segment_count=%s message_id=%s tts_request_id=%s",
            normalized_turn_id or "<missing>",
            normalized_parent_id or "<missing>",
            normalized_result_id or "<missing>",
            persona_segment_index,
            persona_segment_count,
            normalized_message_id or "<missing>",
            normalized_request_id or "<missing>",
        )
        return None
    expected = {
        "turn_id": normalized_turn_id,
        "parent_message_id": normalized_parent_id,
        "persona_result_id": normalized_result_id,
        "persona_segment_index": persona_segment_index,
        "persona_segment_count": persona_segment_count,
        "message_id": normalized_message_id,
        "tts_request_id": normalized_request_id,
        "external_correlation_id": str(external_correlation_id or "").strip() or None,
    }
    work = runtime_state.persona_sessions.get_result(
        PersonaTurnIdentity(normalized_turn_id),
        normalized_result_id,
    )
    if work is None:
        return None
    segment_count = work.expected_segment_count or (max(work.segments, default=-1) + 1)
    speech_segments = tuple(
        (work.segments[index].speech or "")
        if index in work.segments
        else ""
        for index in range(segment_count)
    )
    if (
        len(speech_segments) != persona_segment_count
            or normalized_turn_id != work.turn.turn_id
            or normalized_result_id != work.persona_result_id
            or normalized_parent_id != work.parent_message_id
    ):
        logger.warning(
            "WIRING persona_tts_binding_rejected reason=persona_identity_mismatch "
            "turn_id=%s parent_message_id=%s persona_result_id=%s "
            "segment_index=%s segment_count=%s",
            normalized_turn_id,
            normalized_parent_id,
            normalized_result_id,
            persona_segment_index,
            persona_segment_count,
        )
        return None

    segment_identity = PersonaSegmentIdentity(
        turn=work.turn,
        persona_result_id=normalized_result_id,
        segment_index=persona_segment_index,
        segment_count=persona_segment_count,
        segment_message_id=normalized_message_id,
    )
    segment_state = work.segment(segment_identity)
    existing = segment_state.tts_binding
    if existing is not None:
        if (
            existing.identity.turn != work.turn
            or existing.parent_message_id != normalized_parent_id
            or existing.identity != segment_identity
            or existing.tts_request_id != normalized_request_id
            or existing.external_correlation_id
            != expected["external_correlation_id"]
        ):
            logger.warning(
                "WIRING persona_tts_binding_rejected reason=segment_binding_conflict "
                "turn_id=%s persona_result_id=%s segment_index=%s message_id=%s",
                normalized_turn_id,
                normalized_result_id,
                persona_segment_index,
                normalized_message_id,
            )
            return None
        tracked = existing
    else:
        duplicate_message = runtime_state.persona_sessions.find_segment_by_message_id(
            PersonaTurnIdentity(normalized_turn_id),
            normalized_message_id,
        )
        duplicate_request = any(
            candidate.tts_binding is not None
            and candidate.tts_binding.tts_request_id == normalized_request_id
            for candidate in work.segments.values()
            if candidate.index != persona_segment_index
        )
        if duplicate_message is not None or duplicate_request:
            logger.warning(
                "WIRING persona_tts_binding_rejected reason=request_identity_conflict "
                "turn_id=%s persona_result_id=%s segment_index=%s message_id=%s",
                normalized_turn_id,
                normalized_result_id,
                persona_segment_index,
                normalized_message_id,
            )
            return None
        tracked = PersonaTtsBinding(
            identity=segment_identity,
            parent_message_id=normalized_parent_id,
            tts_request_id=normalized_request_id,
            external_correlation_id=expected["external_correlation_id"],
            speech=speech_segments[persona_segment_index],
        )
        try:
            work.bind_tts(tracked)
        except (ValueError, RuntimeError) as exc:
            logger.warning(
                "WIRING persona_tts_binding_rejected reason=%s turn_id=%s "
                "persona_result_id=%s segment_index=%s",
                exc,
                normalized_turn_id,
                normalized_result_id,
                persona_segment_index,
            )
            return None

    return tracked

async def _schedule_motion_from_interaction_result(
    event: Any,
    view: Any,
) -> _MotionScheduleAttempt | None:
    bundle = _resolve_motion_runtime_bundle(event)
    if bundle is None:
        return None

    phase = _resolve_result_phase(view)
    assistant_text = _extract_assistant_text(view)
    identity = _resolve_frontend_identity_snapshot(event)
    reply_plan = _resolve_interaction_reply_plan_snapshot(event, view)

    source_route = resolve_persona_motion_source_route(
        event,
        bundle.runtime_state,
        capture_if_missing=True,
    )
    if source_route == "independent_motion":
        return await _schedule_motion_from_independent_provider(
            event,
            view,
            bundle=bundle,
            phase=phase,
            assistant_text=assistant_text,
            identity=identity,
            reply_plan=reply_plan,
        )

    motion_payloads_by_segment, motion_reason = _resolve_persona_effect_motion_payload_with_reason(
        event, bundle.runtime_state, view=view
    )
    _log_persona_effect_motion_resolution(
        event,
        phase=phase,
        payload=motion_payloads_by_segment,
        reason=motion_reason,
        view=view,
    )
    _record_motion_lab_interaction_event(
        bundle,
        event,
        view=view,
        phase=phase,
        identity=identity,
        motion_payloads_by_segment=motion_payloads_by_segment,
        motion_reason=motion_reason,
    )

    policy = _resolve_motion_schedule_policy(
        event,
        phase=phase,
        reply_plan=reply_plan,
    )

    if motion_payloads_by_segment and policy.should_schedule:
        _call_event_method(event, "set_extra", "ag99live_split_motion_scheduled", True)
        return _MotionScheduleAttempt(
            phase=phase,
            source="persona_effect",
            scheduled_frontend_turn_id=identity.event_frontend_turn_id,
            event_frontend_turn_id=identity.event_frontend_turn_id,
            reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
            reply_plan_should_emit_immediate_reply=(
                reply_plan.should_emit_immediate_reply if reply_plan is not None else None
            ),
            reply_plan_source=reply_plan.source if reply_plan is not None else None,
            scheduled=True,
            reason="persona_effect_motion_client_object",
            assistant_text=assistant_text,
            motion_payloads_by_segment=motion_payloads_by_segment,
            persona_segment_count=_persona_segment_count(view),
            motion_resolution_reason=motion_reason,
        )

    if not assistant_text:
        return _MotionScheduleAttempt(
            phase=phase,
            source=None,
            scheduled_frontend_turn_id=identity.event_frontend_turn_id,
            event_frontend_turn_id=identity.event_frontend_turn_id,
            reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
            reply_plan_should_emit_immediate_reply=(
                reply_plan.should_emit_immediate_reply if reply_plan is not None else None
            ),
            reply_plan_source=reply_plan.source if reply_plan is not None else None,
            scheduled=False,
            reason="assistant_text_empty",
            assistant_text=assistant_text,
            persona_segment_count=_persona_segment_count(view),
            motion_resolution_reason=motion_reason,
        )

    if not policy.should_schedule or policy.source is None:
        return _MotionScheduleAttempt(
            phase=phase,
            source=None,
            scheduled_frontend_turn_id=identity.event_frontend_turn_id,
            event_frontend_turn_id=identity.event_frontend_turn_id,
            reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
            reply_plan_should_emit_immediate_reply=(
                reply_plan.should_emit_immediate_reply if reply_plan is not None else None
            ),
            reply_plan_source=reply_plan.source if reply_plan is not None else None,
            scheduled=False,
            reason=policy.reason,
            assistant_text=assistant_text,
            persona_segment_count=_persona_segment_count(view),
            motion_resolution_reason=motion_reason,
        )

    if policy.should_schedule and motion_payloads_by_segment is None:
        missing_reason = _append_resolution_reason(
            motion_reason,
            "self_reply_motion_missing"
            if phase == "immediate"
            and reply_plan is not None
            and reply_plan.route_mode == "self_reply"
            else "motion_payload_missing",
        )
        return _MotionScheduleAttempt(
            phase=phase,
            source=policy.source,
            scheduled_frontend_turn_id=identity.event_frontend_turn_id,
            event_frontend_turn_id=identity.event_frontend_turn_id,
            reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
            reply_plan_should_emit_immediate_reply=(
                reply_plan.should_emit_immediate_reply if reply_plan is not None else None
            ),
            reply_plan_source=reply_plan.source if reply_plan is not None else None,
            scheduled=False,
            reason="motion_payload_missing",
            assistant_text=assistant_text,
            persona_segment_count=_persona_segment_count(view),
            motion_resolution_reason=missing_reason,
        )

    return _MotionScheduleAttempt(
        phase=phase,
        source=policy.source,
        scheduled_frontend_turn_id=identity.event_frontend_turn_id,
        event_frontend_turn_id=identity.event_frontend_turn_id,
        reply_plan_route_mode=reply_plan.route_mode if reply_plan is not None else None,
        reply_plan_should_emit_immediate_reply=(
            reply_plan.should_emit_immediate_reply if reply_plan is not None else None
        ),
        reply_plan_source=reply_plan.source if reply_plan is not None else None,
        scheduled=False,
        reason=policy.reason,
        assistant_text=assistant_text,
        persona_segment_count=_persona_segment_count(view),
        motion_resolution_reason=motion_reason,
    )

async def _schedule_motion_from_independent_provider(
    event: Any,
    view: Any,
    *,
    bundle: _MotionRuntimeBundle,
    phase: str,
    assistant_text: str,
    identity: _FrontendIdentitySnapshot,
    reply_plan: _InteractionReplyPlanSnapshot | None,
) -> _MotionScheduleAttempt:
    logger.debug(
        "WIRING independent_motion.schedule_started phase=%s turn_id=%s "
        "assistant_text_len=%s",
        phase,
        identity.event_frontend_turn_id or "<missing>",
        len(assistant_text),
    )
    policy = _resolve_motion_schedule_policy(
        event,
        phase=phase,
        reply_plan=reply_plan,
    )
    common = {
        "phase": phase,
        "scheduled_frontend_turn_id": identity.event_frontend_turn_id,
        "event_frontend_turn_id": identity.event_frontend_turn_id,
        "reply_plan_route_mode": reply_plan.route_mode if reply_plan is not None else None,
        "reply_plan_should_emit_immediate_reply": (
            reply_plan.should_emit_immediate_reply if reply_plan is not None else None
        ),
        "reply_plan_source": reply_plan.source if reply_plan is not None else None,
        "assistant_text": assistant_text,
    }
    if not policy.should_schedule or policy.source is None:
        return _MotionScheduleAttempt(
            **common,
            source=None,
            scheduled=False,
            reason=policy.reason,
            motion_resolution_reason=policy.reason,
        )
    metadata = getattr(view, "metadata", None)
    purpose = (
        str(metadata.get("purpose") or "").strip()
        if isinstance(metadata, Mapping)
        else ""
    )
    if phase not in {"immediate", "final"} or purpose not in {
        "persona_reply",
        "core_reply",
    }:
        return _MotionScheduleAttempt(
            **common,
            source=None,
            scheduled=False,
            reason="unsupported_persona_result_candidate",
            motion_resolution_reason="independent_segment_candidate_unsupported",
        )
    return _schedule_motion_from_independent_provider_per_segment(
        view,
        phase=phase,
        common=common,
        identity=identity,
    )


def _schedule_motion_from_independent_provider_per_segment(
    view: Any,
    *,
    phase: str,
    common: dict[str, Any],
    identity: _FrontendIdentitySnapshot,
) -> _MotionScheduleAttempt:
    speech_segments = tuple(_extract_persona_speech_segments(view))
    if not any(speech.strip() for speech in speech_segments):
        return _MotionScheduleAttempt(
            **common,
            source=None,
            scheduled=False,
            reason="assistant_text_empty",
            motion_resolution_reason="independent_provider_response_text_missing",
        )
    logger.debug(
        "WIRING independent_motion.segment_work_missing phase=%s "
        "turn_id=%s persona_result_id=%s segment_count=%s",
        phase,
        identity.event_frontend_turn_id or "<missing>",
        (
            str(getattr(view, "metadata", {}).get("persona_result_id") or "")
            if isinstance(getattr(view, "metadata", None), Mapping)
            else "<missing>"
        ),
        len(speech_segments),
    )
    return _MotionScheduleAttempt(
        **common,
        source="independent_provider",
        scheduled=False,
        reason="motion_payload_missing",
        motion_payloads_by_segment={},
        persona_segment_count=len(speech_segments) or None,
        motion_resolution_reason="independent_segment_work_missing",
    )


def _log_persona_effect_motion_resolution(
    event: Any,
    *,
    phase: str,
    payload: dict[int, dict[str, Any]] | None,
    reason: str,
    view: Any = None,
) -> None:
    effect_names = []
    for raw_call in _extract_effect_calls_for_motion(event, view):
        call = _thaw_snapshot_value(raw_call)
        name = str(_effect_call_get(call, "name") or "").strip()
        if name:
            effect_names.append(name)

    effect_summary = _summarize_ag99live_motion_effect_arguments(event, view)
    payload_axes_keys: list[str] = []
    payload_expression_resource_id = ""
    payload_motion_resource_id = ""
    if isinstance(payload, Mapping):
        axis_keys: set[str] = set()
        expression_resource_ids: set[str] = set()
        motion_resource_ids: set[str] = set()
        for segment_payload in payload.values():
            if not isinstance(segment_payload, Mapping):
                continue
            axes = segment_payload.get("axis_levels")
            motion_steps = segment_payload.get("motion_steps")
            if isinstance(axes, Mapping):
                axis_keys.update(
                    str(key).strip()
                    for key in axes
                    if str(key).strip()
                )
            elif isinstance(motion_steps, list):
                axis_keys.update(_collect_motion_step_axis_keys(motion_steps))
            expression_resource_id = str(
                segment_payload.get("expression_resource_id") or ""
            ).strip()
            motion_resource_id = str(
                segment_payload.get("motion_resource_id") or ""
            ).strip()
            if expression_resource_id:
                expression_resource_ids.add(expression_resource_id)
            if motion_resource_id:
                motion_resource_ids.add(motion_resource_id)
        payload_axes_keys = sorted(axis_keys)
        payload_expression_resource_id = ",".join(sorted(expression_resource_ids))
        payload_motion_resource_id = ",".join(sorted(motion_resource_ids))

    logger.debug(
        "WIRING persona_effect_motion phase=%s payload_present=%s segment_indexes=%s reason=%s "
        "effect_names=%s effect_fields=%s effect_axis_keys=%s effect_intent_tags=%s "
        "effect_expression_resource_id=%s effect_motion_resource_id=%s "
        "payload_axis_keys=%s payload_expression_resource_id=%s "
        "payload_motion_resource_id=%s",
        phase or "",
        bool(payload),
        ",".join(str(index) for index in sorted(payload or {})),
        reason,
        ",".join(sorted(effect_names)),
        ",".join(effect_summary["fields"]),
        ",".join(effect_summary["axis_keys"]),
        ",".join(effect_summary["intent_tags"]),
        effect_summary["expression_resource_id"],
        effect_summary["motion_resource_id"],
        ",".join(payload_axes_keys),
        payload_expression_resource_id,
        payload_motion_resource_id,
    )

def _record_motion_lab_interaction_event(
    bundle: _MotionRuntimeBundle,
    event: Any,
    *,
    view: Any,
    phase: str,
    identity: _FrontendIdentitySnapshot,
    motion_payloads_by_segment: dict[int, dict[str, Any]] | None,
    motion_reason: str,
) -> None:
    segments = _extract_persona_segments_for_observation(view)
    for segment in segments:
        segment_index = segment["segment_index"]
        segment["motion_payload"] = (motion_payloads_by_segment or {}).get(
            segment_index
        )
    turn_id = identity.event_frontend_turn_id
    recorder = getattr(bundle.runtime_state, "motion_lab_recorder", None)
    segment_count = len(segments)
    effect_arguments_by_segment, _effect_parse_reason = (
        _extract_ag99live_motion_effect_arguments(
            event,
            view,
            segment_count=segment_count,
        )
        if segment_count
        else ({}, "persona_effect_no_speech_segments")
    )
    metadata = getattr(view, "metadata", None)
    persona_result_id = (
        metadata.get("persona_result_id")
        if isinstance(metadata, Mapping)
        else None
    )
    if not persona_result_id:
        persona_result_id = _call_event_method(
            event,
            "get_extra",
            "interaction.persona_result_id",
            None,
        )
    original_user_text = str(
        _call_event_method(event, "get_extra", "ag99live_original_message_str", "")
        or getattr(event, "message_str", "")
        or ""
    )
    delivery_mode = resolve_persona_delivery_mode(event)
    for segment in segments:
        segment_index = segment.get("segment_index")
        if type(segment_index) is not int:
            continue
        motion_payload = segment.get("motion_payload")
        persona_segment = {
            key: segment.get(key)
            for key in ("speech", "actions", "tendency")
        }
        effect_arguments = (
            effect_arguments_by_segment.get(segment_index)
            if isinstance(effect_arguments_by_segment, dict)
            else None
        )
        raw_effect_calls = []
        for raw_call in _extract_effect_calls_for_motion(event, view):
            call = _thaw_snapshot_value(raw_call)
            if (
                str(_effect_call_get(call, "name") or "").strip()
                == AG99LIVE_MOTION_EFFECT_NAME
                and type(_effect_call_get(call, "segment_index")) is int
                and _effect_call_get(call, "segment_index") == segment_index
            ):
                raw_effect_calls.append(call)
        record_persona_motion_sample(
            recorder,
            turn_id=turn_id,
            persona_result_id=(
                str(persona_result_id).strip()
                if persona_result_id is not None
                else None
            ),
            segment_index=segment_index,
            segment_count=segment_count,
            segment_message_id=None,
            source_route="persona_effect",
            delivery_mode=delivery_mode,
            record_stage="motion_result",
            record_key="persona-effect-result",
            input_context={
                "user_text": original_user_text,
                "persona_phase": phase,
                "context_scope": "current_user_input_only",
                "persona_prompt_context_available": False,
            },
            persona_segment=persona_segment,
            motion={
                "raw_output": {
                    "effect_call_arguments": effect_arguments,
                    "effect_calls": raw_effect_calls,
                },
                "accepted_payload": motion_payload,
                "status": "accepted" if isinstance(motion_payload, dict) else "failed",
                "reason": motion_reason,
            },
        )

def _summarize_ag99live_motion_effect_arguments(event: Any, view: Any) -> dict[str, Any]:
    summary = {
        "fields": [],
        "axis_keys": [],
        "intent_tags": [],
        "expression_resource_id": "",
        "motion_resource_id": "",
        "segment_indexes": [],
    }
    segment_count = _persona_segment_count(view)
    if segment_count is None:
        return summary
    arguments_by_segment, _reason = _extract_ag99live_motion_effect_arguments(
        event,
        view,
        segment_count=segment_count,
    )
    if not isinstance(arguments_by_segment, dict):
        return summary

    fields: set[str] = set()
    axis_keys: set[str] = set()
    intent_tags: list[str] = []
    expression_resource_ids: set[str] = set()
    motion_resource_ids: set[str] = set()
    summary["segment_indexes"] = sorted(arguments_by_segment)
    for raw_arguments in arguments_by_segment.values():
        fields.update(
            str(key).strip()
            for key in raw_arguments
            if str(key).strip()
        )
        raw_axes = raw_arguments.get("axis_levels")
        if isinstance(raw_axes, Mapping):
            axis_keys.update(
                str(key).strip()
                for key in raw_axes
                if str(key).strip()
            )
        else:
            motion_steps = _thaw_snapshot_value(raw_arguments.get("motion_steps"))
            if isinstance(motion_steps, list):
                axis_keys.update(_collect_motion_step_axis_keys(motion_steps))
        raw_intent_tags = _thaw_snapshot_value(raw_arguments.get("intent_tags"))
        if isinstance(raw_intent_tags, (list, tuple, set)):
            intent_tags.extend(
                str(item).strip()
                for item in raw_intent_tags
                if str(item).strip()
            )
        elif str(raw_intent_tags or "").strip():
            intent_tags.append(str(raw_intent_tags).strip())
        expression_resource_id = str(
            raw_arguments.get("expression_resource_id") or ""
        ).strip()
        motion_resource_id = str(raw_arguments.get("motion_resource_id") or "").strip()
        if expression_resource_id:
            expression_resource_ids.add(expression_resource_id)
        if motion_resource_id:
            motion_resource_ids.add(motion_resource_id)
    summary["fields"] = sorted(fields)
    summary["axis_keys"] = sorted(axis_keys)
    summary["intent_tags"] = intent_tags
    summary["expression_resource_id"] = ",".join(sorted(expression_resource_ids))
    summary["motion_resource_id"] = ",".join(sorted(motion_resource_ids))
    return summary


def _extract_persona_segments_for_observation(view: Any) -> list[dict[str, Any]]:
    segments = getattr(view, "segments", None)
    if not isinstance(segments, (list, tuple)):
        return []
    result: list[dict[str, Any]] = []
    for index, segment in enumerate(segments):
        if not isinstance(segment, Mapping):
            continue
        result.append(
            {
                "segment_index": index,
                "speech": str(segment.get("speech") or ""),
                "actions": list(segment.get("actions") or []),
                "tendency": dict(segment.get("tendency") or {}),
            }
        )
    return result


def _extract_persona_speech_segments(view: Any) -> list[str]:
    segments = getattr(view, "segments", None)
    if not isinstance(segments, (list, tuple)):
        return []
    return [
        sanitize_assistant_output_segment_text(str(segment.get("speech") or ""))
        for segment in segments
        if isinstance(segment, Mapping)
    ]


def _extract_raw_persona_speech_segments(view: Any) -> list[str]:
    segments = getattr(view, "segments", None)
    if not isinstance(segments, (list, tuple)):
        return []
    return [
        str(segment.get("speech") or "")
        for segment in segments
        if isinstance(segment, Mapping)
    ]

def _collect_motion_step_axis_keys(motion_steps: list[Any]) -> list[str]:
    axis_ids: set[str] = set()
    for step in motion_steps:
        step_axes = step.get("axis_levels") if isinstance(step, dict) else None
        if not isinstance(step_axes, Mapping):
            continue
        axis_ids.update(
            str(axis_id).strip()
            for axis_id in step_axes
            if str(axis_id).strip()
        )
    return sorted(axis_ids)

def _extract_assistant_text(view: Any) -> str:
    persona_segments = _extract_persona_segments_for_observation(view)
    if persona_segments:
        persona_speech = "".join(
            segment["speech"] for segment in persona_segments
        ).strip()
        if persona_speech:
            return sanitize_assistant_output_text(persona_speech).strip()
    return sanitize_assistant_output_text(_extract_raw_assistant_text(view)).strip()

def _extract_raw_assistant_text(view: Any) -> str:
    for value in (
        getattr(view, "final_result", None),
        getattr(view, "core_result", None),
        getattr(view, "immediate_reply", None),
    ):
        text = str(value or "").strip()
        if text:
            return text
    return ""

def _resolve_motion_schedule_policy(
    event: Any,
    *,
    phase: str,
    reply_plan: _InteractionReplyPlanSnapshot | None,
) -> _MotionSchedulePolicy:
    if phase == "immediate":
        return _resolve_immediate_phase_policy()
    if phase == "final":
        return _resolve_final_phase_policy(
            event,
            reply_plan=reply_plan,
        )
    return _MotionSchedulePolicy(
        should_schedule=False,
        source=None,
        reason="unsupported_phase",
    )

def _resolve_immediate_phase_policy(
) -> _MotionSchedulePolicy:
    return _MotionSchedulePolicy(
        should_schedule=True,
        source="interaction_result_immediate",
        reason="schedule_immediate_persona_reply",
    )

def _resolve_final_phase_policy(
    event: Any,
    *,
    reply_plan: _InteractionReplyPlanSnapshot | None,
) -> _MotionSchedulePolicy:
    if reply_plan is not None and reply_plan.route_mode == "self_reply":
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="self_reply_does_not_use_final_phase",
        )
    already_scheduled = bool(
        _call_event_method(event, "get_extra", "ag99live_split_motion_scheduled", False)
    )
    route_mode = reply_plan.route_mode if reply_plan is not None else None
    if already_scheduled and route_mode not in {"hybrid", "delegate_to_core"}:
        return _MotionSchedulePolicy(
            should_schedule=False,
            source=None,
            reason="already_scheduled_by_motion_pipeline",
        )
    return _MotionSchedulePolicy(
        should_schedule=True,
        source="interaction_result_final",
        reason="schedule_core_reply_final",
    )

def _resolve_interaction_reply_plan_snapshot(
    event: Any,
    view: Any,
) -> _InteractionReplyPlanSnapshot | None:
    snapshot = _coerce_interaction_reply_plan_snapshot(
        _get_interaction_reply_plan(event),
        source="event_turn_state",
    )
    if snapshot is not None:
        return snapshot

    snapshot = _coerce_interaction_reply_plan_snapshot(
        _call_event_method(
            event,
            "get_extra",
            INTERACTION_ROUTE_DECISION_EXTRA_KEY,
            None,
        ),
        source="event_extra",
    )
    if snapshot is not None:
        return snapshot

    return _coerce_interaction_reply_plan_snapshot(
        getattr(view, "route_decision", None),
        source="view",
    )

def _coerce_interaction_reply_plan_snapshot(
    value: Any,
    *,
    source: str,
) -> _InteractionReplyPlanSnapshot | None:
    if value is None:
        return None

    if isinstance(value, Mapping):
        route_mode_raw = value.get("route_mode")
        should_emit_raw = (
            value.get("should_emit_immediate_reply")
            if "should_emit_immediate_reply" in value
            else None
        )
    else:
        route_mode_raw = getattr(value, "route_mode", None)
        should_emit_raw = getattr(value, "should_emit_immediate_reply", None)

    route_mode = _normalize_optional_string(getattr(route_mode_raw, "value", route_mode_raw))
    should_emit_immediate_reply = (
        bool(should_emit_raw) if should_emit_raw is not None else None
    )
    if route_mode is None and should_emit_immediate_reply is None:
        return None
    return _InteractionReplyPlanSnapshot(
        route_mode=route_mode,
        should_emit_immediate_reply=should_emit_immediate_reply,
        source=source,
    )
