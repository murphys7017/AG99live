from __future__ import annotations

from typing import Any

import pytest

from astrbot_plugin_ag99live_adapter.middleware.interaction_motion.prompt_builder import (
    _build_motion_capability_prompt_payload,
)
from astrbot_plugin_ag99live_adapter.middleware.interaction_motion.prompt_references import (
    _project_reference_examples_for_prompt,
)
from astrbot_plugin_ag99live_adapter.motion.motion_intent import (
    normalize_motion_intent_v4_payload,
)
from astrbot_plugin_ag99live_adapter.motion.payload_validation import (
    normalize_motion_arguments_payload,
    validate_normalized_motion_intent_payload,
)
from astrbot_plugin_ag99live_adapter.motion.resource_catalog import (
    build_motion_resource_candidates,
)
from astrbot_plugin_ag99live_adapter.live2d.semantic_axis_profile import (
    build_default_semantic_axis_profile,
)
from astrbot_plugin_ag99live_adapter.protocol.schema_versions import (
    MOTION_INTENT_V4_SCHEMA_VERSION,
)


class _RuntimeState:
    def __init__(self, model: dict[str, Any]) -> None:
        self.model_info = {
            "selected_model": str(model.get("name") or ""),
            "models": [model],
        }


def _build_model() -> dict[str, Any]:
    model_name = "test-model"
    profile = build_default_semantic_axis_profile(
        model_name=model_name,
        model_payload={
            "parameter_scan": {
                "standard_channels": {
                    "gaze_x": {"primary_parameter_id": "PGaze"},
                    "head_yaw": {"primary_parameter_id": "PHead"},
                    "body_yaw": {"primary_parameter_id": "PBody"},
                },
                "parameters": [
                    {"id": "PGaze", "name": "Gaze"},
                    {"id": "PHead", "name": "Head"},
                    {"id": "PBody", "name": "Body"},
                ],
            }
        },
        source_hash="test-hash",
    )
    return {
        "name": model_name,
        "semantic_axis_profile": profile,
        "constraints": {
            "expressions": [
                {
                    "id": "expr_body",
                    "parameter_ids": ["PBody"],
                    "expose_as_resource": True,
                },
                {
                    "id": "expr_unbound",
                    "parameter_ids": ["PUnknown"],
                    "expose_as_resource": True,
                },
            ],
            "motions": [],
        },
    }


def test_resource_conflicts_include_prompt_sources_from_relation_graph() -> None:
    candidates = build_motion_resource_candidates(
        runtime_state=_RuntimeState(_build_model()),
    )

    body_expression = next(
        item for item in candidates if item["resource_id"] == "expr_body"
    )

    assert body_expression["conflicting_axis_ids"] == ["body_yaw"]
    assert body_expression["conflicting_prompt_axis_ids"] == [
        "body_yaw",
        "gaze_x",
        "head_yaw",
    ]


def test_expression_resource_rejects_conflicting_prompt_source_axis() -> None:
    model = _build_model()
    runtime_state = _RuntimeState(model)
    profile = model["semantic_axis_profile"]
    payload = {
        "schema_version": MOTION_INTENT_V4_SCHEMA_VERSION,
        "profile_id": profile["profile_id"],
        "profile_revision": profile["revision"],
        "model_id": profile["model_id"],
        "mode": "expressive",
        "intent_tags": ["强调"],
        "motion_steps": [{"axis_values": {"head_yaw": 76.0}, "duration_weight": 1}],
        "expression_resource_id": "expr_body",
    }

    normalized, reason = validate_normalized_motion_intent_payload(
        payload,
        runtime_state,
        base_reason="ok",
    )

    assert normalized is None
    assert reason == (
        "expression_id_validated:"
        "expression_resource_axis_conflict:expr_body:head_yaw"
    )


def test_missing_intent_tags_are_defaulted_without_rejecting_motion() -> None:
    model = _build_model()
    runtime_state = _RuntimeState(model)

    normalized, reason = normalize_motion_arguments_payload(
        {
            "motion_steps": [
                {"axis_values": {"head_yaw": 76.0}, "duration_weight": 1}
            ],
            "duration_hint_ms": 900,
        },
        runtime_state,
        base_reason="independent_provider",
        append_resolution_reason=lambda base, suffix: (
            f"{base}:{suffix}" if base and suffix else base or suffix
        ),
        sanitize_reason_fragment=lambda value: str(value),
    )

    assert normalized is not None
    assert normalized["intent_tags"] == ["动作"]
    assert normalized["motion_steps"] == [
        {"axis_values": {"head_yaw": 76.0}, "duration_weight": 1}
    ]
    assert "intent_tags_defaulted" in reason


