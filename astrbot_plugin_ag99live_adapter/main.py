import logging

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import Plain
from astrbot.api.star import Context, Star

from .motion.output_sanitizer import (
    contains_hidden_output_markup,
    sanitize_assistant_output_text,
)


class MyPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        from .runtime.plugin_runtime import set_plugin_config, set_plugin_context

        self.context = context
        self.config = config if config is not None else {}

        _configure_noisy_loggers()
        set_plugin_context(context)
        set_plugin_config(self.config)

        # Import solely for side effect: the class decorator registers the adapter.
        from .platform_adapter import OLVPetPlatformAdapter  # noqa: F401

    @filter.on_llm_response()
    async def schedule_split_motion_after_llm_response(
        self,
        event: AstrMessageEvent,
        response,
    ) -> None:
        if str(event.get_platform_name() or "").strip() != "olv_pet_adapter":
            return

        adapter = getattr(event, "adapter", None)
        turn_coordinator = getattr(adapter, "turn_coordinator", None)
        runtime_state = getattr(turn_coordinator, "runtime_state", None)
        if turn_coordinator is None or runtime_state is None:
            return

        motion_generation_mode = str(
            getattr(runtime_state, "motion_generation_mode", "split_after_reply") or ""
        ).strip()
        if motion_generation_mode != "split_after_reply":
            return

        assistant_text = sanitize_assistant_output_text(
            str(getattr(response, "completion_text", "") or "")
        ).strip()
        if not assistant_text:
            return

        scheduled = turn_coordinator.schedule_motion_after_reply(
            assistant_text=assistant_text,
            origin_turn_id=getattr(turn_coordinator.session_state, "current_turn_id", None),
            source="on_llm_response",
        )
        if scheduled:
            event.set_extra("ag99live_split_motion_scheduled", True)

    @filter.on_decorating_result()
    async def sanitize_hidden_output_markup_before_tts(
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

            sanitized = sanitize_assistant_output_text(text)
            if sanitized == text:
                continue

            component.text = sanitized
            changed = True

        if not original_plain_texts:
            return

        raw_reply_text = "\n".join(original_plain_texts).strip()
        if changed and raw_reply_text:
            event.set_extra("ag99live_raw_reply_text", raw_reply_text)
            logger.info(
                "WIRING assistant_output_sanitized_before_tts=true platform=%s raw_len=%s",
                event.get_platform_name(),
                len(raw_reply_text),
            )

        adapter = getattr(event, "adapter", None)
        turn_coordinator = getattr(adapter, "turn_coordinator", None)
        runtime_state = getattr(turn_coordinator, "runtime_state", None)
        if turn_coordinator is None or runtime_state is None:
            return
        motion_generation_mode = str(
            getattr(runtime_state, "motion_generation_mode", "split_after_reply") or ""
        ).strip()
        if motion_generation_mode != "split_after_reply":
            return
        if bool(event.get_extra("ag99live_split_motion_scheduled", False)):
            return

        fallback_text = sanitize_assistant_output_text("\n".join(original_plain_texts)).strip()
        if not fallback_text:
            return
        if turn_coordinator.schedule_motion_after_reply(
            assistant_text=fallback_text,
            origin_turn_id=getattr(turn_coordinator.session_state, "current_turn_id", None),
            source="on_decorating_result_fallback",
        ):
            event.set_extra("ag99live_split_motion_scheduled", True)


def _configure_noisy_loggers() -> None:
    for logger_name in (
        "pyffmpeg",
        "pyffmpeg.FFmpeg",
        "pyffmpeg.misc.Paths",
    ):
        logging.getLogger(logger_name).setLevel(logging.CRITICAL)
