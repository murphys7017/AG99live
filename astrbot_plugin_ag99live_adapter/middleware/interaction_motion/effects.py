from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ...core_compatibility import get_interaction_capabilities
from ...motion.motion_intent import resolve_selected_semantic_axis_profile
from ...motion.payload_validation import (
    normalize_motion_arguments_payload as _payload_normalize_motion_arguments_payload,
)
from ...motion.resource_catalog import build_motion_resource_candidates
from ...prompts.semantic_axis_prompt import (
    profile_prompt_axes,
    resolve_available_axis_levels,
)
from .shared import (
    AG99LIVE_MOTION_EFFECT_NAME,
    AG99LIVE_PLUGIN_ID,
    _append_resolution_reason,
    _call_event_method,
    _resolve_motion_runtime_bundle,
    _resolve_result_phase,
    _sanitize_reason_fragment,
    _thaw_snapshot_value,
)


def _register_ag99live_motion_persona_effect(context: Any) -> None:
    capabilities = get_interaction_capabilities()
    if capabilities is None:
        return

    unregister_effects = getattr(context, "unregister_persona_effects", None)
    if callable(unregister_effects):
        unregister_effects(plugin_id=AG99LIVE_PLUGIN_ID)

    register_effect = getattr(context, "register_persona_effect", None)
    if not callable(register_effect):
        return

    register_effect(
        capabilities.persona_effect_spec(
            plugin_id=AG99LIVE_PLUGIN_ID,
            name=AG99LIVE_MOTION_EFFECT_NAME,
            description=(
                "Generate Live2D motion intent for persona expression. This effect "
                "is mandatory exactly once for every assistant segment, including "
                "greetings, short acknowledgements, and neutral replies. Describe "
                "the visible performance with intent_tags and valid semantic axis "
                "levels; intent_tags alone is invalid. Every call must select exactly "
                "one execution shape: axis_levels, motion_steps, or a listed "
                "motion_resource_id. "
                "When the intended performance includes turning, tilting, swaying, "
                "nodding, or leaning, express the corresponding head and body axes "
                "together; omit body axes when no body posture is intended. "
                "Select at most one typed resource when appropriate and never split "
                "a movement sequence into multiple effects."
            ),
            metadata={
                "required_per_segment": True,
                "exactly_one_per_segment": True,
            },
            parameters={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "intent_tags": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "axis_levels": {
                        "type": "object",
                        "additionalProperties": {"type": "integer"},
                    },
                },
                "required": ["intent_tags"],
            },
            parameters_resolver=_build_ag99live_motion_effect_parameters,
        ),
        event_filter=_is_ag99live_motion_effect_event,
    )


def _build_ag99live_motion_effect_parameters(event: Any) -> dict[str, Any]:
    bundle = _resolve_motion_runtime_bundle(event)
    if bundle is None:
        raise RuntimeError("ag99live_motion_runtime_unavailable")

    semantic_profile = resolve_selected_semantic_axis_profile(
        runtime_state=bundle.runtime_state,
        require_prompt_axes=True,
    )
    axis_properties = {
        axis_id: {
            "type": "integer",
            "enum": resolve_available_axis_levels(axis),
        }
        for axis in profile_prompt_axes(semantic_profile)
        if (axis_id := str(axis.get("id") or "").strip())
    }
    if not axis_properties:
        raise RuntimeError("ag99live_motion_profile_axes_empty")

    axis_levels_schema = {
        "type": "object",
        "properties": axis_properties,
        "additionalProperties": False,
        "minProperties": 1,
        "maxProperties": min(6, len(axis_properties)),
    }
    expression_resource_ids = _resource_ids_for_schema(
        bundle.runtime_state,
        resource_type="expression",
    )
    motion_resource_ids = _resource_ids_for_schema(
        bundle.runtime_state,
        resource_type="motion",
    )
    properties: dict[str, Any] = {
        "intent_tags": {
            "type": "array",
            "minItems": 1,
            "maxItems": 6,
            "uniqueItems": True,
            "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
            },
        },
        "axis_levels": axis_levels_schema,
        "motion_steps": {
            "type": "array",
            "minItems": 2,
            "maxItems": 4,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "axis_levels": axis_levels_schema,
                    "duration_weight": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 3,
                    },
                },
                "required": ["axis_levels", "duration_weight"],
            },
        },
        "duration_hint_ms": {
            "type": "integer",
            "minimum": 320,
            "maximum": 15000,
        },
    }
    if expression_resource_ids:
        properties["expression_resource_id"] = {
            "type": "string",
            "enum": expression_resource_ids,
        }
    if motion_resource_ids:
        properties["motion_resource_id"] = {
            "type": "string",
            "enum": motion_resource_ids,
        }

    execution_shapes: list[dict[str, Any]] = [
        {
            "allOf": [
                {"required": ["axis_levels"]},
                {"not": {"required": ["motion_steps"]}},
                {"not": {"required": ["motion_resource_id"]}},
            ]
        },
        {
            "allOf": [
                {"required": ["motion_steps"]},
                {"not": {"required": ["axis_levels"]}},
                {"not": {"required": ["motion_resource_id"]}},
            ]
        },
    ]
    if motion_resource_ids:
        execution_shapes.append(
            {
                "allOf": [
                    {"required": ["motion_resource_id"]},
                    {"not": {"required": ["axis_levels"]}},
                    {"not": {"required": ["motion_steps"]}},
                ]
            }
        )
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": ["intent_tags"],
        "oneOf": execution_shapes,
        "allOf": [
            {
                "not": {
                    "required": [
                        "expression_resource_id",
                        "motion_resource_id",
                    ],
                },
            },
            {
                "not": {
                    "required": [
                        "motion_steps",
                        "motion_resource_id",
                    ],
                },
            },
        ],
    }


