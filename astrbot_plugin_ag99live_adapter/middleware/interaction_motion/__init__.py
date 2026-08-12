from __future__ import annotations

from typing import Any

from .compatibility import (
    InteractionResultContribution,
    PersonaEffectSpec,
    PromptExtension,
    get_interaction_reply_plan,
)
from .effects import _register_ag99live_motion_persona_effect
from .prompt import (
    AG99liveMotionPromptContributor,
    append_official_inline_motion_prompt,
)
from .scheduling import (
    AG99liveMotionResultContributor,
    start_deferred_performance_curve_request,
)


def register_ag99live_interaction_contributors(context: Any) -> None:
    _register_ag99live_motion_persona_effect(context)
    register_prompt = context.register_interaction_prompt_contributor
    register_result = context.register_interaction_result_contributor
    register_prompt(AG99liveMotionPromptContributor())
    register_result(AG99liveMotionResultContributor())


__all__ = [
    "InteractionResultContribution",
    "PersonaEffectSpec",
    "PromptExtension",
    "append_official_inline_motion_prompt",
    "get_interaction_reply_plan",
    "register_ag99live_interaction_contributors",
    "start_deferred_performance_curve_request",
]
