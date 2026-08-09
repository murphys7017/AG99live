from __future__ import annotations

try:
    from astrbot.core.interaction import (
        InteractionResultContribution,
        get_interaction_route_decision as get_interaction_reply_plan,
    )
except ModuleNotFoundError as exc:
    if exc.name != "astrbot.core.interaction":
        raise
    InteractionResultContribution = None  # type: ignore[assignment]
    get_interaction_reply_plan = None  # type: ignore[assignment]
except ImportError as exc:
    if exc.name != "astrbot.core.interaction":
        raise
    InteractionResultContribution = None  # type: ignore[assignment]
    get_interaction_reply_plan = None  # type: ignore[assignment]

try:
    from astrbot.core.interaction import PersonaEffectSpec
except ModuleNotFoundError as exc:
    if exc.name != "astrbot.core.interaction":
        raise
    PersonaEffectSpec = None  # type: ignore[assignment]
except ImportError as exc:
    if exc.name != "astrbot.core.interaction":
        raise
    PersonaEffectSpec = None  # type: ignore[assignment]

try:
    from astrbot.core.prompt import PromptExtension
except ModuleNotFoundError as exc:
    if exc.name != "astrbot.core.prompt":
        raise
    PromptExtension = None  # type: ignore[assignment]
except ImportError as exc:
    if exc.name != "astrbot.core.prompt":
        raise
    PromptExtension = None  # type: ignore[assignment]
