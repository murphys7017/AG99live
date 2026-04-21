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


def build_seed_inputs() -> tuple[dict[str, Any], list[dict[str, Any]]]:
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

    parameter_scan = {"standard_channels": standard_channels}
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
    return parameter_scan, motions


def build_seed_library() -> dict[str, Any]:
    parameter_scan, motions = build_seed_inputs()
    return live2d_scan._build_base_action_library(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
    )


def build_seed_model_info() -> dict[str, Any]:
    return {
        "schema_version": "live2d_scan.v1",
        "driver_priority": ["parameters", "expression", "motion"],
        "selected_model": "DemoModel",
        "available_models": ["DemoModel"],
        "models": [
            {
                "name": "DemoModel",
                "base_action_library": build_seed_library(),
            }
        ],
    }
