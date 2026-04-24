from __future__ import annotations

from copy import deepcopy

from adapter.adapter import live2d_scan

from .test_support import build_seed_inputs, build_seed_model_info, build_seed_model_info_with_options


def test_parameter_action_library_is_parameter_granular() -> None:
    parameter_scan, motions = build_seed_inputs()
    library = live2d_scan._build_parameter_action_library(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
    )

    assert library["schema_version"] == live2d_scan.PARAMETER_ACTION_LIBRARY_SCHEMA_VERSION
    assert library["atoms"]
    assert library["summary"]["selected_atom_count"] == len(library["atoms"])
    assert library["summary"]["selected_parameter_count"] == len(
        [item for item in library["parameters"] if item["selected_atom_count"] > 0]
    )

    parameter_ids = {item["parameter_id"] for item in library["atoms"]}
    assert "ParamAngleX" in parameter_ids
    assert "ParamHeadXAlt" in parameter_ids
    assert "ParamMouthOpenY" in parameter_ids

    atoms_by_parameter: dict[str, list[dict]] = {}
    for atom in library["atoms"]:
        atoms_by_parameter.setdefault(atom["parameter_id"], []).append(atom)
        assert atom["window_end_ratio"] >= atom["window_start_ratio"]
        assert atom["window_duration_ratio"] >= 0
        assert atom["source_component_id"]
        assert atom["source_motion"]

    for parameter in library["parameters"]:
        atom_ids = parameter["atom_ids"]
        selected_count = parameter["selected_atom_count"]
        assert selected_count == len(atom_ids)
        if selected_count <= 0:
            continue
        parameter_id = parameter["parameter_id"]
        assert parameter_id in atoms_by_parameter
        assert sorted(item["id"] for item in atoms_by_parameter[parameter_id]) == sorted(atom_ids)


def test_empty_parameter_action_library_stays_structurally_valid() -> None:
    parameter_scan, _ = build_seed_inputs()
    library = live2d_scan._build_empty_parameter_action_library(
        parameter_scan=deepcopy(parameter_scan),
        error="demo failure",
    )

    assert library["analysis"]["status"] == "failed"
    assert library["analysis"]["mode"] == "parameter_track"
    assert library["summary"]["selected_atom_count"] == 0
    assert library["summary"]["candidate_atom_count"] == 0
    assert library["atoms"] == []
    assert library["parameters"] == []


def test_adaptive_parameter_profile_is_generated_from_seed_data() -> None:
    parameter_scan, motions = build_seed_inputs()
    parameter_action_library = live2d_scan._build_parameter_action_library(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
    )

    profile_a = live2d_scan._build_adaptive_parameter_profile(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
        parameter_action_library=deepcopy(parameter_action_library),
    )
    profile_b = live2d_scan._build_adaptive_parameter_profile(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
        parameter_action_library=deepcopy(parameter_action_library),
    )

    assert profile_a["schema_version"] == live2d_scan.ADAPTIVE_PARAMETER_PROFILE_SCHEMA_VERSION
    assert profile_a == profile_b
    assert profile_a["summary"]["profiled_parameter_count"] == 3
    assert profile_a["summary"]["observed_parameter_count"] == 3
    assert profile_a["summary"]["available_channel_count"] == 2
    assert profile_a["summary"]["recommended_axis_count"] == 0

    channels = {item["channel"]: item for item in profile_a["channels"]}
    head_yaw = channels["head_yaw"]
    mouth_open = channels["mouth_open"]

    assert head_yaw["baseline"] == 0.0
    assert head_yaw["common_range"] == {"min": -0.375, "max": 0.375}
    assert head_yaw["observed_min"] == -0.7
    assert head_yaw["observed_max"] == 0.7
    assert head_yaw["directionality"]["dominant"] == "mixed"
    assert head_yaw["recommended_execution_range"] == {
        "parameter_id": "ParamAngleX",
        "parameter_name": "ParamAngleX",
        "min": -0.375,
        "max": 0.375,
        "baseline": 0.0,
        "confidence": "medium",
        "source": "channel_aggregate",
        "recommended": False,
        "safe_to_apply": False,
        "skip_reason": "primary_parameter_insufficient_observations",
    }

    assert mouth_open["directionality"]["dominant"] == "positive"
    assert mouth_open["recommended_execution_range"] == {
        "parameter_id": "ParamMouthOpenY",
        "parameter_name": "ParamMouthOpenY",
        "min": -0.05,
        "max": 0.7,
        "baseline": 0.0,
        "confidence": "low",
        "source": "channel_aggregate",
        "recommended": False,
        "safe_to_apply": False,
        "skip_reason": "primary_parameter_insufficient_observations",
    }

    parameters = {item["parameter_id"]: item for item in profile_a["parameters"]}
    assert parameters["ParamAngleX"]["recommended_execution_range"]["source"] == "parameter"
    assert parameters["ParamAngleX"]["directionality"]["dominant"] == "positive"
    assert parameters["ParamHeadXAlt"]["directionality"]["dominant"] == "negative"
    assert parameters["ParamMouthOpenY"]["selected_atom_count"] == 1

    runtime_summary = profile_a["runtime_summary"]
    assert runtime_summary["axis_parameter_map"] == {}
    assert runtime_summary["axis_execution_ranges"]["head_yaw"]["recommended"] is False
    assert runtime_summary["axis_execution_ranges"]["mouth_open"]["safe_to_apply"] is False
    assert runtime_summary["channel_direction_preferences"] == {
        "head_yaw": "mixed",
        "mouth_open": "positive",
    }


