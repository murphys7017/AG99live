from __future__ import annotations

from copy import deepcopy
from typing import Any

from adapter import live2d_scan


def _make_component(
    *,
    component_id: str,
    channel: str,
    domain: str,
    parameter_id: str,
    energy_score: float,
    strength: str,
    trait: str,
    polarity: str,
    engine_role: str = "driver",
) -> dict[str, Any]:
    if polarity == "positive":
        value_profile = {"baseline": 0.0, "min": -0.05, "max": 0.7}
    elif polarity == "negative":
        value_profile = {"baseline": 0.0, "min": -0.7, "max": 0.05}
    else:
        value_profile = {"baseline": 0.0, "min": -0.15, "max": 0.15}

    return {
        "id": component_id,
        "source_motion": f"motion_for_{component_id}",
        "source_file": f"Motions/{component_id}.motion3.json",
        "source_group": "default",
        "source_category": "expressive",
        "parameter_id": parameter_id,
        "parameter_name": parameter_id,
        "group_name": "Face",
        "domain": domain,
        "engine_role": engine_role,
        "channels": [channel],
        "duration": 3.0,
        "fps": 30.0,
        "loop": False,
        "strength": strength,
        "trait": trait,
        "energy_score": energy_score,
        "peak_abs_value": round(max(abs(value_profile["min"]), abs(value_profile["max"])), 4),
        "peak_time_ratio": 0.45,
        "active_ratio": 0.5,
        "windows": [{"start_ratio": 0.2, "end_ratio": 0.8}],
        "value_profile": value_profile,
        "sample_signature": {"sample_count": 4, "sample_ratios": [0.0, 0.33, 0.66, 1.0]},
    }


def build_seed_inputs(*, reinforce_primary_observations: bool = False) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    standard_channels: dict[str, dict[str, Any]] = {}
    for spec in live2d_scan.CORE_BASE_ACTION_CHANNEL_SPECS:
        standard_channels[spec["name"]] = {
            "label": spec["label"],
            "available": False,
            "primary_parameter_id": "",
            "primary_parameter_name": "",
            "group_name": "",
            "candidate_parameter_ids": [],
        }

    standard_channels["head_yaw"] = {
        "label": "Head Yaw",
        "available": True,
        "primary_parameter_id": "ParamAngleX",
        "primary_parameter_name": "ParamAngleX",
        "group_name": "Head",
        "candidate_parameter_ids": ["ParamAngleX", "ParamHeadXAlt"],
    }
    standard_channels["mouth_open"] = {
        "label": "Mouth Open",
        "available": True,
        "primary_parameter_id": "ParamMouthOpenY",
        "primary_parameter_name": "ParamMouthOpenY",
        "group_name": "Mouth",
        "candidate_parameter_ids": ["ParamMouthOpenY"],
    }

    parameter_scan = {
        "schema_version": "parameter_scan.seed.v1",
        "source": "seed",
        "total_parameters": 3,
        "drivable_parameters": 3,
        "physics_parameters": 0,
        "expression_parameters": 0,
        "groups": [
            {
                "name": "Head",
                "count": 2,
                "dominant_domain": "head",
                "domain_counts": [{"name": "head", "count": 2}],
            },
            {
                "name": "Mouth",
                "count": 1,
                "dominant_domain": "mouth",
                "domain_counts": [{"name": "mouth", "count": 1}],
            },
        ],
        "domain_counts": [
            {"name": "head", "count": 2},
            {"name": "mouth", "count": 1},
        ],
        "standard_channels": standard_channels,
        "primary_parameters": [
            {
                "channel": "head_yaw",
                "parameter_id": "ParamAngleX",
                "parameter_name": "ParamAngleX",
                "group_name": "Head",
            },
            {
                "channel": "mouth_open",
                "parameter_id": "ParamMouthOpenY",
                "parameter_name": "ParamMouthOpenY",
                "group_name": "Mouth",
            },
        ],
        "parameters": [
            {
                "id": "ParamAngleX",
                "name": "ParamAngleX",
                "group_id": "Head",
                "group_name": "Head",
                "kind": "core",
                "domain": "head",
                "channels": ["head_yaw"],
            },
            {
                "id": "ParamHeadXAlt",
                "name": "ParamHeadXAlt",
                "group_id": "Head",
                "group_name": "Head",
                "kind": "core",
                "domain": "head",
                "channels": ["head_yaw"],
            },
            {
                "id": "ParamMouthOpenY",
                "name": "ParamMouthOpenY",
                "group_id": "Mouth",
                "group_name": "Mouth",
                "kind": "core",
                "domain": "mouth",
                "channels": ["mouth_open"],
            },
        ],
    }
    motions = [
        {
            "name": "head_driver",
            "file": "Motions/head_driver.motion3.json",
            "group": "default",
            "category": "expressive",
            "catalog_tags": ["demo", "head"],
            "timeline_profile": {
                "intro_energy": 1.0,
                "middle_energy": 0.5,
                "outro_energy": 0.3,
                "peak_window": {"start_ratio": 0.2, "end_ratio": 0.6},
                "motion_trait": "centered",
            },
            "components": [
                _make_component(
                    component_id="head_pos",
                    channel="head_yaw",
                    domain="head",
                    parameter_id="ParamAngleX",
                    energy_score=0.95,
                    strength="high",
                    trait="oscillate",
                    polarity="positive",
                ),
                _make_component(
                    component_id="head_neg",
                    channel="head_yaw",
                    domain="head",
                    parameter_id="ParamHeadXAlt",
                    energy_score=0.8,
                    strength="medium",
                    trait="sustain",
                    polarity="negative",
                ),
                _make_component(
                    component_id="head_filtered_none",
                    channel="head_yaw",
                    domain="head",
                    parameter_id="ParamAngleX",
                    energy_score=0.9,
                    strength="none",
                    trait="pulse",
                    polarity="positive",
                ),
                _make_component(
                    component_id="head_filtered_overlay",
                    channel="head_yaw",
                    domain="head",
                    parameter_id="ParamAngleX",
                    energy_score=0.9,
                    strength="high",
                    trait="pulse",
                    polarity="positive",
                    engine_role="overlay",
                ),
                _make_component(
                    component_id="head_filtered_domain",
                    channel="head_yaw",
                    domain="body",
                    parameter_id="ParamAngleX",
                    energy_score=0.9,
                    strength="high",
                    trait="pulse",
                    polarity="positive",
                ),
            ],
        },
        {
            "name": "mouth_driver",
            "file": "Motions/mouth_driver.motion3.json",
            "group": "default",
            "category": "expressive",
            "catalog_tags": ["demo", "mouth"],
            "timeline_profile": {
                "intro_energy": 0.8,
                "middle_energy": 0.4,
                "outro_energy": 0.2,
                "peak_window": {"start_ratio": 0.1, "end_ratio": 0.4},
                "motion_trait": "front_loaded",
            },
            "components": [
                _make_component(
                    component_id="mouth_open_pos",
                    channel="mouth_open",
                    domain="mouth",
                    parameter_id="ParamMouthOpenY",
                    energy_score=0.7,
                    strength="high",
                    trait="pulse",
                    polarity="positive",
                )
            ],
        },
    ]
    if reinforce_primary_observations:
        motions.append(
            {
                "name": "head_driver_repeat",
                "file": "Motions/head_driver_repeat.motion3.json",
                "group": "default",
                "category": "expressive",
                "catalog_tags": ["demo", "head", "repeat"],
                "timeline_profile": {
                    "intro_energy": 0.7,
                    "middle_energy": 0.6,
                    "outro_energy": 0.2,
                    "peak_window": {"start_ratio": 0.25, "end_ratio": 0.7},
                    "motion_trait": "follow_through",
                },
                "components": [
                    _make_component(
                        component_id="head_pos_repeat",
                        channel="head_yaw",
                        domain="head",
                        parameter_id="ParamAngleX",
                        energy_score=0.82,
                        strength="medium",
                        trait="ramp",
                        polarity="positive",
                    )
                ],
            }
        )
    return parameter_scan, motions


