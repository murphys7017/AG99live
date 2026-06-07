from typing import Any


def register_ag99live_interaction_contributors(context: Any) -> None:
    from .interaction_motion import (
        register_ag99live_interaction_contributors as _register_motion_contributors,
    )
    from .remote_operator import register_remote_operator_interaction_contributors

    _remove_existing_ag99live_interaction_contributors(context)
    _register_motion_contributors(context)
    register_remote_operator_interaction_contributors(context)


def _remove_existing_ag99live_interaction_contributors(context: Any) -> None:
    module_prefixes = _registration_module_prefixes()
    remover_names = (
        "remove_prompt_extension_collectors_by_module_prefix",
        "remove_interaction_prompt_contributors_by_module_prefix",
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
