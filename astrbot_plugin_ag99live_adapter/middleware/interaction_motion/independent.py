from __future__ import annotations

import asyncio
import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from time import monotonic, perf_counter, time_ns
from typing import Any
from uuid import uuid4

from astrbot.api import logger

from ...runtime.persona_lifecycle import PersonaSegmentState
from ...motion.observation import (
    record_persona_motion_sample,
    resolve_persona_core_turn_id,
    resolve_persona_delivery_mode,
)
from ...motion.output_sanitizer import sanitize_assistant_output_text
from ...motion.payload_validation import (
    normalize_motion_arguments_payload,
)
from ...motion.text_stream import (
    TextChatStreamUnavailable,
    read_text_chat_stream,
    supports_text_chat_stream,
)
from .prompt_builder import (
    _build_motion_capability_prompt_payload,
    _build_motion_runtime_payload,
    _build_motion_static_capability_payload,
)
from .prompt_context import (
    _record_motion_prompt_reference_observation,
    _resolve_prompt_motion_history,
)
from .prompt_references import _project_reference_examples_for_prompt
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


def _consume_background_motion_exception(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    error = task.exception()
    if error is not None:
        logger.warning(
            "WIRING independent_motion.background_task_failed error=%s",
            error,
        )


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


_NEUROBRAIN_EMOTION_KEYS = (
    "joy",
    "trust",
    "fear",
    "surprise",
    "sadness",
    "disgust",
    "anger",
    "anticipation",
)
_NEUROBRAIN_BEHAVIOR_KEYS = (
    "engagement",
    "avoidance",
    "expression",
    "exploration",
    "initiative",
    "activation",
)
_NEUROBRAIN_TENDENCY_KEYS = (
    "Joy",
    "Trust",
    "Fear",
    "Surprise",
    "Sadness",
    "Disgust",
    "Anger",
    "Anticipation",
)


def _project_neurobrain_state(snapshot: Any) -> dict[str, Any] | None:
    """Keep only bounded numeric state needed by the action generator."""

    if not isinstance(snapshot, Mapping):
        return None

    def _unit_mapping(value: Any, keys: tuple[str, ...]) -> dict[str, float]:
        if not isinstance(value, Mapping):
            return {}
        result: dict[str, float] = {}
        for key in keys:
            raw = value.get(key)
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                continue
            number = float(raw)
            if math.isfinite(number):
                result[key] = max(0.0, min(1.0, number))
        return result

    def _tendency_mapping(value: Any) -> dict[str, int]:
        if not isinstance(value, Mapping):
            return {}
        result: dict[str, int] = {}
        for key in _NEUROBRAIN_TENDENCY_KEYS:
            raw = value.get(key)
            if isinstance(raw, bool) or not isinstance(raw, int):
                continue
            result[key] = max(0, min(10, raw))
        return result

    emotion = _unit_mapping(snapshot.get("emotion"), _NEUROBRAIN_EMOTION_KEYS)
    behavior = _unit_mapping(snapshot.get("behavior"), _NEUROBRAIN_BEHAVIOR_KEYS)
    tendency = _tendency_mapping(snapshot.get("last_tendency"))
    if not emotion and not behavior and not tendency:
        return None

    raw_step = snapshot.get("step")
    step = raw_step if isinstance(raw_step, int) and not isinstance(raw_step, bool) else 0
    return {
        "step": max(0, step),
        "emotion": emotion,
        "behavior": behavior,
        "last_tendency": tendency,
    }


def _read_neurobrain_state(bundle: _MotionRuntimeBundle) -> dict[str, Any] | None:
    """Read current state immediately, independently of input processing."""
    context = getattr(bundle.runtime_state, "plugin_context", None)
    get_registered_star = getattr(context, "get_registered_star", None)
    if not callable(get_registered_star):
        return None
    try:
        metadata = get_registered_star("astrbot_plugin_neurobrain")
        plugin = getattr(metadata, "star_cls", None)
        if plugin is None or not bool(getattr(plugin, "enabled", True)):
            return None
        readonly_api = getattr(plugin, "readonly_api", None)
        get_state = getattr(readonly_api, "get_state", None)
        if not callable(get_state):
            return None
        snapshot = get_state()
    except Exception as exc:  # noqa: BLE001
        logger.debug("NeuroBrain state unavailable to motion provider: %s", exc)
        return None
    return _project_neurobrain_state(snapshot)


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


async def _prepare_independent_motion_context(
    event: Any,
    bundle: _MotionRuntimeBundle,
) -> IndependentMotionContext | None:
    """Build one stable context snapshot for all segments in a turn."""
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
    logger.debug(
        "WIRING independent_motion.shared_context_prepared turn_id=%s "
        "requested_turns=%s message_count=%s image_count=%s",
        (
            event.get_extra("_turn_id")
            if callable(getattr(event, "get_extra", None))
            else "<missing>"
        )
        or "<missing>",
        history_turns,
        len(contexts),
        0,
    )
    capability_payload = _build_motion_static_capability_payload(
        bundle.runtime_state
    )
    runtime_payload, reference_diagnostics = _build_motion_runtime_payload(
        event,
        bundle.turn_coordinator,
        bundle.runtime_state,
        capability_payload=capability_payload,
    )
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
    get_extra = getattr(event, "get_extra", None)
    stream_active = bool(
        get_extra("_interaction_persona_segment_stream_active", False)
        if callable(get_extra)
        else False
    )
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
                get_extra("_turn_id", "<missing>")
                if callable(get_extra)
                else "<missing>",
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
                get_extra("_turn_id", "<missing>")
                if callable(get_extra)
                else "<missing>",
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
            get_extra = getattr(event, "get_extra", None)
            turn_id = (
                get_extra("_turn_id")
                if callable(get_extra)
                else "<missing>"
            )
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
                    if shared_context is not None:
                        kwargs["prepared_context"] = shared_context
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
                get_extra = getattr(event, "get_extra", None)
                turn_id = (
                    get_extra("_turn_id")
                    if callable(get_extra)
                    else "<missing>"
                )
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
                get_extra = getattr(event, "get_extra", None)
                turn_id = get_extra("_turn_id", "<missing>") if callable(get_extra) else "<missing>"
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
    ) -> asyncio.Task[IndependentMotionResult]:
        task = asyncio.create_task(
            _run_one(index, speech),
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
                    segment_state.provider_result = result
                    future.set_result(result)

            task.add_done_callback(publish)
        return task

    results: dict[int, IndependentMotionResult] = {}
    # A streamed Persona segment is submitted as a one-item batch with a
    # prepared context.  Running that item inline avoids an extra task hop
    # between the segment-ready hook and the Provider request.  That hop can
    # otherwise lose the event-loop race to full-file TTS materialization.
    if len(inputs) == 1 and shared_context is not None:
        index, speech = inputs[0]
        results[index] = await _run_one(index, speech)
    elif parallel:
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
        for index, speech in inputs:
            result = await _create_one(index, speech)
            results[index] = result
    logger.info(
        "WIRING independent_motion.segment_generation_completed mode=%s "
        "input_count=%s result_count=%s payload_count=%s max_concurrency=%s "
        "timeout_seconds=%.2f turn_id=%s duration_ms=%.2f",
        "parallel" if parallel else "serial",
        len(inputs),
        len(results),
        sum(result.motion_payload is not None for result in results.values()),
        max_concurrency,
        segment_timeout_seconds,
        event.get_extra("_turn_id") if callable(getattr(event, "get_extra", None)) else "<missing>",
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
) -> IndependentMotionResult:
    images: list[str] = []
    motion_request_id = uuid4().hex
    generation_started = perf_counter()
    turn_id = event.get_extra("_turn_id") or "<missing>"
    provider_id = getattr(bundle.runtime_state, "independent_motion_provider_id", "<missing>")
    mode = (
        "parallel"
        if bool(getattr(bundle.runtime_state, "independent_motion_parallel", False))
        else "serial"
    )
    sample_input_context: dict[str, Any] = {
        "user_text": _dialogue_text(str(getattr(event, "message_str", "") or "")),
        "recent_context": [],
        "motion_request": {"provider_id": provider_id, "state": "not_prepared"},
    }
    sample_raw_output: Any = None
    provider_update_index = 0
    get_extra = getattr(event, "get_extra", None)
    stream_active = bool(
        get_extra("_interaction_persona_segment_stream_active", False)
        if callable(get_extra)
        else False
    )

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
        }
        if provider_update_index is not None:
            motion_output["provider_update_index"] = provider_update_index
        record_persona_motion_sample(
            getattr(bundle.runtime_state, "motion_lab_recorder", None),
            turn_id=str(turn_id),
            core_turn_id=resolve_persona_core_turn_id(event),
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
            stage="motion_result",
            record_key=f"result:{motion_request_id}",
            motion_payload=motion_payload,
            status=(
                "provider_normalized"
                if motion_payload is not None
                else "provider_failed"
            ),
            reason=reason,
            raw_output=sample_raw_output,
            provider_final=True,
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
        unknown_fields = sorted(
            set(raw_arguments)
            - {
                "intent_tags",
                "axis_levels",
                "motion_steps",
                "duration_hint_ms",
                "expression_resource_id",
                "motion_resource_id",
            }
        )
        if unknown_fields:
            logger.warning(
                "DIAG latency.motion_record_rejected turn_id=%s "
                "segment_index=%s reason=unknown_output_fields",
                turn_id,
                segment_index,
            )
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
            history_turns = max(
                0,
                min(
                    int(
                        getattr(
                            bundle.runtime_state,
                            "independent_motion_history_turns",
                            6,
                        )
                    ),
                    20,
                ),
            )
            contexts = await _load_recent_history(
                event,
                bundle,
                history_turns=history_turns,
                current_user_text=current_user_text,
            )
            logger.debug(
                "WIRING independent_motion.history_loaded turn_id=%s "
                "requested_turns=%s message_count=%s",
                turn_id,
                history_turns,
                len(contexts),
            )
            capability_payload = _build_motion_static_capability_payload(
                bundle.runtime_state
            )
            runtime_payload, reference_diagnostics = _build_motion_runtime_payload(
                event,
                bundle.turn_coordinator,
                bundle.runtime_state,
                capability_payload=capability_payload,
            )
            _record_motion_prompt_reference_observation(
                bundle=bundle,
                event=event,
                capability_payload=capability_payload,
                runtime_payload=runtime_payload,
                reference_diagnostics=reference_diagnostics,
                source_route="independent_provider",
            )
            runtime_payload["recent_executed_motions"] = _resolve_prompt_motion_history(bundle.turn_coordinator)[-3:]
        else:
            contexts = prepared_context.contexts
            capability_payload = prepared_context.capability_payload
            runtime_payload = prepared_context.runtime_payload

        neurobrain_state = (
            _read_neurobrain_state(bundle) if segment_intent is not None else None
        )

        prompt = _build_current_turn_prompt(
            current_user_text=current_user_text,
            assistant_text=assistant_text,
            segment_intent=segment_intent,
            neurobrain_state=neurobrain_state,
        )
        system_prompt = _build_independent_system_prompt(
            capability_payload=capability_payload,
            runtime_payload=runtime_payload,
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
                "prompt": prompt,
                "system_prompt": system_prompt,
                "neurobrain_state": neurobrain_state,
                "runtime_references": runtime_payload,
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
        response_text, transport = await _request_motion_provider_text(
            provider,
            prompt=prompt,
            system_prompt=system_prompt,
            contexts=contexts or None,
            turn_id=str(turn_id),
            motion_request_id=motion_request_id,
            persona_result_id=persona_result_id,
            segment_index=segment_index,
            on_complete_json=publish_completed_motion_record,
        )
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
            from astrbot.core.prompt.json_recovery import recover_json_record

            raw_arguments = await recover_json_record(
                response_text, plugin_context=bundle.runtime_state.plugin_context,
                event=event, scope="independent_motion",
            )
            if raw_arguments is None:
                raise ValueError("independent_motion_json_unrecoverable")
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
        unknown_fields = sorted(
            set(raw_arguments)
            - {
                "intent_tags",
                "axis_levels",
                "motion_steps",
                "duration_hint_ms",
                "expression_resource_id",
                "motion_resource_id",
            }
        )
        if unknown_fields:
            logger.warning(
                "WIRING independent_motion.output_rejected turn_id=%s "
                "reason=unknown_output_fields field_count=%s",
                turn_id,
                len(unknown_fields),
            )
            return finish(
                motion_payload=None,
                reason="unknown_output_fields:" + ",".join(unknown_fields),
                image_count=len(images),
            )

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
            event.get_extra("_turn_id") or "<missing>",
            min(len(rounds), history_turns),
            len(contexts),
        )
        return contexts
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "WIRING independent_motion.history_unavailable turn_id=%s error=%s",
            event.get_extra("_turn_id") or "<missing>",
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
    segment_intent: Mapping[str, Any] | None = None,
    neurobrain_state: Mapping[str, Any] | None = None,
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
    if isinstance(neurobrain_state, Mapping):
        payload["neurobrain_state"] = dict(neurobrain_state)
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _build_independent_system_prompt(
    *,
    capability_payload: dict[str, Any],
    runtime_payload: dict[str, Any],
) -> str:
    capability = _build_motion_capability_prompt_payload(capability_payload)
    capability.pop("pose_references", None)
    axis_keys = {"id", "label", "negative_semantics", "positive_semantics", "available_levels", "usage_notes"}
    capability["axes"] = [
        {key: value for key, value in axis.items() if key in axis_keys}
        for axis in capability.get("axes", [])
    ]
    guidance = _motion_guidance_for_prompt(capability, runtime_payload)
    motion_resource = next(
        (
            str(resource.get("resource_id") or "").strip()
            for resource in capability.get("resources", [])
            if isinstance(resource, Mapping)
            and resource.get("resource_type") == "motion"
            and str(resource.get("resource_id") or "").strip()
        ),
        "",
    )
    contract: dict[str, Any] = {"intent_tags": ["用简短关键词概括当前表达"]}
    if motion_resource:
        contract["motion_resource_id"] = motion_resource
    else:
        first_axis = next(
            (
                axis
                for axis in capability.get("axes", [])
                if isinstance(axis, Mapping)
                and str(axis.get("id") or "").strip()
                and axis.get("available_levels")
            ),
            None,
        )
        if first_axis is not None:
            raw_levels = first_axis.get("available_levels")
            levels = list(raw_levels) if isinstance(raw_levels, (list, tuple)) else []
            level = 0 if 0 in levels else levels[0]
            contract["axis_levels"] = {str(first_axis["id"]): level}
    return (
        "你负责为 AG99live 的 Live2D 角色生成动作参数。"
        "根据当前用户输入、提供的近期纯文本对话，以及当前 segment 的 speech、actions、tendency，"
        "你的输出不是动作建议或文字描述，而是会直接交给 Live2D ModelEngine 执行的工作参数。"
        "优先落实 actions，以 tendency 调整情绪强度，只描述角色本段应该呈现的动作。"
        "这是长期陪伴中的身体表达，不是独立的舞台表演；动作要自然亲近，并服务于同一人格的语气和关系。"
        "动作幅度跟随当前语气和 tendency：普通确认、轻声安慰或停顿思考保持克制；"
        "只有明确的动作意图、强烈情绪或用户明确要求时才提高幅度或使用动作序列。"
        "若当前内容没有清晰动作信号，可以保持中性或不控制无关轴；不要把每条回复都演成明显动作。"
        "每个动作都要服务于当前语义，不要为了显眼而制造与语义冲突的动作。"
        "如果当前输入包含 neurobrain_state，它只是连续状态的参考，不能当作动作命令；"
        "不要输出或复述这个字段，也不要因此改变既有 JSON 输出契约。"
        "参考示例的 output 就是输出格式；最近执行动作只用于衔接和避免机械重复，勿照搬。"
        "只输出一个 JSON 对象，不要 Markdown、解释文字、工具调用或额外字段。"
        "必需字段 intent_tags 是 1 到 6 个简短关键词。执行形状必须且只能选择一种："
        "axis_levels（单个姿态）、motion_steps（2 到 4 个动作步骤，每步必须包含 axis_levels 和 1 到 3 的 duration_weight），"
        "或 motion_resource_id（完整动作资源）。axis_levels 的值必须是能力数据里对应轴可用的等级。"
        "动作序列采用稀疏语义：每一步只写新开始控制或需要改变的轴，后续步骤可以新增或省略轴；"
        "不设整段动作的固定轴数量上限，但每个轴 ID 和等级都必须来自能力数据。"
        "可选字段只有 duration_hint_ms、expression_resource_id、motion_resource_id；"
        "motion_resource_id 不得和 axis_levels、motion_steps 或 duration_hint_ms 同时使用；"
        "expression_resource_id 不得和 motion_resource_id 同时使用。"
        "不要输出 profile_id、profile_revision、model_id、schema_version，这些由程序补入。"
        f"JSON 形状示例：{json.dumps(contract, ensure_ascii=False, separators=(',', ':'))}\n\n"
        "Live2D 能力：\n"
        f"{json.dumps(capability, ensure_ascii=False, separators=(',', ':'))}\n\n"
        "精简参考（所有 output 使用同一输出契约）：\n"
        f"{json.dumps(guidance, ensure_ascii=False, separators=(',', ':'))}"
    )


def _motion_guidance_for_prompt(
    capability: dict[str, Any], runtime: dict[str, Any],
) -> dict[str, Any]:
    """Project examples and executions onto the current legal output shape."""
    levels = {axis["id"]: set(axis.get("available_levels") or []) for axis in capability.get("axes", [])}
    output_keys = {"intent_tags", "axis_levels", "motion_steps", "duration_hint_ms", "expression_resource_id", "motion_resource_id"}

    def project(items: list[Any], *, executed: bool) -> list[dict[str, Any]]:
        results = []
        for item in items:
            if not isinstance(item, dict):
                continue
            raw_output = item if executed else item.get("output")
            if not isinstance(raw_output, dict):
                continue
            # Sequence snapshots also retain their final posture: it is not a second shape.
            output = {key: value for key, value in raw_output.items() if key in output_keys}
            for key in ("expression_resource_id", "motion_resource_id", "duration_hint_ms"):
                if output.get(key) in (None, ""):
                    output.pop(key, None)
            if executed and output.get("motion_steps"):
                output.pop("axis_levels", None)
            if executed and output.get("motion_resource_id"):
                output.pop("axis_levels", None)
                output.pop("motion_steps", None)
                output.pop("duration_hint_ms", None)
            input_text = "最近执行动作" if executed else _dialogue_text(str(item.get("input") or item.get("user_text") or ""))[:240]
            try:
                projected = _project_reference_examples_for_prompt(
                    [{"input": input_text, "output": output}],
                    allowed_axis_ids=set(levels), available_levels_by_axis=levels,
                    resource_candidates=capability.get("resources", []),
                )
            except ValueError:
                logger.debug("Motion prompt reference omitted: incompatible current output contract")
                continue
            # Keep whole JSON records; omit oversized guidance instead of truncating JSON.
            if projected and len(json.dumps(projected[0], ensure_ascii=False)) <= 2400:
                results.extend(projected)
        return results

    return {
        "examples": project((runtime.get("reference_examples") or [])[:2], executed=False),
        "recent_executed": project((runtime.get("recent_executed_motions") or [])[-3:], executed=True),
    }


def _motion_output_shape(value: Mapping[str, Any]) -> str:
    if "motion_resource_id" in value:
        return "motion_resource"
    if "motion_steps" in value:
        return "motion_steps"
    if "axis_levels" in value:
        return "axis_levels"
    return "missing"


def _motion_output_shape_summary(value: Mapping[str, Any]) -> dict[str, Any]:
    root_axes = value.get("axis_levels")
    root_axis_ids = {
        str(axis_id).strip()
        for axis_id in root_axes
        if str(axis_id).strip()
    } if isinstance(root_axes, Mapping) else set()
    raw_steps = value.get("motion_steps")
    step_axis_counts: list[int] = []
    unique_axis_ids = set(root_axis_ids)
    if isinstance(raw_steps, list):
        for raw_step in raw_steps:
            step_axes = (
                raw_step.get("axis_levels")
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
