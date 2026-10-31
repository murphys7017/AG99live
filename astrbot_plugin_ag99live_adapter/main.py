import asyncio
import logging
import time
from collections.abc import Mapping
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import Plain
from astrbot.api.star import Context, Star

from .middleware import register_ag99live_interaction_contributors
from .motion.output_sanitizer import (
    contains_hidden_output_markup,
    sanitize_assistant_output_segment_text,
    sanitize_assistant_output_text,
)
from .motion.observation import resolve_persona_motion_source_route
from .runtime.persona_lifecycle import (
    PersonaExpressionFrame,
    PersonaTurnIdentity,
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
        from .runtime.plugin_runtime import (
            prune_retired_plugin_config_fields,
            set_plugin_config,
            set_plugin_context,
        )

        self.context = context
        self.config = config if config is not None else {}
        self._independent_motion_tasks: set[asyncio.Task] = set()

        _configure_noisy_loggers()
        removed_config_fields = prune_retired_plugin_config_fields(self.config)
        if removed_config_fields:
            save_config = getattr(self.config, "save_config", None)
            if callable(save_config):
                save_config()
            logger.info(
                "Removed retired AG99live adapter config fields: %s",
                ",".join(sorted(removed_config_fields)),
            )
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
        self._enhanced_interaction_unavailable = not contributors_registered
        logger.debug(
            "WIRING interaction.plugin_initialized contributors_registered=%s "
            "enhanced_interaction_unavailable=%s "
            "context_type=%s",
            contributors_registered,
            self._enhanced_interaction_unavailable,
            type(context).__name__,
        )
        from .web_control import register_web_control_page

        self._web_control_page_registered = register_web_control_page(context, self)
        if self._enhanced_interaction_unavailable:
            logger.info(
                "AG99live enhanced interaction is unavailable; "
                "motion generation and performance curves are disabled."
            )

    async def initialize(self) -> None:
        from .runtime.desktop_observation import DesktopObservationRuntime

        self._desktop_observation = DesktopObservationRuntime(self.context)
        self._desktop_observation.start()
        from .runtime.desktop_presence import DesktopPresenceRuntime

        self._desktop_presence = DesktopPresenceRuntime(self.context)
        self._desktop_presence.start()

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
        if self._enhanced_interaction_unavailable:
            return
        if str(event.get_platform_name() or "").strip() != "olv_pet_adapter":
            return
        if state.stage != "interaction.outbound_tts":
            return
        self._record_persona_tts_identity(event, state)
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

    @staticmethod
    def _record_persona_tts_identity(
        event: AstrMessageEvent,
        state: Any,
    ) -> None:
        from .middleware.interaction_motion.shared import _resolve_motion_runtime_bundle
        from .motion.observation import (
            record_persona_motion_sample,
            resolve_persona_core_turn_id,
            resolve_persona_delivery_mode,
            resolve_persona_motion_source_route,
        )

        bundle = _resolve_motion_runtime_bundle(event)
        if bundle is None:
            return
        delivery_mode = resolve_persona_delivery_mode(event)
        if delivery_mode == "M2_olv_incremental":
            return

        turn_id = str(getattr(state, "turn_id", "") or "").strip()
        persona_result_id = str(
            getattr(state, "persona_result_id", "") or ""
        ).strip()
        message_id = str(getattr(state, "message_id", "") or "").strip()
        tts_request_id = str(
            getattr(state, "tts_request_id", "") or ""
        ).strip()
        segment_index = getattr(state, "persona_segment_index", None)
        segment_count = getattr(state, "persona_segment_count", None)
        if (
            not turn_id
            or not persona_result_id
            or not message_id
            or not tts_request_id
            or type(segment_index) is not int
            or segment_index < 0
            or type(segment_count) is not int
            or segment_count <= segment_index
        ):
            return

        runtime_state = bundle.runtime_state
        source_route = resolve_persona_motion_source_route(
            event,
            runtime_state,
        )
        if source_route is None:
            return
        result_state = runtime_state.persona_sessions.get_result(
            PersonaTurnIdentity(turn_id),
            persona_result_id,
        )
        segment_state = (
            result_state.segments.get(segment_index)
            if result_state is not None
            else None
        )
        persona_segment: dict[str, Any] = {"speech_state": "identity_only"}
        if segment_state is not None:
            if isinstance(segment_state.speech, str):
                persona_segment["speech"] = segment_state.speech
                persona_segment["speech_state"] = (
                    "ready" if segment_state.speech_ready else "not_yet_ready"
                )
            if segment_state.intent_ready:
                persona_segment["actions"] = list(segment_state.actions)
                persona_segment["tendency"] = dict(segment_state.tendency)

        get_extra = getattr(event, "get_extra", None)
        user_text = (
            get_extra("ag99live_original_message_str", "")
            if callable(get_extra)
            else ""
        ) or getattr(event, "message_str", "") or ""
        record_persona_motion_sample(
            getattr(runtime_state, "motion_lab_recorder", None),
            turn_id=turn_id,
            core_turn_id=resolve_persona_core_turn_id(event),
            persona_result_id=persona_result_id,
            segment_index=segment_index,
            segment_count=segment_count,
            segment_message_id=message_id,
            source_route=source_route,
            delivery_mode=delivery_mode,
            record_stage="segment_identity",
            record_key=f"segment-identity:{message_id}",
            input_context={
                "user_text": str(user_text),
                "capture_kind": "core_tts_identity_snapshot",
                "provider_prompt_available": False,
            },
            persona_segment=persona_segment,
            motion={
                "status": "tts_identity_observed",
                "tts_request_id": tts_request_id,
                "tts_state": str(getattr(state, "status", "") or "unknown"),
            },
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
            self._enhanced_interaction_unavailable
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
        )
        from .middleware.interaction_motion.shared import _resolve_motion_runtime_bundle

        def motion_budget_seconds() -> float:
            try:
                return resolve_stream_motion_budget_seconds(
                    bundle.runtime_state, event=event
                )
            except TypeError as exc:
                if "unexpected keyword argument" not in str(exc):
                    raise
                return resolve_stream_motion_budget_seconds(bundle.runtime_state)

        bundle = _resolve_motion_runtime_bundle(event)
        if (
            bundle is None
            or resolve_persona_motion_source_route(
                event,
                bundle.runtime_state,
                capture_if_missing=True,
            )
            != "independent_motion"
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

        turn_identity = PersonaTurnIdentity(normalized_turn_id)
        expression_frame = PersonaExpressionFrame.from_values(
            turn=turn_identity,
            persona_result_id=normalized_result_id,
            segment_index=segment_index,
            segment_message_id=normalized_parent_id,
            phase=str(intent.get("phase") or "").strip(),
            intent_ready=True,
            actions=actions,
            tendency=tendency,
        )
        registry = bundle.runtime_state.persona_sessions
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
        result_state = registry.session(
            expression_frame.identity.turn
        ).result(
            normalized_result_id,
            phase=expression_frame.phase,
            parent_message_id=normalized_parent_id,
            parallel=parallel,
            max_concurrency=max_concurrency,
        )
        if segment_index != len(result_state.segments):
            return
        loop = asyncio.get_running_loop()
        try:
            segment_state = result_state.bind_expression(expression_frame)
        except (ValueError, RuntimeError) as exc:
            logger.warning(
                "WIRING independent_motion.intent_rejected reason=%s turn_id=%s "
                "persona_result_id=%s segment_index=%s",
                exc,
                normalized_turn_id,
                normalized_result_id,
                segment_index,
            )
            return
        if segment_state.result_future is None:
            segment_state.result_future = loop.create_future()

        # The intent hook can arrive before Core has produced the segment
        # speech. Unless explicitly enabled, defer Provider generation to the
        # segment-ready hook so the action model sees the actual speech and can
        # choose motion_steps from the completed phrase.
        if not bool(
            getattr(
                bundle.runtime_state,
                "independent_motion_stream_preview_enabled",
                False,
            )
        ):
            logger.debug(
                "WIRING independent_motion.intent_preview_deferred "
                "turn_id=%s persona_result_id=%s segment_index=%s reason=segment_speech_not_ready",
                normalized_turn_id,
                normalized_result_id,
                segment_index,
            )
            return

        segment_state.deadline = loop.time() + motion_budget_seconds()

        if not isinstance(result_state.context_task, asyncio.Task):
            async def _prepare_preview_context() -> Any:
                try:
                    return await await_with_hard_deadline(
                        _prepare_independent_motion_context(
                            event,
                            bundle,
                        ),
                        motion_budget_seconds(),
                        background_tasks=result_state.tasks,
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
            result_state.context_task = context_task
            result_state.tasks.add(context_task)
            self._independent_motion_tasks.add(context_task)
            context_task.add_done_callback(result_state.tasks.discard)
            context_task.add_done_callback(self._independent_motion_tasks.discard)
            registry.register_result_task(
                PersonaTurnIdentity(normalized_turn_id),
                normalized_result_id,
                context_task,
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
                    timeout_seconds = motion_budget_seconds()
                    deadline = segment_state.deadline
                    if not isinstance(deadline, (int, float)):
                        deadline = loop.time() + timeout_seconds
                    prepared_context = None
                    context_task = result_state.context_task
                    if isinstance(context_task, asyncio.Task):
                        remaining = deadline - loop.time()
                        if remaining <= 0:
                            raise asyncio.TimeoutError
                        prepared_context = await await_with_hard_deadline(
                            asyncio.shield(context_task),
                            remaining,
                            background_tasks=result_state.tasks,
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
                                result_state.concurrency_gate.acquire(),
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
                                segment_intent={
                                    "actions": list(segment_state.actions),
                                    "tendency": dict(segment_state.tendency),
                                },
                                prepared_context=prepared_context,
                                persona_result_id=normalized_result_id,
                                segment_index=segment_index,
                                segment_message_id=normalized_parent_id,
                                shadow_tasks=self._independent_motion_tasks,
                            )
                            wait_stage = "provider"
                            result = await await_with_hard_deadline(
                                call,
                                remaining,
                                background_tasks=result_state.tasks,
                            )
                        finally:
                            if acquired:
                                result_state.concurrency_gate.release()
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
                if (
                    result is not None
                    and segment_state.result_future is not None
                    and not segment_state.result_future.done()
                ):
                    segment_state.result_future.set_result(result)
                publish_motion = getattr(
                    event,
                    "publish_interaction_incremental_motion",
                    None,
                )
                if result is not None and callable(publish_motion):
                    try:
                        await publish_motion(
                            persona_result_id=normalized_result_id,
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
                    result_state.tasks.discard(current_task)

        preview_task = asyncio.create_task(
            _generate_preview(),
            name=f"ag99live-persona-stream-intent-{normalized_result_id[:10]}-{segment_index}",
        )
        segment_state.preview_task = preview_task
        result_state.tasks.add(preview_task)
        self._independent_motion_tasks.add(preview_task)
        preview_task.add_done_callback(result_state.tasks.discard)
        preview_task.add_done_callback(self._independent_motion_tasks.discard)
        registry.register_result_task(
            PersonaTurnIdentity(normalized_turn_id),
            normalized_result_id,
            preview_task,
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
            self._enhanced_interaction_unavailable
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
        )
        from .middleware.interaction_motion.shared import (
            _resolve_motion_runtime_bundle,
        )
        from .motion.observation import resolve_persona_motion_source_route

        def motion_budget_seconds() -> float:
            try:
                return resolve_stream_motion_budget_seconds(
                    bundle.runtime_state, event=event
                )
            except TypeError as exc:
                if "unexpected keyword argument" not in str(exc):
                    raise
                return resolve_stream_motion_budget_seconds(bundle.runtime_state)

        bundle = _resolve_motion_runtime_bundle(event)
        if (
            bundle is None
            or resolve_persona_motion_source_route(
                event,
                bundle.runtime_state,
                capture_if_missing=True,
            )
            != "independent_motion"
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
        expression_frame = PersonaExpressionFrame.from_values(
            turn=PersonaTurnIdentity(normalized_turn_id),
            persona_result_id=normalized_result_id,
            segment_index=segment_index,
            segment_message_id=normalized_parent_id,
            phase=phase,
            speech=speech,
            actions=actions,
            tendency=tendency,
        )

        registry = bundle.runtime_state.persona_sessions
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
        result_state = registry.session(expression_frame.identity.turn).result(
            normalized_result_id,
            phase=expression_frame.phase,
            parent_message_id=normalized_parent_id,
            parallel=parallel,
            max_concurrency=max_concurrency,
        )
        if result_state.phase != phase:
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

        if segment_index != result_state.next_segment_index:
            logger.warning(
                "WIRING independent_motion.stream_segment_rejected "
                "reason=segment_index_nonsequential turn_id=%s "
                "persona_result_id=%s segment_index=%s expected_index=%s "
                "action=continue_core_dialogue",
                normalized_turn_id,
                normalized_result_id,
                segment_index,
                result_state.next_segment_index,
            )
            return
        result_state.next_segment_index += 1
        try:
            segment_state = result_state.bind_expression(expression_frame)
        except (ValueError, RuntimeError) as exc:
            logger.warning(
                "WIRING independent_motion.stream_segment_rejected "
                "reason=%s turn_id=%s persona_result_id=%s segment_index=%s",
                exc,
                normalized_turn_id,
                normalized_result_id,
                segment_index,
            )
            return

        from .motion.observation import (
            record_persona_motion_sample,
            resolve_persona_core_turn_id,
            resolve_persona_delivery_mode,
        )

        delivery_mode = resolve_persona_delivery_mode(event)
        if delivery_mode == "M2_olv_incremental":
            from .middleware.interaction_motion.independent import _dialogue_text

            current_user_text = str(getattr(event, "message_str", "") or "")
            record_persona_motion_sample(
                getattr(bundle.runtime_state, "motion_lab_recorder", None),
                turn_id=normalized_turn_id,
                core_turn_id=resolve_persona_core_turn_id(event),
                persona_result_id=normalized_result_id,
                segment_index=segment_index,
                segment_count=None,
                segment_message_id=normalized_parent_id,
                source_route="independent_motion",
                delivery_mode=delivery_mode,
                record_stage="persona_segment_ready",
                record_key=f"segment-ready:{normalized_parent_id}",
                input_context={
                    "user_text": _dialogue_text(current_user_text),
                    "capture_kind": "persona_segment_completion_snapshot",
                    "provider_prompt_available": False,
                },
                persona_segment={
                    "speech": speech,
                    "actions": actions,
                    "tendency": tendency,
                    "speech_state": "ready",
                },
                motion={
                    "status": "not_attached",
                    "reason": "persona_segment_completion_snapshot",
                },
            )

        result_future = segment_state.result_future
        if result_future is None:
            result_future = asyncio.get_running_loop().create_future()
            segment_state.result_future = result_future
        if segment_state.deadline is None:
            segment_state.deadline = (
                asyncio.get_running_loop().time() + motion_budget_seconds()
            )
        if segment_state.preview_task is not None:
            # The intent hook already started the action request before speech
            # generation reached segment_end. Keep that early result and let
            # TTS join it by the same segment future.
            return
        context_task = result_state.context_task
        if not isinstance(context_task, asyncio.Task):
            async def _prepare_context():
                try:
                    context_preparation = _prepare_independent_motion_context(
                        event, bundle
                    )
                    return await await_with_hard_deadline(
                        context_preparation,
                        motion_budget_seconds(),
                        background_tasks=result_state.tasks,
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
            result_state.context_task = context_task
            result_state.tasks.add(context_task)

        segment_intent = {
            "actions": list(segment_state.actions),
            "tendency": dict(segment_state.tendency),
        }

        async def _generate_segment() -> None:
            current_task = asyncio.current_task()
            result = None
            try:
                deadline = segment_state.deadline
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                async with asyncio.timeout(remaining), result_state.concurrency_gate:
                    context_timed_out = False
                    try:
                        deadline = segment_state.deadline
                        remaining = (
                            deadline - asyncio.get_running_loop().time()
                            if isinstance(deadline, (int, float))
                            else motion_budget_seconds()
                        )
                        if remaining <= 0:
                            raise asyncio.TimeoutError
                        prepared_context = await await_with_hard_deadline(
                            asyncio.shield(context_task),
                            remaining,
                            background_tasks=result_state.tasks,
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
                                parallel=result_state.parallel,
                                tasks=result_state.tasks,
                                persona_result_id=normalized_result_id,
                                prepared_context=prepared_context,
                                shadow_tasks=self._independent_motion_tasks,
                            ),
                            remaining,
                            background_tasks=result_state.tasks,
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
                            persona_result_id=normalized_result_id,
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
                    result_state.tasks.discard(current_task)

        generation_task = asyncio.create_task(
            _generate_segment(),
            name=(
                f"ag99live-persona-stream-motion-{normalized_result_id[:10]}-"
                f"{segment_index}"
            ),
        )
        if not registry.register_result_task(
            PersonaTurnIdentity(normalized_turn_id),
            normalized_result_id,
            generation_task,
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
        self._independent_motion_tasks.add(generation_task)
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

    @_optional_persona_expression_hook()
    async def handle_persona_expression_result(
        self,
        event: AstrMessageEvent,
        result: Any,
    ) -> None:
        if self._enhanced_interaction_unavailable:
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
            generate_independent_motion_for_segments,
            is_persona_expression_request,
            persona_expression_intent,
        )
        from .middleware.interaction_motion.shared import (
            _resolve_motion_runtime_bundle,
        )
        from .motion.observation import resolve_persona_motion_source_route

        bundle = _resolve_motion_runtime_bundle(event)
        if bundle is not None:
            if (
                resolve_persona_motion_source_route(
                    event,
                    bundle.runtime_state,
                    capture_if_missing=True,
                )
                == "independent_motion"
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

                sessions = bundle.runtime_state.persona_sessions
                result_state = sessions.session(turn_id).result(
                    persona_result_id,
                    phase=phase,
                    parallel=bool(
                        getattr(
                            bundle.runtime_state,
                            "independent_motion_parallel",
                            False,
                        )
                    ),
                    max_concurrency=max(
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
                    ),
                )
                result_state.set_expected_segment_count(len(speech_segments))
                expression_frames: list[PersonaExpressionFrame] = []
                for index, speech in enumerate(speech_segments):
                    raw_segment = raw_segments[index]
                    actions = getattr(raw_segment, "actions", ())
                    tendency = getattr(raw_segment, "tendency", {})
                    expression_frame = PersonaExpressionFrame.from_values(
                        turn=result_state.turn,
                        persona_result_id=persona_result_id,
                        segment_index=index,
                        segment_count=len(speech_segments),
                        phase=phase,
                        speech=speech,
                        actions=actions,
                        tendency=tendency,
                    )
                    expression_frames.append(expression_frame)
                    try:
                        segment_state = result_state.bind_expression(expression_frame)
                    except (ValueError, RuntimeError) as exc:
                        logger.warning(
                            "WIRING independent_motion.result_segment_rejected "
                            "reason=%s turn_id=%s persona_result_id=%s segment_index=%s",
                            exc,
                            turn_id,
                            persona_result_id,
                            index,
                        )
                        return
                    if speech.strip() and segment_state.result_future is None:
                        segment_state.result_future = (
                            asyncio.get_running_loop().create_future()
                        )

                async def _generate_for_persona_result():
                    generation_task = asyncio.current_task()
                    try:
                        result_map = await generate_independent_motion_for_segments(
                            event,
                            bundle,
                            speech_segments=speech_segments,
                            persona_result_id=persona_result_id,
                            segment_intents=tuple(
                                {
                                    "actions": list(frame.actions),
                                    "tendency": dict(frame.tendency),
                                }
                                for frame in expression_frames
                            ),
                            parallel=bool(
                                getattr(
                                    bundle.runtime_state,
                                    "independent_motion_parallel",
                                    False,
                                )
                            ),
                            tasks=result_state.tasks,
                            segments_by_index=result_state.segments,
                            shadow_tasks=self._independent_motion_tasks,
                        )
                        for index, segment_state in result_state.segments.items():
                            future = segment_state.result_future
                            if future is not None and not future.done():
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
                        for segment_state in result_state.segments.values():
                            future = segment_state.result_future
                            if future is not None and not future.done():
                                if event.get_extra("agent_stop_requested", False):
                                    future.cancel()
                                else:
                                    future.set_result(None)
                        if isinstance(generation_task, asyncio.Task):
                            result_state.tasks.discard(generation_task)

                generation_task = asyncio.create_task(
                    _generate_for_persona_result(),
                    name=f"ag99live-persona-motion-{persona_result_id[:12]}",
                )
                result_state.generation_task = generation_task
                if not sessions.register_result_task(
                    PersonaTurnIdentity(turn_id),
                    persona_result_id,
                    generation_task,
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
                logger.debug(
                    "WIRING independent_motion.segment_generation_started "
                    "turn_id=%s persona_result_id=%s phase=%s segment_count=%s",
                    turn_id,
                    persona_result_id,
                    phase,
                    len(speech_segments),
                )
                return

    async def terminate(self) -> None:
        presence = getattr(self, "_desktop_presence", None)
        if presence is not None:
            await presence.stop()
        observer = getattr(self, "_desktop_observation", None)
        if observer is not None:
            await observer.stop()
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
