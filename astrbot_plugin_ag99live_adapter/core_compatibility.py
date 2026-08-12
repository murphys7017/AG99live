from __future__ import annotations

from typing import Any


def supports_interaction_contributors(context: Any) -> bool:
    try:
        from astrbot.core.interaction import (
            InteractionResultContribution,
            PersonaEffectSpec,
            get_interaction_route_decision,
        )
        from astrbot.core.prompt import PromptExtension
    except ModuleNotFoundError as exc:
        if exc.name not in {
            "astrbot.core",
            "astrbot.core.interaction",
            "astrbot.core.prompt",
        }:
            raise
        return False
    except ImportError as exc:
        if exc.name not in {
            "astrbot.core.interaction",
            "astrbot.core.prompt",
        }:
            raise
        return False

    return (
        InteractionResultContribution is not None
        and PersonaEffectSpec is not None
        and PromptExtension is not None
        and callable(get_interaction_route_decision)
        and callable(getattr(context, "register_persona_effect", None))
        and callable(
            getattr(context, "register_interaction_prompt_contributor", None)
        )
        and callable(
            getattr(context, "register_interaction_result_contributor", None)
        )
    )


__all__ = ["supports_interaction_contributors"]
