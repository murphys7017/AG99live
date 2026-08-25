from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .prompt_references import (
    _normalize_axis_text_list,
    _project_reference_examples_for_prompt,
    _truncate_text,
)
from .shared import (
    _MotionRuntimeBundle,
    _call_event_method,
    _normalize_optional_string,
    _resolve_frontend_identity_snapshot,
)
from ...motion.motion_intent import resolve_selected_semantic_axis_profile
from ...motion.observation import record_motion_observation
from ...motion.payload_validation import (
    build_prompt_axis_lookup,
    describe_axis_descriptor,
    resolve_axis_neutral_value,
)
from ...prompts.motion_selector import resolve_motion_reference_examples
from ...prompts.semantic_axis_prompt import (
    format_profile_axis_prompt_line,
    profile_prompt_axes,
    resolve_available_axis_levels,
)

PROMPT_VARIATION_AXIS_IDS = (
    "head_yaw",
    "head_roll",
    "head_pitch",
    "body_yaw",
    "body_roll",
    "body_pitch",
    "gaze_x",
    "gaze_y",
)

def _record_motion_prompt_reference_observation(
    *,
    bundle: _MotionRuntimeBundle,
    event: Any,
    capability_payload: dict[str, Any],
    runtime_payload: dict[str, Any],
    reference_diagnostics: list[str],
    source_route: str = "persona_effect",
) -> None:
    semantic_profile = capability_payload.get("semantic_profile")
    profile = semantic_profile if isinstance(semantic_profile, dict) else {}
    identity = _resolve_frontend_identity_snapshot(event)
    reference_examples = runtime_payload.get("reference_examples")
    record_motion_observation(
        getattr(bundle.runtime_state, "motion_lab_recorder", None),
        event_type="motion.prompt_reference_examples_resolved",
        conversation_uid=getattr(
            getattr(bundle.turn_coordinator, "session_state", None),
            "client_uid",
            None,
        ),
        turn_id=identity.scheduled_frontend_turn_id,
        frontend_turn_id=identity.event_frontend_turn_id,
        source_route=source_route,
        phase="prompt",
        model_name=str(profile.get("model_id") or "").strip(),
        profile_id=str(profile.get("profile_id") or "").strip(),
        profile_revision=profile.get("profile_revision"),
        user_text=_extract_motion_prompt_input_text(event),
        payload_kind="motion_reference_examples.v1",
        raw={
            "reference_examples": reference_examples
            if isinstance(reference_examples, list)
            else [],
            "reference_example_diagnostics": list(reference_diagnostics),
        },
    )

def _build_motion_runtime_reference_examples(
    *,
    event: Any,
    runtime_state: Any,
    capability_payload: dict[str, Any],
) -> dict[str, Any]:
    semantic_profile = capability_payload.get("semantic_profile")
    prompt_axes = (
        semantic_profile.get("prompt_axes")
        if isinstance(semantic_profile, dict)
        else None
    )
    if not isinstance(prompt_axes, list):
        raise RuntimeError("semantic_motion_prompt_axes_unavailable")
    allowed_axis_ids = {
        str(axis.get("id") or "").strip()
        for axis in prompt_axes
        if isinstance(axis, dict) and str(axis.get("id") or "").strip()
    }
    available_levels_by_axis = {
        str(axis.get("id") or "").strip(): set(axis.get("available_levels") or [])
        for axis in prompt_axes
        if isinstance(axis, dict) and str(axis.get("id") or "").strip()
    }
    if not allowed_axis_ids:
        raise RuntimeError("semantic_motion_prompt_axes_empty")
    resolution = resolve_motion_reference_examples(
        runtime_state=runtime_state,
        request_text=_extract_motion_prompt_input_text(event),
    )
    return {
        "examples": _project_reference_examples_for_prompt(
            resolution["examples"],
            allowed_axis_ids=allowed_axis_ids,
            available_levels_by_axis=available_levels_by_axis,
        ),
        "diagnostics": list(resolution["diagnostics"]),
    }

def _extract_motion_prompt_input_text(event: Any) -> str:
    original_text = _normalize_optional_string(
        _call_event_method(event, "get_extra", "ag99live_original_message_str", "")
    )
    if original_text:
        return original_text
    message_text = _normalize_optional_string(getattr(event, "message_str", None))
    if message_text:
        return message_text
    message_obj = getattr(event, "message_obj", None)
    return _normalize_optional_string(getattr(message_obj, "message_str", None)) or ""

