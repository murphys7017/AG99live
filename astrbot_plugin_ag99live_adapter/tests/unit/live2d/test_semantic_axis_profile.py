from __future__ import annotations

from copy import deepcopy
import json
import importlib

import pytest

from astrbot_plugin_ag99live_adapter.live2d.semantic_axis_profile import (
    SemanticAxisProfileError,
    SemanticAxisProfileRevisionError,
    build_semantic_axis_profile_path,
    ensure_semantic_axis_profile,
    save_semantic_axis_profile,
    validate_semantic_axis_profile,
)

from .test_support import build_seed_model_info


def _build_model_payload() -> dict:
    return build_seed_model_info()["models"][0]


def _build_valid_profile(tmp_path) -> dict:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")
    return ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=_build_model_payload(),
    )


def _expect_profile_error(profile: dict, expected_message: str) -> None:
    with pytest.raises(SemanticAxisProfileError, match=expected_message):
        validate_semantic_axis_profile(profile, model_name="DemoModel")


def test_live2d_runtime_cache_hash_ignores_generated_ag99_profile(
    tmp_path,
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    runtime_cache = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.live2d.cache.runtime_cache"
    )
    live2ds_dir = tmp_path / "live2ds"
    model_dir = live2ds_dir / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")

    before_hash = runtime_cache.build_live2d_directory_md5(live2ds_dir)
    profile_dir = model_dir / "ag99"
    profile_dir.mkdir(parents=True, exist_ok=True)
    (profile_dir / "semantic_axis_profile.json").write_text("{}", encoding="utf-8")

    assert runtime_cache.build_live2d_directory_md5(live2ds_dir) == before_hash


def test_ensure_semantic_axis_profile_creates_backend_owned_profile_file(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")

    profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=_build_model_payload(),
    )

    path = build_semantic_axis_profile_path(model_dir)
    assert path.exists()
    assert profile["schema_version"] == "ag99.semantic_axis_profile.v1"
    assert profile["model_id"] == "DemoModel"
    assert profile["revision"] == 1
    assert profile["status"] == "generated"
    assert profile["user_modified"] is False
    assert profile["axes"]


def test_ensure_semantic_axis_profile_adds_unmapped_parameters_as_debug_axes(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")
    model_payload = _build_model_payload()
    model_payload["parameter_scan"]["parameters"].append(
        {
            "id": "ParamAccessoryGlow",
            "name": "Accessory Glow",
            "group_id": "Accessory",
            "group_name": "Accessory",
            "kind": "core",
            "domain": "accessory",
            "channels": [],
        }
    )

    profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )

    extra_axis = next(axis for axis in profile["axes"] if axis["id"] == "ParamAccessoryGlow")
    assert extra_axis["control_role"] == "debug"
    assert extra_axis["parameter_bindings"][0]["parameter_id"] == "ParamAccessoryGlow"


def test_save_semantic_axis_profile_rejects_revision_mismatch(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")

    profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=_build_model_payload(),
    )

    with pytest.raises(SemanticAxisProfileRevisionError):
        save_semantic_axis_profile(
            model_dir=model_dir,
            model_name="DemoModel",
            profile_payload=profile,
            expected_revision=profile["revision"] + 1,
        )


def test_save_semantic_axis_profile_rejects_non_boolean_binding_invert(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")

    profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=_build_model_payload(),
    )
    profile["axes"][0]["parameter_bindings"][0]["invert"] = "false"

    with pytest.raises(SemanticAxisProfileError):
        save_semantic_axis_profile(
            model_dir=model_dir,
            model_name="DemoModel",
            profile_payload=profile,
            expected_revision=profile["revision"],
        )


@pytest.mark.parametrize(
    ("axis_id", "expected_message"),
    [
        ("", "axis id is required"),
        ("1bad", "axis id must match regex"),
        ("bad-axis", "axis id must match regex"),
        ("A" * 65, "exceeds 64 characters"),
    ],
)
def test_validate_semantic_axis_profile_rejects_invalid_axis_id(
    tmp_path,
    axis_id: str,
    expected_message: str,
) -> None:
    profile = _build_valid_profile(tmp_path)
    profile["axes"][0]["id"] = axis_id

    _expect_profile_error(profile, expected_message)


@pytest.mark.parametrize(
    ("field_path", "value", "expected_message"),
    [
        (("axes", 0, "neutral"), float("nan"), "finite number"),
        (("axes", 0, "value_range"), [100.0, 0.0], "minimum must be less than or equal"),
        (("axes", 0, "neutral"), 101.0, "must be within"),
        (("axes", 0, "soft_range"), [-1.0, 50.0], "must be contained within"),
        (("axes", 0, "strong_range"), [50.0, 101.0], "must be contained within"),
        (
            ("axes", 0, "parameter_bindings", 0, "input_range"),
            [10.0, 0.0],
            "minimum must be less than or equal",
        ),
        (
            ("axes", 0, "parameter_bindings", 0, "default_weight"),
            float("inf"),
            "finite number",
        ),
    ],
)
def test_validate_semantic_axis_profile_rejects_invalid_numeric_ranges(
    tmp_path,
    field_path: tuple,
    value,
    expected_message: str,
) -> None:
    profile = _build_valid_profile(tmp_path)
    target = profile
    for key in field_path[:-1]:
        target = target[key]
    target[field_path[-1]] = value

    _expect_profile_error(profile, expected_message)