def build_seed_library() -> dict[str, Any]:
    parameter_scan, motions = build_seed_inputs()
    return live2d_scan._build_base_action_library(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
    )


def build_seed_parameter_action_library() -> dict[str, Any]:
    parameter_scan, motions = build_seed_inputs()
    return live2d_scan._build_parameter_action_library(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
    )


def build_seed_adaptive_parameter_profile() -> dict[str, Any]:
    parameter_scan, motions = build_seed_inputs()
    return live2d_scan._build_adaptive_parameter_profile(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
        parameter_action_library=build_seed_parameter_action_library(),
    )


def build_seed_calibration_profile() -> dict[str, Any]:
    return live2d_scan._build_calibration_profile(
        adaptive_parameter_profile=build_seed_adaptive_parameter_profile(),
    )


def build_seed_model_info() -> dict[str, Any]:
    return build_seed_model_info_with_options()


def build_seed_model_info_with_options(
    *,
    reinforce_primary_observations: bool = False,
) -> dict[str, Any]:
    parameter_scan, motions = build_seed_inputs(
        reinforce_primary_observations=reinforce_primary_observations,
    )
    base_action_library = live2d_scan._build_base_action_library(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
    )
    parameter_action_library = live2d_scan._build_parameter_action_library(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
    )
    adaptive_parameter_profile = live2d_scan._build_adaptive_parameter_profile(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
        parameter_action_library=deepcopy(parameter_action_library),
    )
    calibration_profile = live2d_scan._build_calibration_profile(
        adaptive_parameter_profile=deepcopy(adaptive_parameter_profile),
    )
    engine_hints = live2d_scan._build_engine_hints(
        parameter_scan=deepcopy(parameter_scan),
        expressions=[],
        motions=deepcopy(motions),
    )
    return {
        "schema_version": "live2d_scan.v1",
        "driver_priority": ["parameters", "expression", "motion"],
        "selected_model": "DemoModel",
        "available_models": ["DemoModel"],
        "models": [
            {
                "name": "DemoModel",
                "parameter_scan": deepcopy(parameter_scan),
                "base_action_library": base_action_library,
                "parameter_action_library": parameter_action_library,
                "adaptive_parameter_profile": adaptive_parameter_profile,
                "calibration_profile": calibration_profile,
                "summary": live2d_scan._build_model_summary(
                    resource_scan={
                        "texture_count": 0,
                        "expression_count": 0,
                        "motion_count": len(motions),
                        "vtube_profile_count": 0,
                    },
                    parameter_scan=deepcopy(parameter_scan),
                    expressions=[],
                    motions=deepcopy(motions),
                    base_action_library=deepcopy(base_action_library),
                    parameter_action_library=deepcopy(parameter_action_library),
                    adaptive_parameter_profile=deepcopy(adaptive_parameter_profile),
                    calibration_profile=deepcopy(calibration_profile),
                    engine_hints=engine_hints,
                ),
            }
        ],
    }
