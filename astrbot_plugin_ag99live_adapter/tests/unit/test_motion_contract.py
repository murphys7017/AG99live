from __future__ import annotations

from typing import Any

from astrbot_plugin_ag99live_adapter.middleware.interaction_motion.prompt_builder import (
    _build_motion_capability_prompt_payload,
)
from astrbot_plugin_ag99live_adapter.middleware.interaction_motion.prompt_references import (
    _project_reference_examples_for_prompt,
)
from astrbot_plugin_ag99live_adapter.motion.payload_validation import (
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
        "axis_levels": {"head_yaw": 2},
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


def test_reference_projection_uses_user_text_and_nearest_available_levels() -> None:
    projected = _project_reference_examples_for_prompt(
        [
            {
                "user_text": "请向右看一点",
                "output": {
                    "intent_tags": ["侧看"],
                    "axis_levels": {
                        "head_yaw": 3,
                        "body_yaw": -4,
                        "unknown_axis": 2,
                    },
                },
            }
        ],
        allowed_axis_ids={"head_yaw", "body_yaw"},
        available_levels_by_axis={
            "head_yaw": {-2, 0, 2},
            "body_yaw": {-1, 0, 1},
        },
    )

    assert projected == [
        {
            "input": "请向右看一点",
            "output": {
                "intent_tags": ["侧看"],
                "axis_levels": {"head_yaw": 2, "body_yaw": -1},
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
                    "axis_levels": {"head_yaw": 2, "body_yaw": 2},
                    "expression_resource_id": "expr_body",
                },
            }
        ],
        allowed_axis_ids={"head_yaw", "body_yaw"},
        available_levels_by_axis={
            "head_yaw": {-2, 0, 2},
            "body_yaw": {-2, 0, 2},
        },
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
                "axis_levels": {"head_yaw": 2},
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
