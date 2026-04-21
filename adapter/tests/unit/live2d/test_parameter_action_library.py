from __future__ import annotations

from copy import deepcopy

from adapter import live2d_scan

from .test_support import build_seed_inputs


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
