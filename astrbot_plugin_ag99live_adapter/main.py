import logging
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import Plain
from astrbot.api.provider import ProviderRequest
from astrbot.api.star import Context, Star

from .middleware import register_ag99live_interaction_contributors
from .motion.output_sanitizer import (
    contains_hidden_output_markup,
    sanitize_assistant_output_text,
)


def _optional_tts_state_hook():
    hook = getattr(filter, "on_tts_state_changed", None)
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

        _configure_noisy_loggers()
        set_plugin_context(context)
        set_plugin_config(self.config)

        from .platform_adapter import OLVPetPlatformAdapter  # noqa: F401

        self._official_core_compatibility = not register_ag99live_interaction_contributors(
            context
        )
        if self._official_core_compatibility:
            logger.info(
                "AG99live official AstrBot compatibility enabled: "
                "Persona Effect and TTS lifecycle hooks are unavailable; "
                "using <@anim> V4 and final Record audio facts; "
                "optional performance curve generation is disabled."
            )

    @filter.on_llm_request()
    async def arbitrate_remote_operator_tools(
        self,
        event: AstrMessageEvent,
        request: ProviderRequest,
    ) -> None:
        if self._official_core_compatibility:
            from .middleware.interaction_motion import (
                append_official_inline_motion_prompt,
            )

            append_official_inline_motion_prompt(event, request)
            return

        from .middleware.remote_operator import (
            arbitrate_remote_operator_tools_for_request,
        )

        arbitrate_remote_operator_tools_for_request(event, request)

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
        if state.status == "generating":
            from .middleware.interaction_motion import (
                start_deferred_performance_curve_request,
            )

            start_deferred_performance_curve_request(
                event,
                turn_id=state.turn_id,
                message_id=state.message_id,
                tts_request_id=state.tts_request_id,
                external_correlation_id=state.external_correlation_id,
            )

    @filter.after_message_sent()
    async def complete_official_output_turn(
        self,
        event: AstrMessageEvent,
    ) -> None:
        if not self._official_core_compatibility:
            return
        if str(event.get_platform_name() or "").strip() != "olv_pet_adapter":
            return
        complete = getattr(event, "complete_visible_turn", None)
        if callable(complete):
            await complete()


def _configure_noisy_loggers() -> None:
    for logger_name in (
        "pyffmpeg",
        "pyffmpeg.FFmpeg",
        "pyffmpeg.misc.Paths",
    ):
        logging.getLogger(logger_name).setLevel(logging.CRITICAL)