def test_validate_semantic_axis_profile_rejects_duplicate_parameter_id_in_same_axis(tmp_path) -> None:
    profile = _build_valid_profile(tmp_path)
    duplicate_binding = deepcopy(profile["axes"][0]["parameter_bindings"][0])
    profile["axes"][0]["parameter_bindings"].append(duplicate_binding)

    _expect_profile_error(profile, "duplicate parameter_id")


def test_validate_semantic_axis_profile_rejects_empty_parameter_id(tmp_path) -> None:
    profile = _build_valid_profile(tmp_path)
    profile["axes"][0]["parameter_bindings"][0]["parameter_id"] = ""

    _expect_profile_error(profile, "empty parameter_id")


def test_validate_semantic_axis_profile_rejects_duplicate_coupling_id(tmp_path) -> None:
    profile = _build_valid_profile(tmp_path)
    second_axis = deepcopy(profile["axes"][1])
    first_axis_id = profile["axes"][0]["id"]
    second_axis_id = second_axis["id"]
    profile["couplings"] = [
        {
            "id": "duplicate",
            "source_axis_id": first_axis_id,
            "target_axis_id": second_axis_id,
            "mode": "same_direction",
            "scale": 1.0,
            "deadzone": 0.0,
            "max_delta": 1.0,
        },
        {
            "id": "duplicate",
            "source_axis_id": second_axis_id,
            "target_axis_id": first_axis_id,
            "mode": "opposite_direction",
            "scale": 1.0,
            "deadzone": 0.0,
            "max_delta": 1.0,
        },
    ]

    _expect_profile_error(profile, "Duplicate semantic axis coupling id")


@pytest.mark.parametrize(
    ("source_axis_id", "target_axis_id", "expected_message"),
    [
        ("head_yaw", "head_yaw", "cannot target its source axis"),
        ("head_yaw", "missing_axis", "references an unknown axis"),
    ],
)
def test_validate_semantic_axis_profile_rejects_invalid_coupling_references(
    tmp_path,
    source_axis_id: str,
    target_axis_id: str,
    expected_message: str,
) -> None:
    profile = _build_valid_profile(tmp_path)
    profile["couplings"] = [
        {
            "id": "bad_ref",
            "source_axis_id": source_axis_id,
            "target_axis_id": target_axis_id,
            "mode": "same_direction",
            "scale": 1.0,
            "deadzone": 0.0,
            "max_delta": 1.0,
        }
    ]

    _expect_profile_error(profile, expected_message)


def test_validate_semantic_axis_profile_rejects_coupling_cycles(tmp_path) -> None:
    profile = _build_valid_profile(tmp_path)
    first_axis_id = profile["axes"][0]["id"]
    second_axis_id = profile["axes"][1]["id"]
    profile["couplings"] = [
        {
            "id": "first_to_second",
            "source_axis_id": first_axis_id,
            "target_axis_id": second_axis_id,
            "mode": "same_direction",
            "scale": 1.0,
            "deadzone": 0.0,
            "max_delta": 1.0,
        },
        {
            "id": "second_to_first",
            "source_axis_id": second_axis_id,
            "target_axis_id": first_axis_id,
            "mode": "same_direction",
            "scale": 1.0,
            "deadzone": 0.0,
            "max_delta": 1.0,
        },
    ]

    _expect_profile_error(profile, "couplings must be acyclic")


def test_ensure_semantic_axis_profile_marks_user_modified_profile_stale(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    model_file = model_dir / "Demo.model3.json"
    model_file.write_text("{}", encoding="utf-8")

    initial_profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=_build_model_payload(),
    )
    saved_profile = save_semantic_axis_profile(
        model_dir=model_dir,
        model_name="DemoModel",
        profile_payload=initial_profile,
        expected_revision=initial_profile["revision"],
    )

    model_file.write_text(json.dumps({"changed": True}), encoding="utf-8")
    stale_profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=_build_model_payload(),
    )

    assert stale_profile["revision"] == saved_profile["revision"]
    assert stale_profile["status"] == "stale"
    assert stale_profile["user_modified"] is True
    assert stale_profile["last_scanned_hash"] != saved_profile["last_scanned_hash"]


def test_save_semantic_axis_profile_rejects_source_hash_mismatch(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    model_file = model_dir / "Demo.model3.json"
    model_file.write_text("{}", encoding="utf-8")

    profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=_build_model_payload(),
    )

    model_file.write_text(json.dumps({"changed": True}), encoding="utf-8")
    with pytest.raises(SemanticAxisProfileRevisionError):
        save_semantic_axis_profile(
            model_dir=model_dir,
            model_name="DemoModel",
            profile_payload=profile,
            expected_revision=profile["revision"],
        )
