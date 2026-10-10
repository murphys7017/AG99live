import asyncio
import logging
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
        return hook()

    def _identity(handler):
        return handler

    return _identity


def _optional_llm_response_hook():
    hook = getattr(filter, "on_llm_response", None)
    if callable(hook):
        return hook()

    def _identity(handler):
        return handler

    return _identity


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

        contributors_registered = register_ag99live_interaction_contributors(context)
        self._llm_response_hook_available = supports_llm_response_hook()
        self._official_core_compatibility = (
            not contributors_registered or not self._llm_response_hook_available
        )
        logger.info(
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
                "AG99live official AstrBot compatibility enabled: "
                "Persona Effect and TTS lifecycle hooks are unavailable; "
                "using <@anim> V4 and final Record audio facts; "
                "optional performance curve generation is disabled."
            )

    @filter.on_llm_request()
    async def append_official_inline_motion_prompt(
        self,
        event: AstrMessageEvent,
        request: ProviderRequest,
    ) -> None:
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
        logger.info(
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
        if (
            bundle is not None
            and bool(getattr(bundle.runtime_state, "independent_motion_enabled", False))
            and not self._official_core_compatibility
        ):
            if bool(
                getattr(
                    bundle.runtime_state,
                    "independent_motion_per_speech_segment",
                    False,
                )
            ):
                logger.info(
                    "WIRING independent_motion.request_hook mode=per_speech_segment "
                    "turn_id=%s; waiting for Persona speech segments",
                    event.get_extra("_turn_id") or "<missing>",
                )
                return
            if bool(
                getattr(bundle.runtime_state, "independent_motion_parallel", False)
            ):
                from .middleware.interaction_motion.independent import (
                    start_parallel_motion_generation,
                )

                start_parallel_motion_generation(
                    event,
                    bundle,
                    tasks=self._independent_motion_tasks,
                )
                # create_task() only queues the coroutine. Yield once so its
                # prompt preparation and provider request can overlap the main
                # model request instead of waiting for the next hook boundary.
                await asyncio.sleep(0)
            else:
                logger.info(
                    "WIRING independent_motion.request_hook mode=serial "
                    "turn_id=%s provider=%s",
                    event.get_extra("_turn_id") or "<missing>",
                    getattr(
                        bundle.runtime_state,
                        "independent_motion_provider_id",
                        "<missing>",
                    ),
                )
            return
        if independent_enabled and self._official_core_compatibility:
            reason = (
                "llm_response_hook_unavailable"
                if not self._llm_response_hook_available
                else "interaction_contributors_unavailable"
            )
            logger.warning(
                "WIRING independent_motion.disabled reason=%s; "
                "using_official_inline_motion turn_id=%s",
                reason,
                turn_id or "<missing>",
            )

        if not self._official_core_compatibility:
            logger.debug(
                "WIRING official_inline_motion.request_hook_skipped reason="
                "enhanced_interaction_available platform=%s turn_id=%s",
                platform_name or "<missing>",
                turn_id or "<missing>",
            )
            return

        from .middleware.interaction_motion import (
            append_official_inline_motion_prompt as append_prompt,
        )

        append_prompt(event, request)

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
        logger.info(
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
            logger.info(
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
                logger.info(
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
                logger.info(
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

    @filter.on_decorating_result()
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
            logger.info(
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
        if (
            state.stage != "interaction.outbound_tts"
            or state.status not in {"requested", "generating"}
        ):
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

        from .protocol.speech_cues import normalize_speech_cues

        raw_cues = getattr(result, "speech_cues", None)
        try:
            speech_cues = normalize_speech_cues(raw_cues)
        except ValueError as exc:
            speech_cues = []
            logger.warning(
                "WIRING speech_cues rejected turn_id=%s reason=%s",
                event.get_extra("_turn_id") or "<missing>",
                exc,
            )
        event.set_extra("_ag99live_pending_speech_cues", speech_cues)

        from .middleware.interaction_motion.independent import (
            INDEPENDENT_MOTION_RESULT_EXTRA_KEY,
            IndependentMotionResult,
            generate_independent_motion_for_segments,
            is_persona_expression_request,
            persona_expression_intent,
            store_motion_segment_batch,
            store_motion_result_for_turn,
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
                kind = str(intent.get("kind") or "").strip()
                raw_segments = getattr(result, "segments", ())
                speech_segments = tuple(
                    sanitize_assistant_output_segment_text(
                        str(getattr(segment, "speech", "") or "")
                    )
                    for segment in raw_segments
                )
                if not any(speech.strip() for speech in speech_segments):
                    return

                generation_task = asyncio.current_task()
                if not track_motion_generation_task(
                    bundle.runtime_state,
                    turn_id=turn_id,
                    task=generation_task,
                ):
                    logger.warning(
                        "WIRING independent_motion.segment_generation_skipped "
                        "reason=task_tracking_unavailable turn_id=%s",
                        turn_id,
                    )
                    return
                try:
                    result_map = await generate_independent_motion_for_segments(
                        event,
                        bundle,
                        speech_segments=speech_segments,
                        parallel=bool(
                            getattr(
                                bundle.runtime_state,
                                "independent_motion_parallel",
                                False,
                            )
                        ),
                        tasks=self._independent_motion_tasks,
                    )
                finally:
                    untrack_motion_generation_task(
                        bundle.runtime_state,
                        turn_id=turn_id,
                        task=generation_task,
                    )
                if event.get_extra("agent_stop_requested", False):
                    logger.info(
                        "WIRING independent_motion.segment_results_discarded "
                        "reason=turn_terminated turn_id=%s",
                        event.get_extra("_turn_id") or "<missing>",
                    )
                    return
                stored = store_motion_segment_batch(
                    bundle.runtime_state,
                    turn_id=turn_id,
                    phase=phase,
                    kind=kind,
                    speech_segments=speech_segments,
                    results_by_index=result_map,
                )
                if not stored:
                    logger.warning(
                        "WIRING independent_motion.segment_results_not_stored "
                        "reason=runtime_state_storage_failed turn_id=%s",
                        event.get_extra("_turn_id") or "<missing>",
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
