from __future__ import annotations

from copy import deepcopy

from adapter.base_action_llm_filter import (
    apply_action_filter_selection,
    build_action_filter_signature,
    parse_action_filter_decision,
)

from .test_support import build_seed_library


def test_action_filter_signature_is_stable() -> None:
    library = build_seed_library()
    signature_a = build_action_filter_signature(deepcopy(library))
    signature_b = build_action_filter_signature(deepcopy(library))
    assert signature_a == signature_b


def test_parse_and_apply_action_filter_selection() -> None:
    library = build_seed_library()
    channels_by_name = {item["name"]: item for item in library["channels"]}
    selected_for_head = channels_by_name["head_yaw"]["atom_ids"][0]
    selected_for_mouth = channels_by_name["mouth_open"]["atom_ids"][0]
    raw_output = (
        "{"
        '"selected_atom_ids_by_channel": {'
        '"head_yaw": ["%s"], '
        '"mouth_open": ["%s"]'
        "},"
        '"reason":"strict basic coverage"'
        "}"
    ) % (selected_for_head, selected_for_mouth)

    selected = parse_action_filter_decision(
        raw_output,
        base_action_library=deepcopy(library),
        max_atoms_per_channel=2,
    )
    apply_action_filter_selection(
        library,
        selected_atom_ids_by_channel=selected,
        analysis={
            "status": "filtered",
            "mode": "llm_strict",
            "provider_id": "mock-provider",
            "input_signature": "demo-signature",
            "latency_ms": 123,
            "cache_hit": False,
            "selected_channel_count": 2,
            "error": "",
            "fallback_reason": "",
        },
    )

    assert library["summary"]["selected_atom_count"] == 2
    assert library["summary"]["selected_channel_count"] == 2
    assert [atom["id"] for atom in library["atoms"]] == [
        selected_for_head,
        selected_for_mouth,
    ]
    assert library["analysis"]["status"] == "filtered"


def test_parse_action_filter_ignores_unknown_atom_ids() -> None:
    library = build_seed_library()
    raw_output = """{
      "selected_atom_ids_by_channel": {
        "head_yaw": ["unknown.atom.id"]
      }
    }"""
    selected = parse_action_filter_decision(
        raw_output,
        base_action_library=deepcopy(library),
        max_atoms_per_channel=2,
    )
    assert selected["head_yaw"] == []