def test_reference_projection_uses_user_text_and_clamps_axis_values() -> None:
    projected = _project_reference_examples_for_prompt(
        [
            {
                "user_text": "请向右看一点",
                "output": {
                    "intent_tags": ["侧看"],
                    "motion_steps": [{
                        "axis_values": {
                            "head_yaw": 86.0,
                            "body_yaw": 0.0,
                            "unknown_axis": 2.0,
                        },
                        "duration_weight": 1,
                    }],
                },
            }
        ],
        allowed_axis_ids={"head_yaw", "body_yaw"},
        value_ranges_by_axis={"head_yaw": (0.0, 100.0), "body_yaw": (0.0, 100.0)},
    )

    assert projected == [
        {
            "input": "请向右看一点",
            "output": {
                "intent_tags": ["侧看"],
                "motion_steps": [{
                    "axis_values": {"head_yaw": 86.0, "body_yaw": 0.0},
                    "duration_weight": 1,
                }],
            },
        }
    ]


def test_reference_projection_removes_expression_conflicting_axes() -> None:
    projected = _project_reference_examples_for_prompt(
        [
            {
                "input": "生气地转身",
                "output": {
                    "intent_tags": ["生气"],
                    "motion_steps": [{
                        "axis_values": {"head_yaw": 76.0, "body_yaw": 75.0},
                        "duration_weight": 1,
                    }],
                    "expression_resource_id": "expr_body",
                },
            }
        ],
        allowed_axis_ids={"head_yaw", "body_yaw"},
        resource_candidates=[
            {
                "resource_id": "expr_body",
                "resource_type": "expression",
                "conflicting_axis_ids": ["body_yaw"],
            }
        ],
    )

    assert projected == [
        {
            "input": "生气地转身",
            "output": {
                "intent_tags": ["生气"],
                "expression_resource_id": "expr_body",
                "motion_steps": [{
                    "axis_values": {"head_yaw": 76.0},
                    "duration_weight": 1,
                }],
            },
        }
    ]


def test_capability_prompt_hides_non_prompt_conflict_axes() -> None:
    payload = _build_motion_capability_prompt_payload(
        {
            "semantic_profile": {
                "prompt_axes": [
                    {
                        "id": "head_yaw",
                        "label": "Head Yaw",
                        "description": "",
                        "control_role": "primary",
                        "negative_semantics": [],
                        "positive_semantics": [],
                        "usage_notes": "",
                        "available_levels": [-2, 0, 2],
                    }
                ]
            },
            "resource_candidates": [
                {
                    "resource_id": "expr_body",
                    "resource_type": "expression",
                    "conflicting_axis_ids": ["mouth_open", "head_yaw"],
                    "conflicting_prompt_axis_ids": ["head_yaw"],
                }
            ],
        }
    )

    resource = payload["resources"][0]
    assert resource["conflicting_axis_ids"] == ["head_yaw"]
    assert resource["conflicting_prompt_axis_ids"] == ["head_yaw"]


def _identity_payload(model: dict[str, Any], **motion: Any) -> dict[str, Any]:
    profile = model["semantic_axis_profile"]
    return {
        "schema_version": MOTION_INTENT_V4_SCHEMA_VERSION,
        "profile_id": profile["profile_id"],
        "profile_revision": profile["revision"],
        "model_id": profile["model_id"],
        "mode": "expressive",
        "intent_tags": ["连续"],
        **motion,
    }


def test_axis_values_accept_continuous_numbers() -> None:
    model = _build_model()
    runtime_state = _RuntimeState(model)

    normalized, reason = normalize_motion_arguments_payload(
        {
            "motion_steps": [{
                "axis_values": {"head_yaw": 18.4, "body_yaw": 6.25, "gaze_x": 0.31},
                "duration_weight": 1,
            }]
        },
        runtime_state,
        base_reason="independent_provider",
        append_resolution_reason=lambda base, suffix: (
            f"{base}:{suffix}" if base and suffix else base or suffix
        ),
        sanitize_reason_fragment=lambda value: str(value),
    )

    assert normalized is not None, reason
    assert normalized["motion_steps"] == [{
        "axis_values": {"head_yaw": 18.4, "body_yaw": 6.25, "gaze_x": 0.31},
        "duration_weight": 1,
    }]
    assert "axis_levels" not in normalized


