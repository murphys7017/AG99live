from __future__ import annotations

import asyncio
import json
import math
import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from time import monotonic, perf_counter, time_ns
from typing import Any
from uuid import uuid4

from ...runtime.motion_emotion import read_motion_emotion
from astrbot.api import logger

from ...runtime.adapter_event_context import resolve_adapter_event_context
from ...runtime.persona_lifecycle import PersonaSegmentState
from ...runtime.plugin_runtime import DEFAULT_SPEECH_MS_PER_HAN_CHAR
from ...motion.observation import (
    record_persona_motion_sample,
    resolve_persona_core_turn_id,
    resolve_persona_delivery_mode,
)
from ...motion.motion_intent import MAX_MOTION_STEPS
from ...motion.output_sanitizer import sanitize_assistant_output_text
from ...motion.payload_validation import (
    normalize_motion_arguments_payload,
)
from ...motion.provider_contract import ExpressionPrefixDecoder, expression_record
from ...motion.text_stream import (
    TextChatStreamOutputTooLarge,
    TextChatStreamUnavailable,
    read_text_chat_stream,
    supports_text_chat_stream,
)
from .prompt_builder import (
    _build_motion_capability_prompt_payload,
    _build_motion_static_capability_payload,
)
from .prompt_context import (
    _record_motion_prompt_reference_observation,
    _resolve_prompt_motion_history,
)
from ...prompts.expression_axes import describe_expression_axis
from ...prompts.expression_examples import resolve_expression_examples
from ...prompts.trained_expression import (
    build_trained_expression_prompts, trained_expression_record, uses_trained_expression_prompt,
)
from .shared import (
    _append_resolution_reason,
    _MotionRuntimeBundle,
    _sanitize_reason_fragment,
)

PERSONA_EXPRESSION_INTENT_METADATA_KEY = "interaction.persona_expression_intent"
PERSONA_RESULT_ID_METADATA_KEY = "interaction.persona_result_id"
_DEFAULT_SEGMENT_MAX_CONCURRENCY = 4
_DEFAULT_SEGMENT_TIMEOUT_SECONDS = 5.0


def resolve_stream_motion_budget_seconds(runtime_state: Any, *, event: Any = None) -> float:
    """Bound configured motion work by the remaining owning Turn budget."""

    try:
        configured = float(
            getattr(
                runtime_state,
                "independent_motion_segment_timeout_seconds",
                _DEFAULT_SEGMENT_TIMEOUT_SECONDS,
            )
        )
    except (TypeError, ValueError):
        configured = _DEFAULT_SEGMENT_TIMEOUT_SECONDS
    if not math.isfinite(configured) or configured <= 0:
        configured = _DEFAULT_SEGMENT_TIMEOUT_SECONDS
    configured = min(configured, 60.0)
    if event is not None:
        # Enhanced Core supplies the Turn deadline; ordinary upstream AstrBot
        # has no such API and keeps the configured bounded motion budget.
        try:
            from astrbot.core.interaction.turn_state import (
                get_interaction_turn_deadline,
            )
        except ImportError:
            return configured
        deadline = get_interaction_turn_deadline(event)
        if deadline is not None:
            configured = min(configured, deadline.remaining())
    return configured


async def _request_motion_provider_text(
    provider: Any,
    *,
    prompt: str,
    system_prompt: str,
    contexts: list[dict[str, str]] | tuple[dict[str, str], ...] | None,
    turn_id: str,
    motion_request_id: str,
    persona_result_id: str | None,
    segment_index: int | None,
    on_complete_json: Any | None = None,
) -> tuple[str, str]:
    """Read the motion Provider incrementally without a complete-chat fallback."""

    started = perf_counter()
    first_chunk_received = False

    def _on_first_chunk() -> None:
        nonlocal first_chunk_received
        first_chunk_received = True
        logger.info(
            "DIAG latency.motion_provider_first_chunk turn_id=%s "
            "motion_request_id=%s persona_result_id=%s segment_index=%s "
            "transport=stream elapsed_ms=%.1f timestamp_epoch_ms=%s",
            turn_id,
            motion_request_id,
            persona_result_id or "<none>",
            segment_index,
            (perf_counter() - started) * 1000,
            time_ns() // 1_000_000,
        )

    status = "failed"
    try:
        text = await read_text_chat_stream(
            provider,
            prompt=prompt,
            system_prompt=system_prompt,
            contexts=contexts,
            on_first_chunk=_on_first_chunk,
            on_complete_json=on_complete_json,
            decode_next_record=ExpressionPrefixDecoder(),
        )
        status = "completed"
        return text, "stream"
    except asyncio.CancelledError:
        status = "cancelled"
        raise
    finally:
        logger.info(
            "DIAG latency.motion_provider_stream_finished turn_id=%s "
            "motion_request_id=%s persona_result_id=%s segment_index=%s "
            "status=%s first_chunk_received=%s elapsed_ms=%.1f timestamp_epoch_ms=%s",
            turn_id,
            motion_request_id,
            persona_result_id or "<none>",
            segment_index,
            status,
            first_chunk_received,
            (perf_counter() - started) * 1000,
            time_ns() // 1_000_000,
        )