def test_adaptive_parameter_profile_recommends_direct_axis_after_primary_reinforcement() -> None:
    parameter_scan, motions = build_seed_inputs(reinforce_primary_observations=True)
    parameter_action_library = live2d_scan._build_parameter_action_library(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
    )

    profile = live2d_scan._build_adaptive_parameter_profile(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
        parameter_action_library=deepcopy(parameter_action_library),
    )
    calibration_profile = live2d_scan._build_calibration_profile(
        adaptive_parameter_profile=deepcopy(profile),
    )

    head_yaw = {item["channel"]: item for item in profile["channels"]}["head_yaw"]
    assert profile["summary"]["recommended_axis_count"] == 1
    assert head_yaw["recommended_execution_range"] == {
        "parameter_id": "ParamAngleX",
        "parameter_name": "ParamAngleX",
        "min": -0.05,
        "max": 0.7,
        "baseline": 0.0,
        "confidence": "medium",
        "source": "primary_parameter",
        "recommended": True,
        "safe_to_apply": True,
    }
    assert profile["runtime_summary"]["axis_parameter_map"] == {
        "head_yaw": "ParamAngleX",
    }
    assert calibration_profile["axes"]["head_yaw"]["recommended"] is True
    assert calibration_profile["axes"]["head_yaw"]["recommended_range"] == {
        "min": -0.05,
        "max": 0.7,
    }


def test_seed_model_info_summary_embeds_adaptive_parameter_profile() -> None:
    model_info = build_seed_model_info()
    model = model_info["models"][0]

    assert model["adaptive_parameter_profile"]["schema_version"] == (
        live2d_scan.ADAPTIVE_PARAMETER_PROFILE_SCHEMA_VERSION
    )
    assert model["calibration_profile"]["schema_version"] == (
        live2d_scan.CALIBRATION_PROFILE_SCHEMA_VERSION
    )
    assert model["calibration_profile"]["axes"]["head_yaw"]["parameter_id"] == "ParamAngleX"
    assert model["calibration_profile"]["axes"]["head_yaw"]["parameter_ids"] == [
        "ParamAngleX",
        "ParamHeadXAlt",
    ]
    assert model["calibration_profile"]["axes"]["head_yaw"]["recommended"] is False
    assert "recommended_range" not in model["calibration_profile"]["axes"]["head_yaw"]
    assert model["summary"]["schema_version"] == live2d_scan.MODEL_SUMMARY_SCHEMA_VERSION
    assert model["summary"]["adaptive_parameter_profile"]["schema_version"] == (
        live2d_scan.ADAPTIVE_PARAMETER_PROFILE_SCHEMA_VERSION
    )
    assert model["summary"]["calibration_profile"] == {
        "schema_version": live2d_scan.CALIBRATION_PROFILE_SCHEMA_VERSION,
        "axis_count": 2,
    }
    assert model["summary"]["adaptive_parameter_profile"]["summary"] == (
        model["adaptive_parameter_profile"]["summary"]
    )
    assert model["summary"]["adaptive_parameter_profile"]["runtime_summary"] == (
        model["adaptive_parameter_profile"]["runtime_summary"]
    )


def test_seed_model_info_with_reinforced_primary_observations_exports_safe_calibration() -> None:
    model_info = build_seed_model_info_with_options(reinforce_primary_observations=True)
    model = model_info["models"][0]

    assert model["calibration_profile"]["axes"]["head_yaw"]["recommended"] is True
    assert model["calibration_profile"]["axes"]["head_yaw"]["safe_to_apply"] is True
    assert model["calibration_profile"]["axes"]["head_yaw"]["recommended_range"] == {
        "min": -0.05,
        "max": 0.7,
    }
    assert model["adaptive_parameter_profile"]["runtime_summary"]["axis_parameter_map"] == {
        "head_yaw": "ParamAngleX",
    }


def test_adaptive_parameter_profile_returns_legal_empty_structure_with_low_data() -> None:
    parameter_scan, _ = build_seed_inputs()
    empty_library = live2d_scan._build_empty_parameter_action_library(
        parameter_scan=deepcopy(parameter_scan),
        error="seed-empty",
    )
    profile = live2d_scan._build_adaptive_parameter_profile(
        parameter_scan=deepcopy(parameter_scan),
        motions=[],
        parameter_action_library=deepcopy(empty_library),
    )

    assert profile["schema_version"] == live2d_scan.ADAPTIVE_PARAMETER_PROFILE_SCHEMA_VERSION
    assert profile["summary"]["profiled_parameter_count"] == 3
    assert profile["summary"]["observed_parameter_count"] == 0
    assert profile["summary"]["available_channel_count"] == 2
    assert profile["summary"]["recommended_axis_count"] == 0

    channels = {item["channel"]: item for item in profile["channels"]}
    assert channels["head_yaw"]["recommended_execution_range"]["confidence"] == "none"
    assert channels["head_yaw"]["recommended_execution_range"]["recommended"] is False
    assert channels["mouth_open"]["recommended_execution_range"]["confidence"] == "none"
    assert channels["mouth_open"]["recommended_execution_range"]["safe_to_apply"] is False
    assert profile["runtime_summary"]["axis_execution_ranges"]["head_yaw"]["confidence"] == "none"
    assert profile["runtime_summary"]["axis_execution_ranges"]["mouth_open"]["confidence"] == "none"