def test_axis_values_reject_non_finite_and_non_number_values() -> None:
    model = _build_model()
    runtime_state = _RuntimeState(model)

    for bad in (True, "12", float("nan"), float("inf"), None):
        normalized, reason = normalize_motion_arguments_payload(
            {"motion_steps": [{"axis_values": {"head_yaw": bad}, "duration_weight": 1}]},
            runtime_state,
            base_reason="independent_provider",
            append_resolution_reason=lambda base, suffix: (
                f"{base}:{suffix}" if base and suffix else base or suffix
            ),
            sanitize_reason_fragment=lambda value: str(value),
        )
        assert normalized is None, f"{bad!r} should be rejected"
        assert "axis_values" in reason


def test_axis_values_outside_value_range_are_rejected() -> None:
    model = _build_model()
    runtime_state = _RuntimeState(model)
    profile = model["semantic_axis_profile"]
    head_yaw = next(axis for axis in profile["axes"] if axis["id"] == "head_yaw")
    low, high = head_yaw["value_range"]

    normalized, reason = normalize_motion_arguments_payload(
        {"motion_steps": [{"axis_values": {"head_yaw": float(high) + 1.0}, "duration_weight": 1}]},
        runtime_state,
        base_reason="independent_provider",
        append_resolution_reason=lambda base, suffix: (
            f"{base}:{suffix}" if base and suffix else base or suffix
        ),
        sanitize_reason_fragment=lambda value: str(value),
    )
    assert normalized is None
    assert "out_of_range_axis_values" in reason

    normalized_ok, reason_ok = normalize_motion_arguments_payload(
        {"motion_steps": [{"axis_values": {"head_yaw": (float(low) + float(high)) / 2.0}, "duration_weight": 1}]},
        runtime_state,
        base_reason="independent_provider",
        append_resolution_reason=lambda base, suffix: (
            f"{base}:{suffix}" if base and suffix else base or suffix
        ),
        sanitize_reason_fragment=lambda value: str(value),
    )
    assert normalized_ok is not None, reason_ok


def test_root_axis_values_and_axis_levels_are_rejected() -> None:
    model = _build_model()
    payload = _identity_payload(
        model,
        axis_levels={"head_yaw": 2},
    )

    with pytest.raises(ValueError) as excinfo:
        normalize_motion_intent_v4_payload(payload)

    assert "axis_levels_removed" in str(excinfo.value)


def test_capability_prompt_declares_axis_values_format() -> None:
    payload = _build_motion_capability_prompt_payload(
        {
            "semantic_profile": {
                "prompt_axes": [
                    {
                        "id": "head_yaw",
                        "label": "Head Yaw",
                        "description": "",
                        "control_role": "primary",
                        "value_range": [-30.0, 30.0],
                        "neutral": 0.0,
                        "negative_semantics": [],
                        "positive_semantics": [],
                        "usage_notes": "",
                        "available_levels": [-2, 0, 2],
                    }
                ]
            }
        }
    )

    assert payload["axis_value_format"] == "axis_values"
    axis = payload["axes"][0]
    assert axis["value_range"] == [-30.0, 30.0]
    assert axis["neutral"] == 0.0


def test_reference_projection_keeps_axis_values_within_axis_range() -> None:
    projected = _project_reference_examples_for_prompt(
        [
            {
                "user_text": "轻轻向右看",
                "output": {
                    "intent_tags": ["侧看"],
                    "axis_values": {"head_yaw": 52.5, "unknown_axis": 1.0},
                },
            }
        ],
        allowed_axis_ids={"head_yaw"},
        value_ranges_by_axis={"head_yaw": (-30.0, 30.0)},
    )

    assert projected == [
        {
            "input": "轻轻向右看",
            "output": {
                "intent_tags": ["侧看"],
                "motion_steps": [{
                    "axis_values": {"head_yaw": 30.0},
                    "duration_weight": 1,
                }],
            },
        }
    ]
