from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class InteractionCapabilities:
    interaction_result_contribution: type[Any]
    persona_effect_spec: type[Any]
    prompt_extension: type[Any]
    get_interaction_route_decision: Any


@dataclass(frozen=True, slots=True)
class PromptAnnotationCapabilities:
    input_item_annotations_extra_key: str
    input_text_annotation_key: str
    build_message_annotation_key: Any | None


def get_interaction_capabilities() -> InteractionCapabilities | None:
    """Return enhanced APIs only when the complete interaction contract exists."""
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
        return None
    except ImportError as exc:
        if exc.name not in {
            "astrbot.core.interaction",
            "astrbot.core.prompt",
        }:
            raise
        return None

    if not callable(get_interaction_route_decision):
        return None
    return InteractionCapabilities(
        interaction_result_contribution=InteractionResultContribution,
        persona_effect_spec=PersonaEffectSpec,
        prompt_extension=PromptExtension,
        get_interaction_route_decision=get_interaction_route_decision,
    )


def supports_interaction_contributors(context: Any) -> bool:
    return (
        get_interaction_capabilities() is not None
        and callable(getattr(context, "register_persona_effect", None))
        and callable(
            getattr(context, "register_interaction_prompt_contributor", None)
        )
        and callable(
            getattr(context, "register_interaction_result_contributor", None)
        )
    )


def get_prompt_annotation_capabilities() -> PromptAnnotationCapabilities:
    """Expose optional prompt annotations with official-Core defaults."""
    try:
        from astrbot.core.prompt import (
            INPUT_ITEM_ANNOTATIONS_EXTRA_KEY,
            INPUT_TEXT_ANNOTATION_KEY,
            build_message_annotation_key,
        )
    except ModuleNotFoundError as exc:
        if exc.name not in {"astrbot.core", "astrbot.core.prompt"}:
            raise
        return PromptAnnotationCapabilities(
            input_item_annotations_extra_key="prompt_input_item_annotations",
            input_text_annotation_key="input.text",
            build_message_annotation_key=None,
        )
    except ImportError as exc:
        if exc.name != "astrbot.core.prompt":
            raise
        return PromptAnnotationCapabilities(
            input_item_annotations_extra_key="prompt_input_item_annotations",
            input_text_annotation_key="input.text",
            build_message_annotation_key=None,
        )

    return PromptAnnotationCapabilities(
        input_item_annotations_extra_key=INPUT_ITEM_ANNOTATIONS_EXTRA_KEY,
        input_text_annotation_key=INPUT_TEXT_ANNOTATION_KEY,
        build_message_annotation_key=build_message_annotation_key,
    )


__all__ = [
    "InteractionCapabilities",
    "PromptAnnotationCapabilities",
    "get_interaction_capabilities",
    "get_prompt_annotation_capabilities",
    "supports_interaction_contributors",
]