def _resource_ids_for_schema(runtime_state: Any, *, resource_type: str) -> list[str]:
    return sorted(
        {
            str(candidate.get("resource_id") or "").strip()
            for candidate in build_motion_resource_candidates(runtime_state=runtime_state)
            if isinstance(candidate, Mapping)
            and candidate.get("resource_type") == resource_type
            and str(candidate.get("resource_id") or "").strip()
        }
    )


def _is_ag99live_motion_effect_event(event: Any) -> bool:
    if _resolve_motion_runtime_bundle(event) is None:
        return False

    get_extra = getattr(event, "get_extra", None)
    if callable(get_extra) and (
        get_extra("ag99live_input_source") == "remote_operator_result"
    ):
        return False

    message_obj = getattr(event, "message_obj", None)
    raw_message = getattr(message_obj, "raw_message", None)
    if isinstance(raw_message, Mapping):
        return raw_message.get("ag99live_input_source") != "remote_operator_result"
    return True

def _resolve_persona_effect_motion_payload_with_reason(
    event: Any,
    runtime_state: Any,
    *,
    view: Any = None,
) -> tuple[dict[str, Any] | None, str]:
    raw_arguments, effect_reason = _extract_ag99live_motion_effect_arguments(event, view)
    if raw_arguments is None:
        return None, effect_reason
    return _normalize_motion_arguments_payload(
        raw_arguments,
        runtime_state,
        base_reason=effect_reason,
    )

def _normalize_motion_arguments_payload(
    raw_motion_arguments: dict[str, Any],
    runtime_state: Any,
    *,
    base_reason: str,
) -> tuple[dict[str, Any] | None, str]:
    return _payload_normalize_motion_arguments_payload(
        raw_motion_arguments,
        runtime_state,
        base_reason=base_reason,
        append_resolution_reason=_append_resolution_reason,
        sanitize_reason_fragment=_sanitize_reason_fragment,
    )

def _extract_ag99live_motion_effect_arguments(event: Any, view: Any) -> tuple[dict[str, Any] | None, str]:
    effect_calls = _extract_effect_calls_for_motion(event, view)
    if not effect_calls:
        return None, "effect_calls_missing"

    matching_calls = []
    for raw_call in effect_calls:
        call = _thaw_snapshot_value(raw_call)
        name = _effect_call_get(call, "name")
        if str(name or "").strip() != AG99LIVE_MOTION_EFFECT_NAME:
            continue
        matching_calls.append(call)

    if len(matching_calls) > 1:
        return None, "persona_effect_duplicate"

    if matching_calls:
        call = matching_calls[0]
        arguments = _effect_call_get(call, "arguments")
        arguments = _thaw_snapshot_value(arguments)
        if isinstance(arguments, Mapping):
            return {
                str(key): _thaw_snapshot_value(value)
                for key, value in arguments.items()
            }, "persona_effect"
        return None, "persona_effect_arguments_invalid"

    return None, "ag99live_motion_effect_missing"

def _extract_effect_calls_for_motion(event: Any, view: Any) -> list[Any]:
    if _resolve_result_phase(view) == "final":
        raw_calls = _call_event_method(
            event,
            "get_extra",
            "_interaction_final_response_effect_calls",
            None,
        )
        thawed_calls = _thaw_snapshot_value(raw_calls)
        if isinstance(thawed_calls, list):
            return thawed_calls
    return _extract_effect_calls_from_view(view)

def _extract_effect_calls_from_view(view: Any) -> list[Any]:
    raw_calls = getattr(view, "effect_calls", None)
    if raw_calls is None:
        metadata = getattr(view, "metadata", None)
        if isinstance(metadata, Mapping):
            raw_calls = metadata.get("effect_calls")
        elif callable(getattr(metadata, "get", None)):
            raw_calls = metadata.get("effect_calls")
    if raw_calls is None:
        result = getattr(view, "result", None)
        if result is not None:
            raw_calls = getattr(result, "effect_calls", None)

    thawed = _thaw_snapshot_value(raw_calls)
    if isinstance(thawed, list):
        return thawed
    return []

def _effect_call_get(call: Any, key: str) -> Any:
    if isinstance(call, Mapping):
        return call.get(key)
    return getattr(call, key, None)
