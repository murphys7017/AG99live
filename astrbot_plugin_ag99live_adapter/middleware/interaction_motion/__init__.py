from __future__ import annotations

from typing import Any

from ...core_compatibility import supports_interaction_result_event_filter
from .companion import AG99liveCompanionIdentityPromptContributor
from .effects import _register_ag99live_motion_persona_effect
from .prompt import AG99liveMotionPromptContributor
from .scheduling import (
    AG99liveMotionResultContributor,
    start_deferred_performance_curve_request,
)


def register_ag99live_interaction_contributors(
    context: Any,
    *,
    persona_effect_enabled: bool = True,
) -> None:
    _register_ag99live_motion_persona_effect(
        context,
        enabled=persona_effect_enabled,
    )
    register_prompt = context.register_prompt_extension_collector
    register_result = context.register_interaction_result_contributor
    register_prompt(AG99liveCompanionIdentityPromptContributor())
    register_prompt(AG99liveMotionPromptContributor())
    result_contributor = AG99liveMotionResultContributor()
    if supports_interaction_result_event_filter(context):
        register_result(
            result_contributor,
            event_filter=_include_legacy_motion_result_contributor,
        )
    else:
        register_result(result_contributor)


def _include_legacy_motion_result_contributor(event: Any) -> bool:
    return not bool(
        event.get_extra("_interaction_persona_segment_stream_requested", False)
    )


__all__ = [
    "register_ag99live_interaction_contributors",
    "start_deferred_performance_curve_request",
]
