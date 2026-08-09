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
    if (
        InteractionResultContribution is None
        or PromptExtension is None
        or PersonaEffectSpec is None
        or not callable(get_interaction_reply_plan)
        or not callable(getattr(context, "register_persona_effect", None))
    ):
        raise RuntimeError("astrbot_interaction_contributors_unavailable")

    _register_ag99live_motion_persona_effect(context)

    register_prompt = getattr(context, "register_interaction_prompt_contributor", None)
    if callable(register_prompt):
        register_prompt(AG99liveMotionPromptContributor())

    register_result = getattr(context, "register_interaction_result_contributor", None)
    if callable(register_result):
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
