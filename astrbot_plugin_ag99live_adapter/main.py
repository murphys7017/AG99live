import asyncio
import logging
import time
from collections.abc import Mapping
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import Plain
from astrbot.api.provider import LLMResponse, ProviderRequest
from astrbot.api.star import Context, Star

from .core_compatibility import supports_llm_response_hook
from .middleware import register_ag99live_interaction_contributors
from .motion.output_sanitizer import (
    contains_hidden_output_markup,
    sanitize_assistant_output_segment_text,
    sanitize_assistant_output_text,
)

def _optional_tts_state_hook():
    hook = getattr(filter, "on_tts_state_changed", None)
    if callable(hook):
        return hook()

    def _identity(handler):
        return handler

    return _identity


def _optional_persona_expression_hook():
    hook = getattr(filter, "on_persona_expression_result", None)
    if callable(hook):
        try:
            return hook(persona_segment_stream_safe=True)
        except TypeError:
            return hook()

    def _identity(handler):
        return handler

    return _identity


def _optional_persona_stream_finished_hook():
    hook = getattr(filter, "on_persona_expression_stream_finished", None)
    if callable(hook):
        try:
            return hook(persona_segment_stream_safe=True)
        except TypeError:
            return hook()

    def _identity(handler):
        return handler

    return _identity


def _optional_persona_segment_ready_hook():
    hook = getattr(filter, "on_persona_expression_segment_ready", None)
    if callable(hook):
        try:
            return hook(persona_segment_stream_safe=True)
        except TypeError:
            return hook()

    def _identity(handler):
        return handler

    return _identity


def _optional_persona_segment_intent_ready_hook():
    hook = getattr(filter, "on_persona_expression_segment_intent_ready", None)
    if callable(hook):
        try:
            return hook(persona_segment_stream_safe=True)
        except TypeError:
            return hook()

    def _identity(handler):
        return handler

    return _identity


def _optional_llm_response_hook():
    hook = getattr(filter, "on_llm_response", None)
    if callable(hook):
        try:
            return hook(persona_segment_stream_safe=True)
        except TypeError:
            return hook()

    def _identity(handler):
        return handler

    return _identity


def _optional_llm_request_hook():
    hook = getattr(filter, "on_llm_request", None)
    if not callable(hook):
        return lambda handler: handler
    try:
        return hook(persona_segment_stream_safe=True)
    except TypeError:
        return hook()


def _optional_decorating_result_hook():
    hook = getattr(filter, "on_decorating_result", None)
    if not callable(hook):
        return lambda handler: handler
    try:
        return hook(persona_segment_stream_safe=True)
    except TypeError:
        return hook()


class MyPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        from .runtime.plugin_runtime import set_plugin_config, set_plugin_context

        self.context = context
        self.config = config if config is not None else {}
        self._independent_motion_tasks: set[asyncio.Task] = set()

        _configure_noisy_loggers()
        set_plugin_context(context)
        set_plugin_config(self.config)

        from .platform_adapter import OLVPetPlatformAdapter  # noqa: F401

        independent_motion_config = self.config.get("independent_motion", {})
        independent_motion_enabled = bool(
            independent_motion_config.get("enabled", False)
            if isinstance(independent_motion_config, dict)
            else False
        )
        contributors_registered = register_ag99live_interaction_contributors(
            context,
            persona_effect_enabled=not independent_motion_enabled,
        )
        self._llm_response_hook_available = supports_llm_response_hook()
        self._official_core_compatibility = (
            not contributors_registered or not self._llm_response_hook_available
        )
        logger.debug(
            "WIRING interaction.plugin_initialized contributors_registered=%s "
            "llm_response_hook_available=%s official_core_compatibility=%s "
            "context_type=%s",
            contributors_registered,
            self._llm_response_hook_available,
            self._official_core_compatibility,
            type(context).__name__,
        )
        from .web_control import register_web_control_page

        self._web_control_page_registered = register_web_control_page(context, self)
        if self._official_core_compatibility:
            logger.info(
                "AG99live enhanced interaction is unavailable; "
                "motion generation and performance curves are disabled."
            )

    @_optional_llm_request_hook()
    async def start_independent_motion_generation(
        self,
        event: AstrMessageEvent,
        request: ProviderRequest,
    ) -> None:
        del request
        from .middleware.interaction_motion.shared import (
            _resolve_motion_runtime_bundle,
        )

        bundle = _resolve_motion_runtime_bundle(event)
        platform_name = str(event.get_platform_name() or "").strip()
        turn_id = str(event.get_extra("_turn_id") or "").strip()
        independent_enabled = bool(
            bundle is not None
            and getattr(bundle.runtime_state, "independent_motion_enabled", False)
        )
        logger.debug(
            "WIRING independent_motion.request_hook_entered platform=%s turn_id=%s "
            "bundle_present=%s independent_enabled=%s official_core_compatibility=%s "
            "bypass=%s",
            platform_name or "<missing>",
            turn_id or "<missing>",
            bundle is not None,
            independent_enabled,
            self._official_core_compatibility,
            bool(event.get_extra("_interaction_protocol_core_bypass")),
        )
        if bundle is None or not independent_enabled:
            return

        if self._official_core_compatibility:
            reason = (
                "llm_response_hook_unavailable"
                if not self._llm_response_hook_available
                else "interaction_contributors_unavailable"
            )
            logger.warning(
                "WIRING independent_motion.disabled reason=%s turn_id=%s",
                reason,
                turn_id or "<missing>",
            )
            return

        if bool(
            getattr(
                bundle.runtime_state,
                "independent_motion_per_speech_segment",
                False,
            )
        ):
            logger.debug(
                "WIRING independent_motion.request_hook mode=per_speech_segment "
                "turn_id=%s; waiting for Persona speech segments",
                event.get_extra("_turn_id") or "<missing>",
            )
            return

        if bool(getattr(bundle.runtime_state, "independent_motion_parallel", False)):
            from .middleware.interaction_motion.independent import (
                start_parallel_motion_generation,
            )

            start_parallel_motion_generation(
                event,
                bundle,
                tasks=self._independent_motion_tasks,
            )
            # Let the provider request start while the main model request runs.
            await asyncio.sleep(0)
        else:
            logger.debug(
                "WIRING independent_motion.request_hook mode=serial "
                "turn_id=%s provider=%s",
                event.get_extra("_turn_id") or "<missing>",
                getattr(
                    bundle.runtime_state,
                    "independent_motion_provider_id",
                    "<missing>",
                ),
            )

    @_optional_llm_response_hook()
    async def resolve_independent_motion_after_llm_response(
        self,
        event: AstrMessageEvent,
        response: LLMResponse,
    ) -> None:
        from .middleware.interaction_motion.independent import (
            INDEPENDENT_MOTION_RESULT_EXTRA_KEY,
            INDEPENDENT_MOTION_TASK_EXTRA_KEY,
            resolve_motion_after_llm_response,
            store_motion_result_for_turn,
        )
        from .middleware.interaction_motion.shared import (
            _resolve_motion_runtime_bundle,
        )

        bundle = _resolve_motion_runtime_bundle(event)
        turn_id = str(event.get_extra("_turn_id") or "").strip()
        response_text = str(getattr(response, "completion_text", "") or "").strip()
        result_chain = getattr(response, "result_chain", None)
        chain = getattr(result_chain, "chain", None)
        logger.debug(
            "WIRING independent_motion.response_hook_entered turn_id=%s "
            "bundle_present=%s independent_enabled=%s official_core_compatibility=%s "
            "bypass=%s completion_text_len=%s result_chain_count=%s",
            turn_id or "<missing>",
            bundle is not None,
            bool(
                bundle is not None
                and getattr(bundle.runtime_state, "independent_motion_enabled", False)
            ),
            self._official_core_compatibility,
            bool(event.get_extra("_interaction_protocol_core_bypass")),
            len(response_text),
            len(chain) if isinstance(chain, list) else 0,
        )
        if bundle is None or not bool(
            getattr(bundle.runtime_state, "independent_motion_enabled", False)
        ):
            logger.debug(
                "WIRING independent_motion.response_hook_skipped turn_id=%s "
                "reason=runtime_or_config_unavailable",
                turn_id or "<missing>",
            )
            return
        if bool(
            getattr(
                bundle.runtime_state,
                "independent_motion_per_speech_segment",
                False,
            )
        ):
            logger.debug(
                "WIRING independent_motion.response_hook_skipped turn_id=%s "
                "reason=per_speech_segment_mode",
                turn_id or "<missing>",
            )
            return
        if event.get_extra("agent_stop_requested", False):
            logger.debug(
                "WIRING independent_motion.response_hook_skipped turn_id=%s "
                "reason=turn_terminated",
                turn_id or "<missing>",
            )
            event.set_extra(INDEPENDENT_MOTION_RESULT_EXTRA_KEY, None)
            event.set_extra(INDEPENDENT_MOTION_TASK_EXTRA_KEY, None)
            return
        if self._official_core_compatibility:
            logger.warning(
                "WIRING independent_motion.response_hook_skipped turn_id=%s "
                "reason=interaction_contributors_unavailable",
                turn_id or "<missing>",
            )
            return
        if (
            event.get_extra(INDEPENDENT_MOTION_RESULT_EXTRA_KEY) is not None
        ):
            logger.warning(
                "WIRING independent_motion.response_hook_skipped turn_id=%s "
                "reason=event_result_already_present",
                turn_id or "<missing>",
            )
            return

        assistant_text = response_text
        if not assistant_text:
            if isinstance(chain, list):
                assistant_text = "\n".join(
                    str(getattr(component, "text", "") or "").strip()
                    for component in chain
                    if isinstance(component, Plain)
                    and str(getattr(component, "text", "") or "").strip()
                ).strip()

        result = await resolve_motion_after_llm_response(
            event,
            bundle,
            assistant_text=assistant_text,
            tasks=self._independent_motion_tasks,
        )
        if result is not None:
            if event.get_extra("agent_stop_requested", False):
                logger.debug(
                    "WIRING independent_motion.result_discarded turn_id=%s "
                    "reason=turn_terminated",
                    turn_id or "<missing>",
                )
                event.set_extra(INDEPENDENT_MOTION_RESULT_EXTRA_KEY, None)
                event.set_extra(INDEPENDENT_MOTION_TASK_EXTRA_KEY, None)
                return
            stored = store_motion_result_for_turn(
                bundle.runtime_state,
                turn_id=str(event.get_extra("_turn_id") or ""),
                result=result,
                assistant_text=assistant_text,
            )
            if stored:
                logger.debug(
                    "WIRING independent_motion.result_cached turn_id=%s "
                    "mode=%s payload_present=%s reason=%s image_count=%s "
                    "assistant_text_len=%s",
                    event.get_extra("_turn_id") or "<missing>",
                    (
                        "parallel"
                        if bool(
                            getattr(
                                bundle.runtime_state,
                                "independent_motion_parallel",
                                False,
                            )
                        )
                        else "serial"
                    ),
                    result.motion_payload is not None,
                    result.reason,
                    result.image_count,
                    len(assistant_text),
                )
            else:
                logger.warning(
                    "WIRING independent_motion.result_not_cached turn_id=%s "
                    "reason=assistant_text_empty",
                    event.get_extra("_turn_id") or "<missing>",
                )
            # The result is now owned by the turn cache. Leaving it on the
            # event would let a Persona hook store it a second time.
            event.set_extra(INDEPENDENT_MOTION_RESULT_EXTRA_KEY, None)
            event.set_extra(INDEPENDENT_MOTION_TASK_EXTRA_KEY, None)
        else:
            logger.warning(
                "WIRING independent_motion.result_missing turn_id=%s "
                "assistant_text_len=%s",
                turn_id or "<missing>",
                len(assistant_text),
            )

    @_optional_decorating_result_hook()
    async def sanitize_hidden_output_markup(
        self,
        event: AstrMessageEvent,
    ) -> None:
        if str(event.get_platform_name() or "").strip() != "olv_pet_adapter":
            return

        result = event.get_result()
        if result is None or not isinstance(result.chain, list) or not result.chain:
            return

        original_plain_texts: list[str] = []
        changed = False
        for component in result.chain:
            if not isinstance(component, Plain):
                continue
            text = str(getattr(component, "text", "") or "").strip()
            if not text:
                continue
            original_plain_texts.append(text)
            if not contains_hidden_output_markup(text):
                continue
            component.text = sanitize_assistant_output_text(text)
            changed = True

        raw_reply_text = "\n".join(original_plain_texts).strip()
        if changed and raw_reply_text:
            event.set_extra("ag99live_raw_reply_text", raw_reply_text)
            logger.debug(
                "WIRING assistant_output_normalized=true platform=%s raw_len=%s",
                event.get_platform_name(),
                len(raw_reply_text),
            )

    @_optional_tts_state_hook()
    async def handle_tts_generation_state(
        self,
        event: AstrMessageEvent,
        state: Any,
    ) -> None:
        if self._official_core_compatibility:
            return
        if str(event.get_platform_name() or "").strip() != "olv_pet_adapter":
            return
        if state.stage != "interaction.outbound_tts":
            return
        if state.status == "succeeded":
            logger.info(
                "DIAG latency.tts_material_ready turn_id=%s persona_result_id=%s "
                "segment_index=%s message_id=%s tts_request_id=%s timestamp_epoch_ms=%s",
                state.turn_id or "<missing>",
                getattr(state, "persona_result_id", None) or "<missing>",
                getattr(state, "persona_segment_index", None),
                state.message_id or "<missing>",
                state.tts_request_id or "<missing>",
                time.time_ns() // 1_000_000,
            )
            return
        if state.status not in {"requested", "generating"}:
            return

        from .middleware.interaction_motion import (
            start_deferred_performance_curve_request,
        )

        start_deferred_performance_curve_request(
            event,
            turn_id=state.turn_id,
            message_id=state.message_id,
            tts_request_id=state.tts_request_id,
            external_correlation_id=state.external_correlation_id,
            stage=state.stage,
            status=state.status,
            parent_message_id=getattr(state, "parent_message_id", None),
            persona_result_id=getattr(state, "persona_result_id", None),
            persona_segment_index=getattr(state, "persona_segment_index", None),
            persona_segment_count=getattr(state, "persona_segment_count", None),
        )

    @_optional_persona_segment_intent_ready_hook()
    async def handle_persona_expression_segment_intent_ready(
        self,
        event: AstrMessageEvent,
        *,
        turn_id: str,
        persona_result_id: str,
        segment_index: int,
        message_id: str,
        actions: Any,
        tendency: Any,
        turn_action: Any = None,
        execution_surface: str | None = None,
    ) -> None:
        del turn_action, execution_surface
        if (
            self._official_core_compatibility
            or str(event.get_platform_name() or "").strip() != "olv_pet_adapter"
            or not event.get_extra("_interaction_persona_segment_stream_active", False)
            or event.get_extra("agent_stop_requested", False)
        ):
            return
        from .middleware.interaction_motion.independent import (
            IndependentMotionResult,
            _prepare_independent_motion_context,
            await_with_hard_deadline,
            generate_independent_motion,
            is_persona_expression_request,
            persona_expression_intent,
            resolve_stream_motion_budget_seconds,
            track_motion_generation_task,
            untrack_motion_generation_task,
        )
        from .middleware.interaction_motion.shared import _resolve_motion_runtime_bundle

        bundle = _resolve_motion_runtime_bundle(event)
        if (
            bundle is None
            or not bool(getattr(bundle.runtime_state, "independent_motion_enabled", False))
            or not bool(getattr(bundle.runtime_state, "independent_motion_per_speech_segment", False))
        ):
            return
        request = event.get_extra("provider_request")
        intent = persona_expression_intent(request)
        if (
            not is_persona_expression_request(request)
            or intent is None
            or str(intent.get("phase") or "").strip() not in {"immediate", "final"}
            or str(intent.get("kind") or "").strip() != "reply"
        ):
            return
        normalized_turn_id = str(turn_id or "").strip()
        normalized_result_id = str(persona_result_id or "").strip()
        normalized_parent_id = str(message_id or "").strip()
        if (
            not normalized_turn_id
            or normalized_turn_id != str(event.get_extra("_turn_id") or "").strip()
            or not normalized_result_id
            or not normalized_parent_id
            or type(segment_index) is not int
            or segment_index < 0
        ):
            return

        registry = bundle.runtime_state.persona_stream_motion
        work = registry.get(normalized_turn_id)
        if work is None:
            parallel = bool(
                getattr(bundle.runtime_state, "independent_motion_parallel", False)
            )
            try:
                max_concurrency = max(
                    1,
                    min(int(getattr(bundle.runtime_state, "independent_motion_max_concurrency", 4)), 8),
                )
            except (TypeError, ValueError):
                max_concurrency = 4
            work = {
                "turn_id": normalized_turn_id,
                "persona_result_id": normalized_result_id,
                "parent_message_id": normalized_parent_id,
                "phase": str(intent.get("phase") or "").strip(),
                "next_segment_index": 0,
                "segment_result_futures": {},
                "segment_deadlines": {},
                "segment_intents_by_index": {},
                "preview_tasks": {},
                "speech_segments": [],
                "tasks": set(),
                "context_task": None,
                "concurrency_gate": asyncio.Semaphore(
                    max_concurrency if parallel else 1
                ),
                "parallel": parallel,
            }
            registry.register(normalized_turn_id, work)
        if (
            work.get("persona_result_id") != normalized_result_id
            or work.get("parent_message_id") != normalized_parent_id
            or segment_index != len(work.get("segment_intents_by_index", {}))
        ):
            return
        loop = asyncio.get_running_loop()
        result_future = loop.create_future()
        work["segment_result_futures"][segment_index] = result_future
        work["segment_intents_by_index"][segment_index] = {
            "actions": list(actions) if isinstance(actions, (list, tuple)) else [],
            "tendency": dict(tendency) if isinstance(tendency, Mapping) else {},
        }
        work.setdefault("segment_deadlines", {})[segment_index] = (
            loop.time() + resolve_stream_motion_budget_seconds(bundle.runtime_state, event=event)
        )

        if not isinstance(work.get("context_task"), asyncio.Task):
            async def _prepare_preview_context() -> Any:
                try:
                    return await await_with_hard_deadline(
                        _prepare_independent_motion_context(
                            event,
                            bundle,
                            persona_result_id=normalized_result_id,
                        ),
                        resolve_stream_motion_budget_seconds(bundle.runtime_state, event=event),
                        background_tasks=work["tasks"],
                    )
                except asyncio.TimeoutError:
                    logger.debug(
                        "WIRING independent_motion.intent_preview_context_timeout "
                        "turn_id=%s persona_result_id=%s",
                        normalized_turn_id,
                        normalized_result_id,
                    )
                    return None
                except Exception as exc:  # noqa: BLE001
                    logger.debug(
                        "WIRING independent_motion.intent_preview_context_failed "
                        "turn_id=%s persona_result_id=%s error=%s",
                        normalized_turn_id,
                        normalized_result_id,
                        exc,
                        exc_info=True,
                    )
                    return None

            context_task = asyncio.create_task(
                _prepare_preview_context(),
                name=f"ag99live-persona-stream-preview-context-{normalized_result_id[:12]}",
            )
            work["context_task"] = context_task
            work["tasks"].add(context_task)
            self._independent_motion_tasks.add(context_task)
            context_task.add_done_callback(work["tasks"].discard)
            context_task.add_done_callback(self._independent_motion_tasks.discard)
            context_task.add_done_callback(
                lambda task: untrack_motion_generation_task(
                    bundle.runtime_state,
                    turn_id=normalized_turn_id,
                    task=task,
                )
            )
            track_motion_generation_task(
                bundle.runtime_state,
                turn_id=normalized_turn_id,
                task=context_task,
            )

        async def _generate_preview() -> None:
            current_task = asyncio.current_task()
            result: IndependentMotionResult | None = None
            wait_stage = "context"
            try:
                provider = getattr(bundle.runtime_state, "selected_independent_motion_provider", None)
                if provider is None:
                    result = IndependentMotionResult("", None, "provider_unavailable", 0)
                else:
                    timeout_seconds = resolve_stream_motion_budget_seconds(
                        bundle.runtime_state, event=event,
                    )
                    deadline = work.get("segment_deadlines", {}).get(segment_index)
                    if not isinstance(deadline, (int, float)):
                        deadline = loop.time() + timeout_seconds
                    prepared_context = None
                    context_task = work.get("context_task")
                    if isinstance(context_task, asyncio.Task):
                        remaining = deadline - loop.time()
                        if remaining <= 0:
                            raise asyncio.TimeoutError
                        prepared_context = await await_with_hard_deadline(
                            asyncio.shield(context_task),
                            remaining,
                            background_tasks=work["tasks"],
                        )
                    if prepared_context is None:
                        result = IndependentMotionResult(
                            "", None, "motion_context_unavailable", 0
                        )
                    else:
                        wait_stage = "concurrency_gate"
                        remaining = deadline - loop.time()
                        if remaining <= 0:
                            raise asyncio.TimeoutError
                        acquired = False
                        try:
                            await asyncio.wait_for(
                                work["concurrency_gate"].acquire(),
                                timeout=remaining,
                            )
                            acquired = True
                            remaining = deadline - loop.time()
                            if remaining <= 0:
                                raise asyncio.TimeoutError
                            call = generate_independent_motion(
                                event,
                                bundle,
                                provider=provider,
                                assistant_text="",
                                segment_intent=work["segment_intents_by_index"][segment_index],
                                prepared_context=prepared_context,
                                persona_result_id=normalized_result_id,
                                segment_index=segment_index,
                            )
                            wait_stage = "provider"
                            result = await await_with_hard_deadline(
                                call,
                                remaining,
                                background_tasks=work["tasks"],
                            )
                        finally:
                            if acquired:
                                work["concurrency_gate"].release()
            except asyncio.TimeoutError:
                logger.warning(
                    "DIAG motion.generation_deadline_exhausted turn_id=%s "
                    "persona_result_id=%s segment_index=%s stage=%s timestamp_epoch_ms=%s",
                    normalized_turn_id,
                    normalized_result_id,
                    segment_index,
                    wait_stage,
                    time.time_ns() // 1_000_000,
                )
                result = IndependentMotionResult("", None, "motion_timeout", 0)
            except Exception as exc:  # noqa: BLE001
                logger.debug("WIRING independent_motion.intent_preview_failed error=%s", exc, exc_info=True)
                result = IndependentMotionResult("", None, "segment_generation_failed", 0)
            finally:
                if result is not None and not result_future.done():
                    result_future.set_result(result)
                publish_motion = getattr(
                    event,
                    "publish_interaction_incremental_motion",
                    None,
                )
                if result is not None and callable(publish_motion):
                    try:
                        await publish_motion(
                            segment_index=segment_index,
                            motion_payload=result.motion_payload,
                            reason=result.reason or "motion_payload_missing",
                        )
                    except Exception:  # noqa: BLE001 - optional motion cannot stop dialogue.
                        logger.debug(
                            "WIRING independent_motion.incremental_publish_failed "
                            "turn_id=%s segment_index=%s",
                            normalized_turn_id,
                            segment_index,
                            exc_info=True,
                        )
                if isinstance(current_task, asyncio.Task):
                    untrack_motion_generation_task(
                        bundle.runtime_state,
                        turn_id=normalized_turn_id,
                        task=current_task,
                    )

        preview_task = asyncio.create_task(
            _generate_preview(),
            name=f"ag99live-persona-stream-intent-{normalized_result_id[:10]}-{segment_index}",
        )
        work["preview_tasks"][segment_index] = preview_task
        work["tasks"].add(preview_task)
        self._independent_motion_tasks.add(preview_task)
        preview_task.add_done_callback(work["tasks"].discard)
        preview_task.add_done_callback(self._independent_motion_tasks.discard)
        track_motion_generation_task(
            bundle.runtime_state,
            turn_id=normalized_turn_id,
            task=preview_task,
        )

    @_optional_persona_segment_ready_hook()
    async def handle_persona_expression_segment_ready(
        self,
        event: AstrMessageEvent,
        *,
        turn_id: str,
        persona_result_id: str,
        segment_index: int,
        message_id: str,
        segment: Any,
        turn_action: Any = None,
        execution_surface: str | None = None,
    ) -> None:
        del turn_action, execution_surface
        if (
            self._official_core_compatibility
            or str(event.get_platform_name() or "").strip() != "olv_pet_adapter"
            or not event.get_extra(
                "_interaction_persona_segment_stream_active",
                False,
            )
        ):
            return
        if event.get_extra("agent_stop_requested", False):
            return

        from .middleware.interaction_motion.independent import (
            IndependentMotionResult,
            _prepare_independent_motion_context,
            await_with_hard_deadline,
            generate_independent_motion_for_segments,
            is_persona_expression_request,
            persona_expression_intent,
            resolve_stream_motion_budget_seconds,
            track_motion_generation_task,
            untrack_motion_generation_task,
        )
        from .middleware.interaction_motion.shared import (
            _resolve_motion_runtime_bundle,
        )

        bundle = _resolve_motion_runtime_bundle(event)
        if (
            bundle is None
            or not bool(
                getattr(bundle.runtime_state, "independent_motion_enabled", False)
            )
            or not bool(
                getattr(
                    bundle.runtime_state,
                    "independent_motion_per_speech_segment",
                    False,
                )
            )
        ):
            return
        normalized_turn_id = str(turn_id or "").strip()
        normalized_result_id = str(persona_result_id or "").strip()
        normalized_parent_id = str(message_id or "").strip()
        if (
            not normalized_turn_id
            or normalized_turn_id != str(event.get_extra("_turn_id") or "").strip()
            or not normalized_result_id
            or not normalized_parent_id
            or type(segment_index) is not int
            or segment_index < 0
        ):
            logger.warning(
                "WIRING independent_motion.stream_segment_rejected "
                "reason=identity_invalid turn_id=%s persona_result_id=%s "
                "segment_index=%s action=continue_core_dialogue",
                normalized_turn_id or "<missing>",
                normalized_result_id or "<missing>",
                segment_index,
            )
            return

        request = event.get_extra("provider_request")
        intent = persona_expression_intent(request)
        if (
            not is_persona_expression_request(request)
            or intent is None
            or str(intent.get("phase") or "").strip() not in {"immediate", "final"}
            or str(intent.get("kind") or "").strip() != "reply"
        ):
            return
        phase = str(intent.get("phase") or "").strip()
        if isinstance(segment, Mapping):
            speech = str(segment.get("speech") or "")
            raw_actions = segment.get("actions")
            raw_tendency = segment.get("tendency")
        else:
            speech = str(getattr(segment, "speech", "") or "")
            raw_actions = getattr(segment, "actions", ())
            raw_tendency = getattr(segment, "tendency", {})
        speech = sanitize_assistant_output_segment_text(speech)
        actions = list(raw_actions) if isinstance(raw_actions, (list, tuple)) else []
        tendency = dict(raw_tendency) if isinstance(raw_tendency, Mapping) else {}

        registry = bundle.runtime_state.persona_stream_motion
        work = registry.get(normalized_turn_id)
        if work is None:
            parallel = bool(
                getattr(bundle.runtime_state, "independent_motion_parallel", False)
            )
            try:
                max_concurrency = max(
                    1,
                    min(
                        int(
                            getattr(
                                bundle.runtime_state,
                                "independent_motion_max_concurrency",
                                4,
                            )
                        ),
                        8,
                    ),
                )
            except (TypeError, ValueError):
                max_concurrency = 4
            work = {
                "turn_id": normalized_turn_id,
                "persona_result_id": normalized_result_id,
                "parent_message_id": normalized_parent_id,
                "phase": phase,
                "next_segment_index": 0,
                "segment_result_futures": {},
                "tasks": set(),
                "context_task": None,
                "concurrency_gate": asyncio.Semaphore(
                    max_concurrency if parallel else 1
                ),
                "parallel": parallel,
            }
            registry.register(normalized_turn_id, work)
        elif (
            not isinstance(work, dict)
            or work.get("turn_id") != normalized_turn_id
            or work.get("persona_result_id") != normalized_result_id
            or work.get("parent_message_id") != normalized_parent_id
            or work.get("phase") != phase
        ):
            logger.warning(
                "WIRING independent_motion.stream_segment_rejected "
                "reason=stream_identity_conflict turn_id=%s "
                "persona_result_id=%s segment_index=%s "
                "action=continue_core_dialogue",
                normalized_turn_id,
                normalized_result_id,
                segment_index,
            )
            return

        if segment_index != work["next_segment_index"]:
            logger.warning(
                "WIRING independent_motion.stream_segment_rejected "
                "reason=segment_index_nonsequential turn_id=%s "
                "persona_result_id=%s segment_index=%s expected_index=%s "
                "action=continue_core_dialogue",
                normalized_turn_id,
                normalized_result_id,
                segment_index,
                work["next_segment_index"],
            )
            return
        work["next_segment_index"] += 1
        work.setdefault("segment_intents_by_index", {})[segment_index] = {
            "actions": actions,
            "tendency": tendency,
        }
        speech_segments = list(work.get("speech_segments") or [])
        while len(speech_segments) <= segment_index:
            speech_segments.append("")
        speech_segments[segment_index] = speech
        work["speech_segments"] = speech_segments

        result_future = work["segment_result_futures"].get(segment_index)
        if not isinstance(result_future, asyncio.Future):
            result_future = asyncio.get_running_loop().create_future()
            work["segment_result_futures"][segment_index] = result_future
        work.setdefault("segment_deadlines", {}).setdefault(
            segment_index,
            asyncio.get_running_loop().time()
            + resolve_stream_motion_budget_seconds(bundle.runtime_state, event=event),
        )
        preview_tasks = work.get("preview_tasks")
        if isinstance(preview_tasks, dict) and segment_index in preview_tasks:
            # The intent hook already started the action request before speech
            # generation reached segment_end. Keep that early result and let
            # TTS join it by the same segment future.
            return
        context_task = work.get("context_task")
        if not isinstance(context_task, asyncio.Task):
            async def _prepare_context():
                try:
                    context_preparation = _prepare_independent_motion_context(
                        event, bundle, persona_result_id=normalized_result_id
                    )
                    return await await_with_hard_deadline(
                        context_preparation,
                        resolve_stream_motion_budget_seconds(
                            bundle.runtime_state, event=event,
                        ),
                        background_tasks=self._independent_motion_tasks,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        "WIRING independent_motion.stream_context_timeout "
                        "turn_id=%s persona_result_id=%s",
                        normalized_turn_id,
                        normalized_result_id,
                    )
                    return None
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "WIRING independent_motion.stream_context_unavailable "
                        "turn_id=%s persona_result_id=%s error=%s",
                        normalized_turn_id,
                        normalized_result_id,
                        exc,
                        exc_info=True,
                    )
                    return None

            context_task = asyncio.create_task(
                _prepare_context(),
                name=f"ag99live-persona-stream-context-{normalized_result_id[:12]}",
            )
            work["context_task"] = context_task

        segment_intent = {"actions": actions, "tendency": tendency}

        async def _generate_segment() -> None:
            current_task = asyncio.current_task()
            result = None
            try:
                deadline = work["segment_deadlines"][segment_index]
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                async with asyncio.timeout(remaining), work["concurrency_gate"]:
                    context_timed_out = False
                    try:
                        deadline = work["segment_deadlines"].get(segment_index)
                        remaining = (
                            deadline - asyncio.get_running_loop().time()
                            if isinstance(deadline, (int, float))
                            else resolve_stream_motion_budget_seconds(
                                bundle.runtime_state, event=event,
                            )
                        )
                        if remaining <= 0:
                            raise asyncio.TimeoutError
                        prepared_context = await await_with_hard_deadline(
                            asyncio.shield(context_task),
                            remaining,
                            background_tasks=self._independent_motion_tasks,
                        )
                    except asyncio.TimeoutError:
                        prepared_context = None
                        context_timed_out = True
                    except Exception:  # noqa: BLE001
                        prepared_context = None
                    if prepared_context is None:
                        result = IndependentMotionResult(
                            assistant_text=speech,
                            motion_payload=None,
                            reason=(
                                "motion_timeout"
                                if context_timed_out
                                else "motion_context_unavailable"
                            ),
                            image_count=0,
                        )
                    else:
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            raise asyncio.TimeoutError
                        result_map = await await_with_hard_deadline(
                            generate_independent_motion_for_segments(
                                event,
                                bundle,
                                speech_segments=("",) * segment_index + (speech,),
                                segment_intents=({},) * segment_index + (segment_intent,),
                                parallel=bool(work["parallel"]),
                                tasks=work["tasks"],
                                persona_result_id=normalized_result_id,
                                prepared_context=prepared_context,
                            ),
                            remaining,
                            background_tasks=work["tasks"],
                        )
                        result = result_map.get(segment_index)
                        if result is None:
                            result = IndependentMotionResult(
                                assistant_text=speech,
                                motion_payload=None,
                                reason="independent_segment_result_missing",
                                image_count=0,
                            )
            except asyncio.TimeoutError:
                result = IndependentMotionResult(
                    assistant_text=speech,
                    motion_payload=None,
                    reason="motion_timeout",
                    image_count=0,
                )
            except asyncio.CancelledError:
                if not result_future.done():
                    result_future.cancel()
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "WIRING independent_motion.stream_segment_failed "
                    "turn_id=%s persona_result_id=%s segment_index=%s error=%s",
                    normalized_turn_id,
                    normalized_result_id,
                    segment_index,
                    exc,
                    exc_info=True,
                )
                result = IndependentMotionResult(
                    assistant_text=speech,
                    motion_payload=None,
                    reason="segment_generation_failed",
                    image_count=0,
                )
            finally:
                if result is not None and not result_future.done():
                    result_future.set_result(result)
                publish_motion = getattr(
                    event,
                    "publish_interaction_incremental_motion",
                    None,
                )
                if result is not None and callable(publish_motion):
                    try:
                        await publish_motion(
                            segment_index=segment_index,
                            motion_payload=result.motion_payload,
                            reason=result.reason or "motion_payload_missing",
                        )
                    except Exception:  # noqa: BLE001 - optional motion cannot stop dialogue.
                        logger.debug(
                            "WIRING independent_motion.incremental_publish_failed "
                            "turn_id=%s segment_index=%s",
                            normalized_turn_id,
                            segment_index,
                            exc_info=True,
                        )
                if isinstance(current_task, asyncio.Task):
                    untrack_motion_generation_task(
                        bundle.runtime_state,
                        turn_id=normalized_turn_id,
                        task=current_task,
                    )

        generation_task = asyncio.create_task(
            _generate_segment(),
            name=(
                f"ag99live-persona-stream-motion-{normalized_result_id[:10]}-"
                f"{segment_index}"
            ),
        )
        if not track_motion_generation_task(
            bundle.runtime_state,
            turn_id=normalized_turn_id,
            task=generation_task,
        ):
            generation_task.cancel()
            if not result_future.done():
                result_future.set_result(
                    IndependentMotionResult(
                        assistant_text=speech,
                        motion_payload=None,
                        reason="task_tracking_unavailable",
                        image_count=0,
                    )
                )
            return
        work["tasks"].add(generation_task)
        self._independent_motion_tasks.add(generation_task)
        generation_task.add_done_callback(work["tasks"].discard)
        generation_task.add_done_callback(self._independent_motion_tasks.discard)
        # Let the generation task get scheduled before returning control to
        # Core's segment delivery/TTS consumer.  The task still waits for the
        # shared context snapshot before entering the Provider call.
        await asyncio.sleep(0)

    @_optional_persona_stream_finished_hook()
    async def handle_persona_expression_stream_finished(
        self,
        event: AstrMessageEvent,
        *,
        turn_id: str,
        persona_result_id: str,
        message_id: str,
        segment_count: int,
        status: str,
        failure_reason: str | None = None,
    ) -> None:
        if str(event.get_platform_name() or "").strip() != "olv_pet_adapter":
            return
        mark_finished = getattr(event, "mark_persona_stream_finished", None)
        if not callable(mark_finished):
            logger.warning(
                "WIRING persona_stream_terminal_unavailable turn_id=%s "
                "persona_result_id=%s",
                turn_id or "<missing>",
                persona_result_id or "<missing>",
            )
            return
        try:
            mark_finished(
                turn_id=turn_id,
                persona_result_id=persona_result_id,
                message_id=message_id,
                segment_count=segment_count,
                status=status,
                failure_reason=failure_reason,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "WIRING persona_stream_terminal_rejected turn_id=%s "
                "persona_result_id=%s segment_count=%s status=%s reason=%s "
                "failure_reason=%s",
                turn_id or "<missing>",
                persona_result_id or "<missing>",
                segment_count,
                status,
                exc,
                failure_reason or "<none>",
                exc_info=True,
            )
            # Closing delivery must still run so the desktop receives a failure
            # terminal while retaining the segments it has already accepted.
            event.record_persona_stream_failure(f"persona_stream_terminal_rejected:{exc}")
        finally:
            registry = getattr(
                getattr(getattr(event, "adapter", None), "runtime_state", None),
                "persona_stream_motion",
                None,
            )
            if registry is not None:
                registry.clear(
                    turn_id,
                    persona_result_id=persona_result_id,
                    parent_message_id=message_id,
                )

    @_optional_persona_expression_hook()
    async def handle_persona_expression_result(
        self,
        event: AstrMessageEvent,
        result: Any,
    ) -> None:
        if self._official_core_compatibility:
            return
        if str(event.get_platform_name() or "").strip() != "olv_pet_adapter":
            return

        from .middleware.interaction_motion.independent import (
            PERSONA_RESULT_ID_METADATA_KEY,
        )

        result_metadata = getattr(result, "metadata", None)
        persona_result_id = str(
            result_metadata.get(PERSONA_RESULT_ID_METADATA_KEY)
            if isinstance(result_metadata, dict)
            else ""
        ).strip()
        raw_segments = getattr(result, "segments", ())
        if persona_result_id:
            logger.info(
                "DIAG latency.persona_result_ready turn_id=%s persona_result_id=%s "
                "segment_count=%s timestamp_epoch_ms=%s",
                str(event.get_extra("_turn_id") or "<missing>"),
                persona_result_id,
                len(raw_segments),
                time.time_ns() // 1_000_000,
            )

        if event.get_extra(
            "_interaction_persona_segment_stream_active",
            False,
        ):
            return

        from .middleware.interaction_motion.independent import (
            INDEPENDENT_MOTION_RESULT_EXTRA_KEY,
            IndependentMotionResult,
            generate_independent_motion_for_segments,
            is_persona_expression_request,
            persona_expression_intent,
            store_motion_result_for_turn,
            store_persona_motion_work,
            track_motion_generation_task,
            untrack_motion_generation_task,
        )
        from .middleware.interaction_motion.shared import (
            _resolve_motion_runtime_bundle,
        )

        bundle = _resolve_motion_runtime_bundle(event)
        if (
            bundle is not None
            and bool(
                getattr(bundle.runtime_state, "independent_motion_enabled", False)
            )
        ):
            if bool(
                getattr(
                    bundle.runtime_state,
                    "independent_motion_per_speech_segment",
                    False,
                )
            ):
                turn_id = str(event.get_extra("_turn_id") or "").strip()
                if not turn_id:
                    logger.warning(
                        "WIRING independent_motion.segment_generation_skipped "
                        "reason=turn_id_missing"
                    )
                    return
                request = event.get_extra("provider_request")
                intent = persona_expression_intent(request)
                if (
                    not is_persona_expression_request(request)
                    or intent is None
                    or str(intent.get("phase") or "").strip()
                    not in {"immediate", "final"}
                    or str(intent.get("kind") or "").strip() != "reply"
                    or event.get_extra("agent_stop_requested", False)
                ):
                    return
                phase = str(intent.get("phase") or "").strip()
                if not persona_result_id:
                    logger.warning(
                        "WIRING independent_motion.segment_generation_skipped "
                        "reason=persona_result_id_missing turn_id=%s",
                        turn_id,
                    )
                    return
                speech_segments = tuple(
                    sanitize_assistant_output_segment_text(
                        str(getattr(segment, "speech", "") or "")
                    )
                    for segment in raw_segments
                )
                if not any(speech.strip() for speech in speech_segments):
                    return

                work = {
                    "phase": phase,
                    "speech_segments": speech_segments,
                    "tts_bindings_by_index": {},
                    "segment_result_futures": {
                        index: asyncio.get_running_loop().create_future()
                        for index, speech in enumerate(speech_segments) if speech.strip()
                    },
                }
                for future in work["segment_result_futures"].values():
                    future.add_done_callback(lambda result: result.exception() if not result.cancelled() else None)

                async def _generate_for_persona_result():
                    generation_task = asyncio.current_task()
                    try:
                        result_map = await generate_independent_motion_for_segments(
                            event,
                            bundle,
                            speech_segments=speech_segments,
                            persona_result_id=persona_result_id,
                            segment_intents=tuple({
                                "actions": list(getattr(segment, "actions", ()) or ()),
                                "tendency": dict(getattr(segment, "tendency", {}) or {}),
                            } for segment in raw_segments),
                            parallel=bool(
                                getattr(
                                    bundle.runtime_state,
                                    "independent_motion_parallel",
                                    False,
                                )
                            ),
                            tasks=self._independent_motion_tasks,
                            segment_result_futures=work["segment_result_futures"],
                        )
                        for index, future in work["segment_result_futures"].items():
                            if not future.done():
                                future.set_result(result_map.get(index))
                        if event.get_extra("agent_stop_requested", False):
                            logger.debug(
                                "WIRING independent_motion.segment_results_discarded "
                                "reason=turn_terminated turn_id=%s persona_result_id=%s",
                                turn_id,
                                persona_result_id,
                            )
                            return {}
                        return result_map
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "WIRING independent_motion.segment_generation_failed "
                            "turn_id=%s persona_result_id=%s error=%s",
                            turn_id,
                            persona_result_id,
                            exc,
                            exc_info=True,
                        )
                        return {}
                    finally:
                        for future in work["segment_result_futures"].values():
                            if not future.done():
                                future.cancel() if event.get_extra("agent_stop_requested", False) else future.set_result(None)
                        if isinstance(generation_task, asyncio.Task):
                            untrack_motion_generation_task(
                                bundle.runtime_state,
                                turn_id=turn_id,
                                task=generation_task,
                            )

                generation_task = asyncio.create_task(
                    _generate_for_persona_result(),
                    name=f"ag99live-persona-motion-{persona_result_id[:12]}",
                )
                if not track_motion_generation_task(
                    bundle.runtime_state,
                    turn_id=turn_id,
                    task=generation_task,
                ):
                    generation_task.cancel()
                    logger.warning(
                        "WIRING independent_motion.segment_generation_skipped "
                        "reason=task_tracking_unavailable turn_id=%s",
                        turn_id,
                    )
                    return
                self._independent_motion_tasks.add(generation_task)
                generation_task.add_done_callback(
                    self._independent_motion_tasks.discard
                )
                work["task"] = generation_task
                if not store_persona_motion_work(
                    bundle.runtime_state,
                    turn_id=turn_id,
                    persona_result_id=persona_result_id,
                    work=work,
                ):
                    generation_task.cancel()
                    logger.warning(
                        "WIRING independent_motion.segment_generation_skipped "
                        "reason=persona_result_id_conflict turn_id=%s "
                        "persona_result_id=%s",
                        turn_id,
                        persona_result_id,
                    )
                    return
                logger.debug(
                    "WIRING independent_motion.segment_generation_started "
                    "turn_id=%s persona_result_id=%s phase=%s segment_count=%s",
                    turn_id,
                    persona_result_id,
                    phase,
                    len(speech_segments),
                )
                return

            generated_result = event.get_extra(INDEPENDENT_MOTION_RESULT_EXTRA_KEY)
            if (
                isinstance(generated_result, IndependentMotionResult)
                and not event.get_extra("agent_stop_requested", False)
            ):
                stored = store_motion_result_for_turn(
                    bundle.runtime_state,
                    turn_id=str(event.get_extra("_turn_id") or ""),
                    result=generated_result,
                    assistant_text=str(getattr(result, "speech", "") or ""),
                )
                if not stored:
                    logger.warning(
                        "WIRING independent_motion.result_not_stored turn_id=%s",
                        event.get_extra("_turn_id") or "<missing>",
                    )
                event.set_extra(INDEPENDENT_MOTION_RESULT_EXTRA_KEY, None)
            elif generated_result is not None:
                event.set_extra(INDEPENDENT_MOTION_RESULT_EXTRA_KEY, None)

    async def terminate(self) -> None:
        tasks = list(self._independent_motion_tasks)
        self._independent_motion_tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def _configure_noisy_loggers() -> None:
    for logger_name in (
        "pyffmpeg",
        "pyffmpeg.FFmpeg",
        "pyffmpeg.misc.Paths",
    ):
        logging.getLogger(logger_name).setLevel(logging.CRITICAL)