def _build_motion_variation_payload(
    turn_coordinator: Any,
    *,
    runtime_state: Any,
) -> dict[str, Any]:
    history = _resolve_prompt_motion_history(turn_coordinator)
    if not history:
        return {}
    snapshot = history[-1]

    axis_levels = snapshot.get("axis_levels")
    motion_steps = snapshot.get("motion_steps")
    if isinstance(motion_steps, list) and motion_steps:
        last_step = motion_steps[-1]
        if isinstance(last_step, dict):
            axis_levels = last_step.get("axis_levels")
    axes = snapshot.get("axes")
    expression_resource_id = str(snapshot.get("expression_resource_id") or "").strip()
    motion_resource_id = str(snapshot.get("motion_resource_id") or "").strip()
    has_motion_shape = bool(
        isinstance(axis_levels, dict)
        or isinstance(axes, dict)
        or isinstance(motion_steps, list)
        or expression_resource_id
        or motion_resource_id
    )
    if not has_motion_shape:
        return {}

    axis_by_id = {}
    if isinstance(axes, dict):
        semantic_profile = resolve_selected_semantic_axis_profile(runtime_state=runtime_state)
        axis_by_id = build_prompt_axis_lookup(semantic_profile)

    key_axes: list[dict[str, Any]] = []
    key_axis_levels: dict[str, int] = {}
    for axis_id in PROMPT_VARIATION_AXIS_IDS:
        axis_level = axis_levels.get(axis_id) if isinstance(axis_levels, dict) else None
        if isinstance(axis_level, int) and not isinstance(axis_level, bool) and -4 <= axis_level <= 4:
            key_axes.append({"axis_id": axis_id, "level": axis_level})
            key_axis_levels[axis_id] = axis_level
            continue
        if not isinstance(axes, dict):
            continue
        axis_value = axes.get(axis_id)
        if not isinstance(axis_value, (int, float)) or isinstance(axis_value, bool):
            continue
        axis = axis_by_id.get(axis_id)
        descriptor = describe_axis_descriptor(axis_id, float(axis_value), axis=axis)
        if not descriptor:
            descriptor = "neutral_center"
        neutral = resolve_axis_neutral_value(axis) if isinstance(axis, dict) else 50.0
        key_axes.append(
            {
                "axis_id": axis_id,
                "value": round(float(axis_value), 2),
                "descriptor": descriptor,
                "neutral": round(neutral, 2),
            }
        )

    if not key_axes and not (motion_steps or expression_resource_id or motion_resource_id):
        return {}
    recent_motion_history: list[dict[str, Any]] = []
    repeated_directions: dict[tuple[str, int], int] = {}
    sequence_count = 0
    for history_snapshot in history:
        history_levels = _resolve_snapshot_axis_levels(history_snapshot)
        key_levels = {
            axis_id: level
            for axis_id, level in history_levels.items()
            if axis_id in PROMPT_VARIATION_AXIS_IDS
        }
        directions = {
            axis_id: 1 if level > 0 else -1
            for axis_id, level in key_levels.items()
            if level != 0
        }
        for axis_id, direction in directions.items():
            repeated_directions[(axis_id, direction)] = (
                repeated_directions.get((axis_id, direction), 0) + 1
            )
        is_sequence = isinstance(history_snapshot.get("motion_steps"), list)
        if is_sequence:
            sequence_count += 1
        intent_tags = history_snapshot.get("intent_tags")
        recent_motion_history.append(
            {
                "shape": "sequence" if is_sequence else (
                    "motion_resource"
                    if history_snapshot.get("motion_resource_id")
                    else (
                        "expression_resource"
                        if history_snapshot.get("expression_resource_id")
                        else "pose"
                    )
                ),
                "axis_directions": directions,
                "intent_tags": [
                    str(tag).strip()
                    for tag in intent_tags[:2]
                    if str(tag).strip()
                ] if isinstance(intent_tags, list) else [],
            }
        )

    repeated_direction_summary = [
        {
            "axis_id": axis_id,
            "direction": direction,
            "count": count,
        }
        for (axis_id, direction), count in sorted(repeated_directions.items())
        if count >= 2
    ]
    previous_motion = {
        "key_axis_levels": key_axis_levels,
        "key_axes": key_axes if not key_axis_levels else [],
        "expression_resource_id": expression_resource_id,
        "motion_resource_id": motion_resource_id,
        "was_sequence": bool(motion_steps),
        "guidance": "参考上一动作，但按本轮语义重新选择方向、幅度和身体重心，避免机械复刻。",
    }
    payload: dict[str, Any] = {
        "recent_motion_summary": {
            "recent_actions": recent_motion_history,
            "sequence_count": sequence_count,
            "sample_count": len(recent_motion_history),
            "repeated_directions": repeated_direction_summary,
            "guidance": (
                "优先根据本轮语义选择动作；语义允许时避免连续复用 repeated_directions 中的方向，"
                "并在 pose 与 sequence、头部轴与身体轴之间做自然变化。不要为了多样性强行反转语义方向。"
            ),
        },
    }
    if key_axes or motion_steps or expression_resource_id or motion_resource_id:
        payload["previous_motion"] = {
            key: value
            for key, value in previous_motion.items()
            if value not in (None, "", [], {}) or key in {"was_sequence", "guidance"}
        }
    return payload