def _consume_background_motion_exception(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    try:
        error = task.exception()
    except asyncio.CancelledError:
        return
    if error is not None:
        logger.warning(
            "WIRING independent_motion.background_task_failed error=%s",
            error,
        )


async def await_with_hard_deadline(
    awaitable: Any,
    timeout: float,
    *,
    background_tasks: set[asyncio.Task] | None = None,
) -> Any:
    """Await optional motion work without waiting for cancellation to finish."""

    task = (
        awaitable
        if isinstance(awaitable, (asyncio.Task, asyncio.Future))
        else asyncio.create_task(awaitable)
    )
    if background_tasks is not None:
        background_tasks.add(task)
        task.add_done_callback(background_tasks.discard)

    try:
        done, _ = await asyncio.wait({task}, timeout=max(0.0, float(timeout)))
    except asyncio.CancelledError:
        if not task.done():
            task.cancel()
        task.add_done_callback(_consume_background_motion_exception)
        raise

    if task in done:
        return await task

    if not task.done():
        task.cancel()
    task.add_done_callback(_consume_background_motion_exception)
    raise asyncio.TimeoutError


@dataclass(slots=True)
class IndependentMotionResult:
    assistant_text: str
    motion_payload: dict[str, Any] | None
    reason: str
    image_count: int


@dataclass(frozen=True, slots=True)
class IndependentMotionContext:
    """Read-only motion inputs shared by all speech segments in one turn."""

    current_user_text: str
    contexts: tuple[dict[str, str], ...]
    capability_payload: dict[str, Any]
    runtime_payload: dict[str, Any]
    reference_diagnostics: tuple[str, ...]
    persona_guidance: Mapping[str, Any] | None = None


def _append_planned_motion_context(
    context: IndependentMotionContext,
    motion_payload: Mapping[str, Any] | None,
) -> IndependentMotionContext:
    """Carry the prior segment's planned action into the next segment reference set.

    The existing ``recent_executed_motions`` channel is already projected into the
    provider guidance.  Keeping the continuity state there avoids changing the
    prompt text or the motion payload contract while allowing an ordered segment
    batch to plan from its predecessor.
    """

    if not isinstance(motion_payload, Mapping):
        return context
    runtime_payload = dict(context.runtime_payload)
    recent = runtime_payload.get("recent_executed_motions")
    recent_motions = [
        dict(item)
        for item in recent
        if isinstance(item, Mapping)
    ] if isinstance(recent, list) else []
    recent_motions.append(dict(motion_payload))
    runtime_payload["recent_executed_motions"] = recent_motions[-3:]
    return IndependentMotionContext(
        current_user_text=context.current_user_text,
        contexts=context.contexts,
        capability_payload=context.capability_payload,
        runtime_payload=runtime_payload,
        reference_diagnostics=context.reference_diagnostics,
        persona_guidance=context.persona_guidance,
    )


def is_persona_expression_request(request: Any) -> bool:
    """Identify an AstrBot request that belongs to the Persona expression path."""
    metadata = getattr(request, "metadata", None)
    if not isinstance(metadata, Mapping):
        return False
    intent = metadata.get(PERSONA_EXPRESSION_INTENT_METADATA_KEY)
    return isinstance(intent, Mapping) and bool(str(intent.get("phase") or "").strip())


def persona_expression_intent(request: Any) -> Mapping[str, Any] | None:
    """Return Persona intent metadata attached to AstrBot's active request."""
    metadata = getattr(request, "metadata", None)
    if not isinstance(metadata, Mapping):
        return None
    intent = metadata.get(PERSONA_EXPRESSION_INTENT_METADATA_KEY)
    return intent if isinstance(intent, Mapping) else None


def persona_motion_phase(request: Any) -> str | None:
    """Resolve the output phase used by the adapter's motion result identity."""
    intent = persona_expression_intent(request)
    if intent is None:
        return None
    phase = str(intent.get("phase") or "").strip()
    kind = str(intent.get("kind") or "").strip()
    if kind == "reply" and phase in {"immediate", "final"}:
        return phase
    if kind == phase == "proactive" and intent.get("source") in {
        "reading_commentary",
        "runtime_observation",
    }:
        return "immediate"
    return None


async def _prepare_independent_motion_context(
    event: Any,
    bundle: _MotionRuntimeBundle,
) -> IndependentMotionContext:
    """Build one stable context snapshot for all segments in a turn."""
    from astrbot.core.interaction.context_builder import (
        get_interaction_persona_prompt_projection,
    )

    current_user_text = _dialogue_text(str(getattr(event, "message_str", "") or ""))

    history_turns = max(
        0,
        min(
            int(getattr(bundle.runtime_state, "independent_motion_history_turns", 6)),
            20,
        ),
    )
    contexts = tuple(
        await _load_recent_history(
            event,
            bundle,
            history_turns=history_turns,
            current_user_text=current_user_text,
        )
    )
    event_context = resolve_adapter_event_context(event)
    logger.debug(
        "WIRING independent_motion.shared_context_prepared turn_id=%s "
        "requested_turns=%s message_count=%s image_count=%s",
        event_context.core_turn_id or "<missing>",
        history_turns,
        len(contexts),
        0,
    )
    capability_payload = _build_motion_static_capability_payload(
        bundle.runtime_state, include_materials=False,
    )
    capability = _build_motion_capability_prompt_payload(capability_payload)
    axes = {axis["id"]: axis for axis in capability.get("axes", [])}
    resolution = resolve_expression_examples(bundle.runtime_state, axes, current_user_text)
    examples = [{"speech": item["assistant_text"], "output": item["output"]}
                for item in resolution["examples"]]
    runtime_payload = {"reference_examples": examples}
    reference_diagnostics = resolution["diagnostics"]
    _record_motion_prompt_reference_observation(
        bundle=bundle,
        event=event,
        capability_payload=capability_payload,
        runtime_payload=runtime_payload,
        reference_diagnostics=reference_diagnostics,
        source_route="independent_provider",
    )
    runtime_payload["recent_executed_motions"] = _resolve_prompt_motion_history(bundle.turn_coordinator)[-3:]
    return IndependentMotionContext(
        current_user_text=current_user_text,
        contexts=contexts,
        capability_payload=capability_payload,
        runtime_payload=runtime_payload,
        reference_diagnostics=tuple(reference_diagnostics),
        persona_guidance=get_interaction_persona_prompt_projection(event),
    )


async def generate_independent_motion_for_segments(
    event: Any,
    bundle: _MotionRuntimeBundle,
    *,
    speech_segments: tuple[str, ...],
    parallel: bool,
    tasks: set[asyncio.Task],
    persona_result_id: str | None = None,
    segment_intents: tuple[dict[str, Any], ...] = (),
    segments_by_index: dict[int, PersonaSegmentState] | None = None,
    prepared_context: IndependentMotionContext | None = None,
    shadow_tasks: set[asyncio.Task[Any]] | None = None,
) -> dict[int, IndependentMotionResult]:
    """Generate one Provider result for each speech or explicit intent segment."""
    started = perf_counter()
    inputs = [
        (index, speech)
        for index, speech in enumerate(speech_segments)
        if speech.strip() or (index < len(segment_intents) and segment_intents[index])
    ]
    if not inputs:
        return {}

    provider = getattr(
        bundle.runtime_state,
        "selected_independent_motion_provider",
        None,
    )
    if provider is None:
        return {
            index: IndependentMotionResult(
                assistant_text=speech,
                motion_payload=None,
                reason="provider_unavailable",
                image_count=0,
            )
            for index, speech in inputs
        }

    try:
        segment_timeout_seconds = max(
            0.0,
            min(
                float(
                    getattr(
                        bundle.runtime_state,
                        "independent_motion_segment_timeout_seconds",
                        _DEFAULT_SEGMENT_TIMEOUT_SECONDS,
                    )
                ),
                60.0,
            ),
        )
    except (TypeError, ValueError):
        segment_timeout_seconds = _DEFAULT_SEGMENT_TIMEOUT_SECONDS
    event_context = resolve_adapter_event_context(event)
    stream_active = event_context.persona_segment_stream_active
    stream_deadlines: dict[int, float] = {}
    if stream_active:
        configured_timeout = segment_timeout_seconds
        segment_timeout_seconds = resolve_stream_motion_budget_seconds(
            bundle.runtime_state, event=event,
        )
        if segment_timeout_seconds < configured_timeout:
            logger.debug(
                "WIRING independent_motion.stream_timeout_capped "
                "turn_id=%s configured_seconds=%.2f effective_seconds=%.2f",
                event_context.core_turn_id or "<missing>",
                configured_timeout,
                segment_timeout_seconds,
            )
        stream_deadlines = {
            index: monotonic() + segment_timeout_seconds for index, _ in inputs
        }

    shared_context = prepared_context
    if shared_context is None:
        try:
            context_preparation = _prepare_independent_motion_context(
                event,
                bundle,
            )
            if stream_active:
                remaining = min(stream_deadlines.values()) - monotonic()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                shared_context = await await_with_hard_deadline(
                    context_preparation,
                    remaining,
                    background_tasks=tasks,
                )
            elif segment_timeout_seconds > 0:
                shared_context = await await_with_hard_deadline(
                    context_preparation,
                    segment_timeout_seconds,
                    background_tasks=tasks,
                )
            else:
                shared_context = await context_preparation
        except asyncio.TimeoutError:
            logger.warning(
                "WIRING independent_motion.shared_context_timeout turn_id=%s "
                "timeout_seconds=%.2f",
                event_context.core_turn_id or "<missing>",
                segment_timeout_seconds,
            )
            return {
                index: IndependentMotionResult(
                    assistant_text=speech,
                    motion_payload=None,
                    reason="motion_timeout",
                    image_count=0,
                )
                for index, speech in inputs
            }
        except Exception as exc:  # noqa: BLE001
            turn_id = event_context.core_turn_id or "<missing>"
            logger.warning(
                "WIRING independent_motion.shared_context_unavailable turn_id=%s "
                "error=%s; falling back to per-segment preparation",
                turn_id or "<missing>",
                exc,
                exc_info=True,
            )
            if stream_active:
                return {
                    index: IndependentMotionResult(
                        assistant_text=speech,
                        motion_payload=None,
                        reason="motion_context_unavailable",
                        image_count=0,
                    )
                    for index, speech in inputs
                }
            shared_context = None

    try:
        max_concurrency = max(
            1,
            min(
                int(
                    getattr(
                        bundle.runtime_state,
                        "independent_motion_max_concurrency",
                        _DEFAULT_SEGMENT_MAX_CONCURRENCY,
                    )
                ),
                8,
            ),
        )
    except (TypeError, ValueError):
        max_concurrency = _DEFAULT_SEGMENT_MAX_CONCURRENCY
    concurrency_gate = asyncio.Semaphore(max_concurrency if parallel else 1)

    async def _run_one(
        index: int,
        speech: str,
        *,
        context_override: IndependentMotionContext | None = None,
    ) -> IndependentMotionResult:
        async with concurrency_gate:
            try:
                async def _call_provider() -> IndependentMotionResult:
                    kwargs: dict[str, Any] = {
                        "provider": provider,
                        "assistant_text": speech,
                        "segment_intent": segment_intents[index] if index < len(segment_intents) else {},
                    }
                    # Whole-result Persona callbacks may contain multiple
                    # speech segments. Only the per-segment streaming callback
                    # supplies incremental identity to the Provider request.
                    if persona_result_id is not None or stream_active:
                        kwargs["persona_result_id"] = persona_result_id
                        kwargs["segment_index"] = index
                    prepared_context_for_segment = context_override or shared_context
                    if prepared_context_for_segment is not None:
                        kwargs["prepared_context"] = prepared_context_for_segment
                    if shadow_tasks is not None:
                        kwargs["shadow_tasks"] = shadow_tasks
                    return await generate_independent_motion(
                        event,
                        bundle,
                        **kwargs,
                    )

                if stream_active:
                    remaining = stream_deadlines[index] - monotonic()
                    if remaining <= 0:
                        raise asyncio.TimeoutError
                    return await await_with_hard_deadline(
                        _call_provider(),
                        remaining,
                        background_tasks=tasks,
                    )
                if segment_timeout_seconds > 0:
                    return await await_with_hard_deadline(
                        _call_provider(),
                        segment_timeout_seconds,
                        background_tasks=tasks,
                    )
                return await _call_provider()
            except asyncio.TimeoutError:
                turn_id = event_context.core_turn_id or "<missing>"
                logger.warning(
                    "WIRING independent_motion.segment_timeout turn_id=%s "
                    "segment_index=%s timeout_seconds=%.2f",
                    turn_id or "<missing>",
                    index,
                    segment_timeout_seconds,
                )
                return IndependentMotionResult(
                    assistant_text=speech,
                    motion_payload=None,
                    reason="motion_timeout",
                    image_count=0,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                turn_id = event_context.core_turn_id or "<missing>"
                logger.warning(
                    "WIRING independent_motion.segment_failed turn_id=%s "
                    "segment_index=%s error=%s action=continue_core_dialogue",
                    turn_id or "<missing>",
                    index,
                    exc,
                    exc_info=True,
                )
                return IndependentMotionResult(
                    assistant_text=speech,
                    motion_payload=None,
                    reason="motion_failed:" + type(exc).__name__,
                    image_count=0,
                )

    def _create_one(
        index: int,
        speech: str,
        *,
        context_override: IndependentMotionContext | None = None,
    ) -> asyncio.Task[IndependentMotionResult]:
        task = asyncio.create_task(
            _run_one(index, speech, context_override=context_override),
            name=f"ag99live-independent-motion-segment-{index}",
        )

        tasks.add(task)
        task.add_done_callback(tasks.discard)
        segment_state = (
            segments_by_index.get(index)
            if segments_by_index is not None
            else None
        )
        future = segment_state.result_future if segment_state is not None else None
        if future is not None:

            def publish(completed):
                if future.done():
                    return
                if completed.cancelled():
                    future.cancel()
                elif completed.exception() is not None:
                    future.set_exception(completed.exception())
                else:
                    result = completed.result()
                    future.set_result(result)

            task.add_done_callback(publish)
        return task

    results: dict[int, IndependentMotionResult] = {}
    # A multi-segment batch must hand the prior planned posture to the next
    # request. Preserve parallel generation for independent batches, but do not
    # let a Persona segment race past its predecessor when shared context exists.
    continuity_required = len(inputs) > 1 and shared_context is not None
    # A streamed Persona segment is submitted as a one-item batch with a
    # prepared context.  Running that item inline avoids an extra task hop
    # between the segment-ready hook and the Provider request.  That hop can
    # otherwise lose the event-loop race to full-file TTS materialization.
    if len(inputs) == 1 and shared_context is not None:
        index, speech = inputs[0]
        results[index] = await _run_one(index, speech)
    elif parallel and not continuity_required:
        indexed_tasks = [
            (index, _create_one(index, speech))
            for index, speech in inputs
        ]
        generated = await asyncio.gather(
            *(task for _, task in indexed_tasks)
        )
        results.update(
            (index, result)
            for (index, _), result in zip(indexed_tasks, generated)
        )
    else:
        continuity_context = shared_context
        for index, speech in inputs:
            result = await _create_one(
                index,
                speech,
                context_override=continuity_context,
            )
            results[index] = result
            if continuity_context is not None and result.motion_payload is not None:
                continuity_context = _append_planned_motion_context(
                    continuity_context,
                    result.motion_payload,
                )
    logger.info(
        "WIRING independent_motion.segment_generation_completed mode=%s "
        "continuity=%s input_count=%s result_count=%s payload_count=%s max_concurrency=%s "
        "timeout_seconds=%.2f turn_id=%s duration_ms=%.2f",
        "serial_continuity" if continuity_required else "parallel" if parallel else "serial",
        continuity_required,
        len(inputs),
        len(results),
        sum(result.motion_payload is not None for result in results.values()),
        max_concurrency,
        segment_timeout_seconds,
        event_context.core_turn_id or "<missing>",
        (perf_counter() - started) * 1000,
    )
    return results


async def generate_independent_motion(
    event: Any,
    bundle: _MotionRuntimeBundle,
    *,
    provider: Any,
    assistant_text: str,
    prepared_context: IndependentMotionContext | None = None,
    segment_intent: Mapping[str, Any] | None = None,
    persona_result_id: str | None = None,
    segment_index: int | None = None,
    segment_message_id: str | None = None,
    shadow: bool = False,
    shadow_timeout_seconds: float = 5.0,
    shadow_tasks: set[asyncio.Task[Any]] | None = None,
    shadow_emotion: dict[str, Any] | None = None,
) -> IndependentMotionResult:
    images: list[str] = []
    motion_request_id = uuid4().hex
    generation_started = perf_counter()
    event_context = resolve_adapter_event_context(event)
    turn_id = event_context.core_turn_id or "<missing>"
    provider_id = str(
        getattr(
            bundle.runtime_state,
            "independent_motion_shadow_provider_id"
            if shadow
            else "independent_motion_provider_id",
            "<missing>",
        )
        or "<missing>"
    )
    mode = (
        "parallel"
        if bool(getattr(bundle.runtime_state, "independent_motion_parallel", False))
        else "serial"
    )
    sample_input_context: dict[str, Any] = {
        "user_text": _dialogue_text(str(getattr(event, "message_str", "") or "")),
        "recent_context": [],
        "motion_request": {
            "provider_id": provider_id,
            "candidate_role": "shadow" if shadow else "primary",
            "state": "not_prepared",
        },
    }
    sample_raw_output: Any = None
    provider_elapsed_ms: float | None = None
    provider_started_at_epoch_ms: int | None = None
    provider_update_index = 0
    stream_active = event_context.persona_segment_stream_active

    def record_sample(
        *,
        stage: str,
        record_key: str,
        motion_payload: dict[str, Any] | None,
        status: str,
        reason: str,
        raw_output: Any,
        provider_final: bool,
        provider_update_index: int | None = None,
    ) -> None:
        if not persona_result_id or type(segment_index) is not int:
            return
        segment_snapshot: dict[str, Any] = {
            "speech": assistant_text,
            "speech_state": (
                "not_yet_ready"
                if stream_active and not assistant_text
                else "ready"
            ),
        }
        if isinstance(segment_intent, Mapping):
            actions = segment_intent.get("actions")
            tendency = segment_intent.get("tendency")
            segment_snapshot["actions"] = (
                list(actions) if isinstance(actions, (list, tuple)) else []
            )
            segment_snapshot["tendency"] = (
                dict(tendency) if isinstance(tendency, Mapping) else {}
            )
        motion_output = {
            "raw_output": raw_output,
            "accepted_payload": motion_payload,
            "status": status,
            "reason": reason,
            "motion_request_id": motion_request_id,
            "provider_id": provider_id,
            "provider_final": provider_final,
            "candidate_role": "shadow" if shadow else "primary",
            "generation_elapsed_ms": round(
                (perf_counter() - generation_started) * 1000,
                1,
            ),
            "provider_elapsed_ms": provider_elapsed_ms,
            "provider_started_at_epoch_ms": provider_started_at_epoch_ms,
        }
        if provider_update_index is not None:
            motion_output["provider_update_index"] = provider_update_index
        record_persona_motion_sample(
            getattr(bundle.runtime_state, "motion_lab_recorder", None),
            turn_id=str(turn_id),
            core_turn_id=resolve_persona_core_turn_id(event),
            delivery_turn_id=resolve_adapter_event_context(event).delivery_turn_id,
            persona_result_id=persona_result_id,
            segment_index=segment_index,
            segment_count=None,
            segment_message_id=segment_message_id,
            source_route="independent_motion",
            delivery_mode=resolve_persona_delivery_mode(event),
            record_stage=stage,
            record_key=record_key,
            input_context=sample_input_context,
            persona_segment=segment_snapshot,
            motion=motion_output,
        )

    def finish(
        *,
        motion_payload: dict[str, Any] | None,
        reason: str,
        image_count: int,
    ) -> IndependentMotionResult:
        result = IndependentMotionResult(
            assistant_text=assistant_text,
            motion_payload=motion_payload,
            reason=reason,
            image_count=image_count,
        )
        record_sample(
            stage="motion_candidate" if shadow else "motion_result",
            record_key=(
                f"shadow-result:{motion_request_id}"
                if shadow
                else f"result:{motion_request_id}"
            ),
            motion_payload=motion_payload,
            status=(
                "expression_hold" if reason == "expression_hold" else
                "shadow_provider_normalized"
                if shadow and motion_payload is not None
                else "shadow_provider_failed"
                if shadow
                else "provider_normalized"
                if motion_payload is not None
                else "provider_failed"
            ),
            reason=reason,
            raw_output=sample_raw_output,
            provider_final=not shadow,
            provider_update_index=0 if shadow else None,
        )
        logger.info(
            "DIAG latency.motion_result_ready turn_id=%s motion_request_id=%s "
            "persona_result_id=%s segment_index=%s payload_present=%s reason=%s "
            "elapsed_ms=%.1f timestamp_epoch_ms=%s",
            turn_id,
            motion_request_id,
            persona_result_id or "<none>",
            segment_index,
            motion_payload is not None,
            reason,
            (perf_counter() - generation_started) * 1000,
            time_ns() // 1_000_000,
        )
        logger.debug(
            "WIRING independent_motion.generation_completed turn_id=%s "
            "mode=%s provider=%s payload_present=%s reason=%s image_count=%s "
            "assistant_text_len=%s",
            turn_id,
            mode,
            provider_id,
            motion_payload is not None,
            reason,
            image_count,
            len(assistant_text),
        )
        return result

    async def publish_completed_motion_record(raw_arguments: dict[str, Any]) -> None:
        """Validate and publish a closed JSON action before Provider EOF."""

        nonlocal provider_update_index

        if not stream_active or type(segment_index) is not int:
            return
        publish_motion = getattr(
            event,
            "publish_interaction_incremental_motion",
            None,
        )
        if not callable(publish_motion):
            return
        if not any(step["axis_values"] for step in raw_arguments["motion_steps"]):
            return
        try:
            motion_payload, reason = normalize_motion_arguments_payload(
                raw_arguments,
                bundle.runtime_state,
                base_reason="independent_provider_early",
                append_resolution_reason=_append_resolution_reason,
                sanitize_reason_fragment=_sanitize_reason_fragment,
            )
            if motion_payload is None:
                logger.warning(
                    "DIAG latency.motion_record_rejected turn_id=%s "
                    "segment_index=%s reason=%s",
                    turn_id,
                    segment_index,
                    reason,
                )
                return
            provider_update_index += 1
            record_sample(
                stage="motion_candidate",
                record_key=(
                    f"provider-preview:{motion_request_id}:{provider_update_index}"
                ),
                motion_payload=motion_payload,
                status="provider_preview",
                reason=reason,
                raw_output=dict(raw_arguments),
                provider_final=False,
                provider_update_index=provider_update_index,
            )
            accepted = await publish_motion(
                persona_result_id=persona_result_id,
                segment_index=segment_index,
                motion_payload=motion_payload,
                reason=reason,
                final=False,
            )
            if accepted:
                logger.info(
                    "DIAG latency.motion_record_ready turn_id=%s "
                    "motion_request_id=%s persona_result_id=%s segment_index=%s "
                    "elapsed_ms=%.1f timestamp_epoch_ms=%s",
                    turn_id,
                    motion_request_id,
                    persona_result_id or "<none>",
                    segment_index,
                    (perf_counter() - generation_started) * 1000,
                    time_ns() // 1_000_000,
                )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - early motion is supplementary output.
            logger.debug(
                "WIRING independent_motion.early_publish_failed turn_id=%s "
                "segment_index=%s",
                turn_id,
                segment_index,
                exc_info=True,
            )
    logger.debug(
        "WIRING independent_motion.generation_started turn_id=%s mode=%s "
        "provider=%s input_text_present=%s image_count=%s",
        turn_id,
        mode,
        provider_id,
        bool(str(getattr(event, "message_str", "") or "").strip()),
        len(images),
    )
    try:
        current_user_text = (
            prepared_context.current_user_text
            if prepared_context is not None
            else _dialogue_text(str(getattr(event, "message_str", "") or ""))
        )
        if (
            not current_user_text
            and not assistant_text.strip()
            and not segment_intent
        ):
            return finish(
                motion_payload=None,
                reason="current_input_missing",
                image_count=0,
            )

        if prepared_context is None:
            prepared_context = await _prepare_independent_motion_context(event, bundle)
        contexts = list(prepared_context.contexts)
        capability_payload = prepared_context.capability_payload
        runtime_payload = prepared_context.runtime_payload

        trained = uses_trained_expression_prompt(provider, provider_id)
        neurobrain_state = shadow_emotion
        if not shadow and segment_intent is not None:
            neurobrain_state = read_motion_emotion(
                bundle.runtime_state, event_context.delivery_turn_id or event_context.core_turn_id,
            )
        capability = _build_motion_capability_prompt_payload(capability_payload)
        if trained:
            system_prompt, prompt = build_trained_expression_prompts(
                capability.get("axes", []), current_user_text, assistant_text, segment_intent,
            )
        else:
            system_prompt = _build_independent_system_prompt(
                capability=capability,
                persona_guidance=prepared_context.persona_guidance,
            )
            prompt = _build_current_turn_prompt(
                current_user_text=current_user_text,
                assistant_text=assistant_text,
                speech_ms_per_han_char=getattr(
                    bundle.runtime_state,
                    "independent_motion_speech_ms_per_han_char",
                    DEFAULT_SPEECH_MS_PER_HAN_CHAR,
                ),
                segment_intent=segment_intent,
                neurobrain_state=neurobrain_state,
                motion_guidance=_motion_guidance_for_prompt(
                    capability,
                    runtime_payload,
                ),
            )
        expected_transport = (
            "stream" if supports_text_chat_stream(provider) else "unsupported"
        )
        sample_input_context = {
            "user_text": current_user_text,
            "recent_context": contexts,
            "motion_request": {
                "motion_request_id": motion_request_id,
                "provider_id": provider_id,
                "candidate_role": "shadow" if shadow else "primary",
                "prompt": prompt,
                "system_prompt": system_prompt,
                "prompt_format": "trained_weighted" if trained else "timed_manual",
                "training_axes": [
                    {k: axis[k] for k in ("id", "negative_semantics", "positive_semantics", "value_range", "neutral") if k in axis}
                    for axis in capability.get("axes", [])
                ],
                "neurobrain_state": None if trained else neurobrain_state,
                "runtime_references": {} if trained else runtime_payload,
                "transport": expected_transport,
                "image_count": len(images),
                "image_payloads_persisted": False,
            },
        }
        logger.info(
            "DIAG latency.motion_provider_request_started turn_id=%s "
            "motion_request_id=%s persona_result_id=%s segment_index=%s "
            "transport=%s history_message_count=%s image_count=%s "
            "prompt_len=%s system_prompt_len=%s timestamp_epoch_ms=%s",
            turn_id,
            motion_request_id,
            persona_result_id or "<none>",
            segment_index,
            expected_transport,
            len(contexts),
            len(images),
            len(prompt),
            len(system_prompt),
            time_ns() // 1_000_000,
        )
        record_sample(
            stage="motion_request",
            record_key=f"request:{motion_request_id}",
            motion_payload=None,
            status="requested",
            reason="provider_request_started",
            raw_output=None,
            provider_final=False,
        )

        if (
            not shadow
            and bool(
                getattr(
                    bundle.runtime_state,
                    "independent_motion_shadow_enabled",
                    False,
                )
            )
        ):
            shadow_provider = getattr(
                bundle.runtime_state,
                "selected_independent_motion_shadow_provider",
                None,
            )
            shadow_provider_id = str(
                getattr(
                    bundle.runtime_state,
                    "independent_motion_shadow_provider_id",
                    "",
                )
                or ""
            ).strip()
            primary_provider_id = str(
                getattr(bundle.runtime_state, "independent_motion_provider_id", "")
                or ""
            ).strip()
            if (
                shadow_provider is not None
                and shadow_provider_id
                and shadow_provider_id != primary_provider_id
            ):
                try:
                    shadow_timeout_seconds = max(
                        0.5,
                        min(
                            float(
                                getattr(
                                    bundle.runtime_state,
                                    "independent_motion_shadow_timeout_seconds",
                                    5.0,
                                )
                            ),
                            60.0,
                        ),
                    )
                except (TypeError, ValueError):
                    shadow_timeout_seconds = 5.0
                shadow_task = asyncio.create_task(
                    generate_independent_motion(
                        event,
                        bundle,
                        provider=shadow_provider,
                        assistant_text=assistant_text,
                        prepared_context=prepared_context,
                        segment_intent=segment_intent,
                        persona_result_id=persona_result_id,
                        segment_index=segment_index,
                        segment_message_id=segment_message_id,
                        shadow=True,
                        shadow_timeout_seconds=shadow_timeout_seconds,
                        shadow_emotion=neurobrain_state,
                    ),
                    name=f"ag99live-motion-shadow-{motion_request_id[:12]}",
                )
                if shadow_tasks is not None:
                    shadow_tasks.add(shadow_task)
                    shadow_task.add_done_callback(shadow_tasks.discard)
                shadow_task.add_done_callback(_consume_background_motion_exception)
                logger.info(
                    "DIAG motion.shadow_request_started turn_id=%s "
                    "motion_request_id=%s persona_result_id=%s segment_index=%s "
                    "provider=%s timestamp_epoch_ms=%s",
                    turn_id,
                    motion_request_id,
                    persona_result_id or "<none>",
                    segment_index,
                    shadow_provider_id,
                    time_ns() // 1_000_000,
                )
        provider_started_at_epoch_ms = time_ns() // 1_000_000
        provider_started = perf_counter()
        provider_request = _request_motion_provider_text(
            provider,
            prompt=prompt,
            system_prompt=system_prompt,
            contexts=contexts or None,
            turn_id=str(turn_id),
            motion_request_id=motion_request_id,
            persona_result_id=persona_result_id,
            segment_index=segment_index,
            on_complete_json=(None if shadow or trained else publish_completed_motion_record),
        )
        if shadow:
            response_text, transport = await asyncio.wait_for(
                provider_request,
                timeout=shadow_timeout_seconds,
            )
        else:
            response_text, transport = await provider_request
        provider_elapsed_ms = round((perf_counter() - provider_started) * 1000, 1)
        sample_raw_output = response_text
        logger.debug(
            "WIRING independent_motion.provider_response_received turn_id=%s "
            "response_len=%s transport=%s",
            turn_id,
            len(response_text),
            transport,
        )
        if not response_text:
            return finish(
                motion_payload=None,
                reason="provider_response_empty",
                image_count=len(images),
            )
        try:
            raw_arguments = (
                trained_expression_record(response_text) if trained
                else expression_record(json.loads(response_text))
            )
            sample_raw_output = {
                "provider_text": response_text,
                "parsed_arguments": raw_arguments,
            }
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            logger.warning(
                "WIRING independent_motion.json_parse_failed turn_id=%s "
                "motion_request_id=%s error=%s parse_position=%s "
                "response_len=%s response_preview=%r response_truncated=%s",
                turn_id,
                motion_request_id,
                type(exc).__name__,
                getattr(exc, "pos", None),
                len(response_text),
                response_text[:256],
                len(response_text) > 256,
            )
            return finish(
                motion_payload=None,
                reason="json_parse_failed:" + type(exc).__name__,
                image_count=len(images),
            )
        shape_summary = _motion_output_shape_summary(raw_arguments)
        logger.debug(
            "WIRING independent_motion.json_parsed turn_id=%s field_count=%s "
            "shape=%s root_axis_count=%s step_count=%s step_axis_counts=%s "
            "unique_axis_count=%s",
            turn_id,
            len(raw_arguments),
            shape_summary["shape"],
            shape_summary["root_axis_count"],
            shape_summary["step_count"],
            ",".join(
                str(value)
                for value in shape_summary["step_axis_counts"]
            ),
            shape_summary["unique_axis_count"],
        )
        if not any(step["axis_values"] for step in raw_arguments["motion_steps"]):
            return finish(motion_payload=None, reason="expression_hold", image_count=len(images))
        motion_payload, reason = normalize_motion_arguments_payload(
            raw_arguments,
            bundle.runtime_state,
            base_reason="independent_provider",
            append_resolution_reason=_append_resolution_reason,
            sanitize_reason_fragment=_sanitize_reason_fragment,
        )
        if motion_payload is None:
            shape_summary = _motion_output_shape_summary(raw_arguments)
            logger.warning(
                "WIRING independent_motion.normalization_failed turn_id=%s "
                "reason=%s shape=%s root_axis_count=%s step_count=%s "
                "step_axis_counts=%s unique_axis_count=%s",
                turn_id,
                reason,
                shape_summary["shape"],
                shape_summary["root_axis_count"],
                shape_summary["step_count"],
                ",".join(str(value) for value in shape_summary["step_axis_counts"]),
                shape_summary["unique_axis_count"],
            )
            return finish(
                motion_payload=None,
                reason=reason,
                image_count=len(images),
            )
        logger.debug(
            "WIRING independent_motion.normalization_succeeded turn_id=%s "
            "reason=%s",
            turn_id,
            reason,
        )
        return finish(
            motion_payload=motion_payload,
            reason=reason,
            image_count=len(images),
        )
    except TextChatStreamUnavailable as exc:
        logger.warning(
            "WIRING independent_motion.skipped turn_id=%s provider=%s reason=%s",
            turn_id,
            provider_id,
            exc,
        )
        return finish(
            motion_payload=None,
            reason="provider_stream_unsupported",
            image_count=len(images),
        )
    except TextChatStreamOutputTooLarge as exc:
        logger.warning(
            "WIRING independent_motion.skipped turn_id=%s provider=%s reason=%s",
            turn_id,
            provider_id,
            exc,
        )
        return finish(
            motion_payload=None,
            reason="provider_output_too_large",
            image_count=len(images),
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "WIRING independent_motion.failed turn_id=%s provider=%s error=%s",
            turn_id,
            provider_id,
            exc,
            exc_info=True,
        )
        return finish(
            motion_payload=None,
            reason="independent_provider_failed:" + type(exc).__name__,
            image_count=len(images),
        )


async def _load_recent_history(
    event: Any,
    bundle: _MotionRuntimeBundle,
    *,
    history_turns: int,
    current_user_text: str,
) -> list[dict[str, str]]:
    if history_turns <= 0:
        return []
    plugin_context = getattr(bundle.runtime_state, "plugin_context", None)
    conversation_manager = getattr(plugin_context, "conversation_manager", None)
    if conversation_manager is None:
        return []
    try:
        origin = str(getattr(event, "unified_msg_origin", "") or "").strip()
        if not origin:
            return []
        conversation_id = await conversation_manager.get_curr_conversation_id(origin)
        if not conversation_id:
            return []
        conversation = await conversation_manager.get_conversation(origin, conversation_id)
        history = getattr(conversation, "history", None)
        if isinstance(history, str):
            history = json.loads(history)
        if isinstance(history, Mapping):
            history = history.get("messages", history.get("history", []))
        if not isinstance(history, list):
            return []

        rounds = _group_history_rounds(history)
        if rounds and current_user_text:
            current_round_user = rounds[-1][0]["content"]
            if current_round_user == current_user_text:
                rounds.pop()
        contexts = [message for turn in rounds[-history_turns:] for message in turn]
        logger.debug(
            "WIRING independent_motion.history_resolved turn_id=%s "
            "round_count=%s message_count=%s",
            resolve_adapter_event_context(event).core_turn_id or "<missing>",
            min(len(rounds), history_turns),
            len(contexts),
        )
        return contexts
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "WIRING independent_motion.history_unavailable turn_id=%s error=%s",
            resolve_adapter_event_context(event).core_turn_id or "<missing>",
            exc,
        )
        return []


def _group_history_rounds(history: list[Any]) -> list[list[dict[str, str]]]:
    rounds: list[list[dict[str, str]]] = []
    current_round: list[dict[str, str]] = []
    for raw_message in history:
        if not isinstance(raw_message, Mapping):
            continue
        role = str(raw_message.get("role") or "").strip().lower()
        content = _history_message_text(raw_message.get("content"))
        if role == "user":
            if current_round:
                rounds.append(current_round)
            current_round = [{"role": role, "content": content}]
        elif role == "assistant" and current_round:
            current_round.append({"role": role, "content": content})
    if current_round:
        rounds.append(current_round)
    return [turn for turn in rounds if any(message["content"] for message in turn)]


def _history_message_text(value: Any) -> str:
    if isinstance(value, str):
        return _dialogue_text(value)
    if isinstance(value, list):
        fragments = []
        for part in value:
            if isinstance(part, str):
                fragments.append(part)
            elif isinstance(part, Mapping):
                text = part.get("text")
                if isinstance(text, str) and str(part.get("type") or "text") == "text":
                    fragments.append(text)
        return _dialogue_text("\n".join(fragment.strip() for fragment in fragments if fragment.strip()))
    return ""


def _dialogue_text(value: str) -> str:
    """Remove the platform's screenshot wrapper, retaining dialogue text."""
    value = re.sub(
        r"^\s*\[系统上下文\].*?\[/系统上下文\]\s*(?:用户消息：\s*)?",
        "", value, flags=re.S,
    )
    return sanitize_assistant_output_text(value).strip()


def _build_current_turn_prompt(
    *,
    current_user_text: str,
    assistant_text: str,
    speech_ms_per_han_char: int,
    segment_intent: Mapping[str, Any] | None = None,
    neurobrain_state: Mapping[str, Any] | None = None,
    motion_guidance: Mapping[str, Any] | None = None,
) -> str:
    intent = segment_intent or {}
    payload: dict[str, Any] = {
        "user": current_user_text,
        "segment": {
            "speech": assistant_text,
            "actions": intent.get("actions", []),
            "tendency": intent.get("tendency", {}),
        },
    }
    han_chars = sum(
        char == "〇" or unicodedata.name(char, "").startswith(
            ("CJK UNIFIED IDEOGRAPH-", "CJK COMPATIBILITY IDEOGRAPH-")
        )
        for char in assistant_text
    )
    if han_chars:
        payload["segment"]["estimated_speech_ms"] = han_chars * speech_ms_per_han_char
    if isinstance(neurobrain_state, Mapping):
        payload["neurobrain_state"] = dict(neurobrain_state)
    if motion_guidance is not None:
        payload["motion_guidance"] = dict(motion_guidance)
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _build_independent_system_prompt(
    *,
    capability: dict[str, Any],
    persona_guidance: Mapping[str, Any] | None = None,
) -> str:
    axes = [
        describe_expression_axis(axis)
        for axis in capability.get("axes", []) if isinstance(axis, Mapping)
    ]
    prompt = (
        "为直播角色编排 segment.speech 这句台词的动作。actions 给出本段指定的动作意图；"
        "结合台词和 tendency 选择需要变化的部位。舞台上的主动作要让小画面里的观众看得清。\n"
        "参数说明：id 是输出时使用的轴名，description 说明它控制的部位和动作。"
        "数值是 value_range 内的目标位置。neutral 是该轴的自然姿态；"
        "数值减小时看 negative_semantics，增大时看 positive_semantics。"
        "若 neutral 就是最大值，从小值回到最大值表示解除该侧动作。\n"
        "按部位选轴：往旁边瞥用视线，转脸用头的朝向，歪头用头的侧倾；"
        "笑眼改变笑起来的眼形，眼睑开合改变眼睛睁开的程度。只选下表中该角色具有的轴。\n"
        f"只输出一个 JSON 数组，按播放顺序给出 1 至 {MAX_MOTION_STEPS} 步，总长至多 15000 毫秒。"
        "每步用正整数 ms 表示过渡到本步目标所用的毫秒数，把要改变的轴名和 ms 并列。"
        "同一步的轴一起过渡；例如要先看过去再转脸，就把视线和转头分在前后两步。"
        "首次写到一个轴才开始控制，之后省略该轴表示保持已有目标。只有 ms 的一步表示停留。"
        "estimated_speech_ms 仅供估算台词时长。"
        "\n可用轴：" + json.dumps(axes, ensure_ascii=False, separators=(",", ":"))
    )
    if persona_guidance:
        prompt += "\n人格参考：" + json.dumps(persona_guidance, ensure_ascii=False, separators=(",", ":"))
    return prompt


def _motion_guidance_for_prompt(capability: dict[str, Any], runtime: dict[str, Any]) -> dict[str, Any]:
    axes = {a["id"] for a in capability.get("axes", []) if isinstance(a, dict) and a.get("id")}
    recent = []
    for item in (runtime.get("recent_executed_motions") or [])[-3:]:
        pose = {}
        for step in item.get("motion_steps") or []:
            pose.update({k: v for k, v in step.get("axis_values", {}).items() if k in axes})
        if pose:
            recent.append(pose)
    return {"examples": runtime.get("reference_examples", []), "recent_end_poses": recent}


def _motion_output_shape(value: Mapping[str, Any]) -> str:
    if "motion_resource_id" in value:
        return "motion_resource"
    if "motion_steps" in value:
        return "motion_steps"
    return "missing"


def _motion_output_shape_summary(value: Mapping[str, Any]) -> dict[str, Any]:
    root_axis_ids: set[str] = set()
    raw_steps = value.get("motion_steps")
    step_axis_counts: list[int] = []
    unique_axis_ids = set(root_axis_ids)
    if isinstance(raw_steps, list):
        for raw_step in raw_steps:
            step_axes = (
                raw_step.get("axis_values")
                if isinstance(raw_step, Mapping)
                else None
            )
            if isinstance(step_axes, Mapping):
                step_ids = {
                    str(axis_id).strip()
                    for axis_id in step_axes
                    if str(axis_id).strip()
                }
                step_axis_counts.append(len(step_ids))
                unique_axis_ids.update(step_ids)
            else:
                step_axis_counts.append(0)
    return {
        "shape": _motion_output_shape(value),
        "root_axis_count": len(root_axis_ids),
        "step_count": len(raw_steps) if isinstance(raw_steps, list) else 0,
        "step_axis_counts": step_axis_counts,
        "unique_axis_count": len(unique_axis_ids),
    }


__all__ = [
    "IndependentMotionResult",
    "await_with_hard_deadline",
    "generate_independent_motion_for_segments",
    "generate_independent_motion",
    "is_persona_expression_request",
    "persona_expression_intent",
    "resolve_stream_motion_budget_seconds",
]
