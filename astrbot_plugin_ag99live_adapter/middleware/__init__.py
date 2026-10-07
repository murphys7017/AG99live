from typing import Any

from astrbot.api import logger

from ..core_compatibility import (
    get_interaction_capabilities,
    supports_llm_response_hook,
    supports_interaction_contributors,
)


def register_ag99live_interaction_contributors(context: Any) -> bool:
    supported = supports_interaction_contributors(context)
    if not supported:
        required_methods = (
            "register_persona_effect",
            "register_prompt_extension_collector",
            "register_interaction_result_contributor",
            "remove_prompt_extension_collectors_by_module_prefix",
            "remove_interaction_result_contributors_by_module_prefix",
            "unregister_persona_effects",
        )
        missing_methods = [
            name for name in required_methods if not callable(getattr(context, name, None))
        ]
        logger.warning(
            "WIRING interaction.contributors_registration_failed "
            "capabilities_available=%s llm_response_hook_available=%s "
            "missing_context_methods=%s context_type=%s",
            get_interaction_capabilities() is not None,
            supports_llm_response_hook(),
            ",".join(missing_methods) or "<none>",
            type(context).__name__,
        )
        return False

    from .interaction_motion import (
        register_ag99live_interaction_contributors as _register_motion_contributors,
    )

    _remove_existing_ag99live_interaction_contributors(context)
    _register_motion_contributors(context)
    logger.info(
        "WIRING interaction.contributors_registered context_type=%s "
        "capabilities_available=true",
        type(context).__name__,
    )
    return True


def _remove_existing_ag99live_interaction_contributors(context: Any) -> None:
    module_prefixes = _registration_module_prefixes()
    remover_names = (
        "remove_prompt_extension_collectors_by_module_prefix",
        "remove_interaction_result_contributors_by_module_prefix",
    )
    for remover_name in remover_names:
        remover = getattr(context, remover_name, None)
        if not callable(remover):
            continue
        for module_prefix in module_prefixes:
            remover(module_prefix)


def _registration_module_prefixes() -> tuple[str, ...]:
    candidates = [
        __name__,
        "astrbot_plugin_ag99live_adapter.middleware",
        "data.plugins.astrbot_plugin_ag99live_adapter.middleware",
    ]
    return tuple(dict.fromkeys(prefix for prefix in candidates if prefix))


__all__ = ["register_ag99live_interaction_contributors"]