def _resolve_prompt_motion_history(turn_coordinator: Any) -> list[dict[str, Any]]:
    get_history = getattr(turn_coordinator, "get_prompt_motion_history", None)
    if not callable(get_history):
        return []
    history = get_history()
    return [snapshot for snapshot in history if isinstance(snapshot, dict)]


def _resolve_snapshot_axis_levels(snapshot: dict[str, Any]) -> dict[str, int]:
    axis_levels = snapshot.get("axis_levels")
    motion_steps = snapshot.get("motion_steps")
    if isinstance(motion_steps, list) and motion_steps:
        last_step = motion_steps[-1]
        if isinstance(last_step, dict):
            axis_levels = last_step.get("axis_levels")
    if not isinstance(axis_levels, dict):
        return {}
    return {
        str(axis_id).strip(): level
        for axis_id, level in axis_levels.items()
        if str(axis_id).strip()
        and isinstance(level, int)
        and not isinstance(level, bool)
        and -4 <= level <= 4
    }

def _summarize_semantic_profile(
    runtime_state: Any,
) -> dict[str, Any]:
    semantic_profile = resolve_selected_semantic_axis_profile(runtime_state=runtime_state)
    prompt_axes = profile_prompt_axes(semantic_profile)
    return {
        "profile_id": str(semantic_profile.get("profile_id") or "").strip(),
        "profile_revision": int(semantic_profile.get("revision") or 0),
        "model_id": str(semantic_profile.get("model_id") or "").strip(),
        "axis_count": len(prompt_axes),
        "raw_profile": semantic_profile,
        "prompt_axes": [
            {
                "id": str(axis.get("id") or "").strip(),
                "label": str(axis.get("label") or axis.get("id") or "").strip(),
                "description": _truncate_text(
                    str(axis.get("description") or "").strip(), 160
                ),
                "control_role": str(axis.get("control_role") or "").strip(),
                "value_range": _normalize_axis_range(axis.get("value_range"), [0.0, 100.0]),
                "negative_semantics": _normalize_axis_text_list(axis.get("negative_semantics")),
                "positive_semantics": _normalize_axis_text_list(axis.get("positive_semantics")),
                "usage_notes": _truncate_text(str(axis.get("usage_notes") or "").strip(), 160),
                "available_levels": resolve_available_axis_levels(axis),
            }
            for axis in prompt_axes
            if str(axis.get("id") or "").strip()
        ],
        "axis_prompt": _build_middleware_axis_prompt(
            prompt_axes,
        ),
    }

def _build_middleware_axis_prompt(
    prompt_axes: list[dict[str, Any]],
) -> str:
    return "\n".join(
        format_profile_axis_prompt_line(
            axis,
            truncate_text=_truncate_text,
            use_axis_levels=True,
        )
        for axis in prompt_axes
    )

def _normalize_axis_range(value: Any, fallback: list[float] | None) -> list[float] | None:
    if (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], (int, float))
        and isinstance(value[1], (int, float))
    ):
        return [float(value[0]), float(value[1])]
    return fallback

def _resolve_prompt_purpose(view: Any) -> str:
    """Read the prompt purpose from the AstrBot view.

    Returns ``"context_collection"`` or ``"unknown"`` under the current
    AstrBot prompt-contributor contract.
    """
    purpose = _normalize_optional_string(getattr(view, "purpose", None))
    if purpose:
        return purpose
    metadata = getattr(view, "metadata", None)
    if isinstance(metadata, Mapping):
        purpose = _normalize_optional_string(metadata.get("purpose"))
    elif callable(getattr(metadata, "get", None)):
        purpose = _normalize_optional_string(metadata.get("purpose"))
    if purpose:
        return purpose
    return "unknown"

def _should_contribute_motion_prompt(view: Any) -> bool:
    """Inject motion capability while AstrBot collects persona-targeted context.

    This keeps router and other prompt lanes clean of ag99live motion metadata.
    """
    return _resolve_prompt_purpose(view) == "context_collection"
