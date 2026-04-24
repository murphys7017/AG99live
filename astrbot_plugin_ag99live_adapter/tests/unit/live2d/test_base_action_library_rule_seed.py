from __future__ import annotations

from copy import deepcopy

from astrbot_plugin_ag99live_adapter.live2d.scanner import scan as live2d_scan

from .test_support import build_seed_inputs


def test_base_action_library_family_closure() -> None:
    parameter_scan, motions = build_seed_inputs()
    library = live2d_scan._build_base_action_library(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
    )

    atom_ids = {item["id"] for item in library["atoms"]}
    channel_atom_ids = {
        atom_id
        for channel in library["channels"]
        for atom_id in channel.get("atom_ids", [])
    }
    family_atom_ids = {
        atom_id
        for family in library["families"]
        for atom_id in family.get("atom_ids", [])
    }

    assert atom_ids
    assert atom_ids == channel_atom_ids
    assert atom_ids == family_atom_ids

    atoms_by_id = {item["id"]: item for item in library["atoms"]}
    family_names = {item["name"] for item in library["families"]}
    channels_by_name = {item["name"]: item for item in library["channels"]}
    for channel in library["channels"]:
        assert channel["family"] in family_names

    for family in library["families"]:
        expected_channels = {
            atoms_by_id[atom_id]["channel"] for atom_id in family["atom_ids"]
        }
        assert expected_channels.issubset(set(family["channels"]))

        union_atom_ids = []
        for channel_name in family["channels"]:
            union_atom_ids.extend(channels_by_name[channel_name]["atom_ids"])
        assert sorted(set(union_atom_ids)) == sorted(family["atom_ids"])
        assert family["atom_count"] == len(family["atom_ids"])

    assert library["summary"]["family_count"] == len(library["families"])
    assert library["summary"]["selected_atom_count"] == len(library["atoms"])
    assert library["summary"]["selected_channel_count"] == len(
        [item for item in library["channels"] if item["selected_atom_count"] > 0]
    )


def test_atom_selection_and_summary_fields_are_stable() -> None:
    parameter_scan, motions = build_seed_inputs()
    library_a = live2d_scan._build_base_action_library(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
    )
    library_b = live2d_scan._build_base_action_library(
        parameter_scan=deepcopy(parameter_scan),
        motions=deepcopy(motions),
    )

    assert library_a["summary"] == library_b["summary"]
    assert [item["id"] for item in library_a["atoms"]] == [
        item["id"] for item in library_b["atoms"]
    ]

    channels = {item["name"]: item for item in library_a["channels"]}
    assert channels["head_yaw"]["candidate_component_count"] == 2
    assert channels["mouth_open"]["candidate_component_count"] == 1
    assert channels["head_yaw"]["selected_atom_count"] == len(channels["head_yaw"]["atom_ids"])
    assert channels["mouth_open"]["selected_atom_count"] == len(channels["mouth_open"]["atom_ids"])

    summary = library_a["summary"]
    assert summary["available_channel_count"] == 2
    assert summary["candidate_component_count"] == 3
    assert summary["selected_atom_count"] == len(library_a["atoms"])
    assert len(library_a["atoms"]) == len({item["id"] for item in library_a["atoms"]})


def test_empty_base_action_library_stays_structurally_valid() -> None:
    parameter_scan, _ = build_seed_inputs()
    library = live2d_scan._build_empty_base_action_library(
        parameter_scan=deepcopy(parameter_scan),
        error="demo failure",
    )

    assert library["analysis"]["status"] == "failed"
    assert library["analysis"]["mode"] == "rule_seed"
    assert library["atoms"] == []
    assert library["summary"]["selected_atom_count"] == 0
    assert library["summary"]["candidate_component_count"] == 0
    assert library["summary"]["selected_channel_count"] == 0

    family_names = {item["name"] for item in library["families"]}
    for channel in library["channels"]:
        assert channel["family"] in family_names

