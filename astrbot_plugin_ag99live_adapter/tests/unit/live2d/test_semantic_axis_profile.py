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


def _add_motion_axis_parameters(model_payload: dict) -> None:
    parameter_scan = model_payload["parameter_scan"]
    parameter_specs = [
        ("body_yaw", "ParamBodyAngleX", "Body", "body"),
        ("body_roll", "ParamBodyAngleZ", "Body", "body"),
        ("body_pitch", "BodyAngleY", "Body", "body"),
        ("eye_open_left", "ParamEyeLOpen", "Eye", "eye"),
        ("eye_open_right", "ParamEyeROpen", "Eye", "eye"),
        ("eye_smile_left", "ParamEyeLSmile", "Eye", "eye"),
        ("eye_smile_right", "ParamEyeRSmile", "Eye", "eye"),
        ("mouth_smile", "ParamMouthForm", "Mouth", "mouth"),
        ("mouth_x", "ParamMouthX", "Mouth", "mouth"),
        ("brow_bias", "ParamBrowForm", "Brow", "brow"),
        ("brow_left_detail", "ParamBrowLDown", "Brow", "brow"),
        ("brow_right_detail", "ParamBrowRDown", "Brow", "brow"),
        ("breath", "ParamBreath", "Breath", "breath"),
    ]
    existing_parameter_ids = {
        str(item.get("id") or "").strip()
        for item in parameter_scan["parameters"]
        if isinstance(item, dict)
    }
    existing_primary_channels = {
        str(item.get("channel") or "").strip()
        for item in parameter_scan["primary_parameters"]
        if isinstance(item, dict)
    }
    for channel, parameter_id, group_name, domain in parameter_specs:
        parameter_scan["standard_channels"][channel] = {
            "label": channel.replace("_", " ").title(),
            "available": True,
            "primary_parameter_id": parameter_id,
            "primary_parameter_name": parameter_id,
            "group_name": group_name,
            "candidate_parameter_ids": [parameter_id],
        }
        if channel not in existing_primary_channels:
            parameter_scan["primary_parameters"].append(
                {
                    "channel": channel,
                    "parameter_id": parameter_id,
                    "parameter_name": parameter_id,
                    "group_name": group_name,
                }
            )
            existing_primary_channels.add(channel)
        if parameter_id not in existing_parameter_ids:
            parameter_scan["parameters"].append(
                {
                    "id": parameter_id,
                    "name": parameter_id,
                    "group_id": group_name,
                    "group_name": group_name,
                    "kind": "core",
                    "domain": domain,
                    "channels": [channel],
                }
            )
            existing_parameter_ids.add(parameter_id)


def _expect_profile_error(
    profile: dict,
    expected_message: str,
    *,
    enforce_runtime_contracts: bool = False,
) -> None:
    with pytest.raises(SemanticAxisProfileError, match=expected_message):
        validate_semantic_axis_profile(
            profile,
            model_name="DemoModel",
            enforce_runtime_contracts=enforce_runtime_contracts,
        )


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


def test_live2d_runtime_cache_treats_missing_motion_tuning_samples_as_empty(
    tmp_path,
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    runtime_cache = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.live2d.cache.runtime_cache"
    )
    cache_path = tmp_path / "live2d_runtime_cache.json"
    cache_path.write_text(
        json.dumps(
            {
                "schema_version": "live2d_runtime_cache.v1",
                "scan_cache": {},
                "action_filter_cache": {},
            }
        ),
        encoding="utf-8",
    )

    payload, errors = runtime_cache.load_live2d_runtime_cache(cache_path)

    assert errors == {}
    assert payload["motion_tuning_samples"] == []


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
    assert set(profile["axes"][0]["level_anchors"]) == {
        "-3", "-2", "-1", "0", "1", "2", "3"
    }


def test_validate_semantic_axis_profile_accepts_ordered_custom_level_anchors(tmp_path) -> None:
    profile = _build_valid_profile(tmp_path)
    axis = profile["axes"][0]
    neutral = axis["neutral"]
    axis["level_anchors"] = {
        "-3": neutral - 20,
        "-2": neutral - 12,
        "-1": neutral - 5,
        "0": neutral,
        "1": neutral + 5,
        "2": neutral + 12,
        "3": neutral + 20,
    }

    normalized = validate_semantic_axis_profile(profile, model_name="DemoModel")

    assert normalized["axes"][0]["level_anchors"] == axis["level_anchors"]


@pytest.mark.parametrize(
    ("mutate", "expected_message"),
    [
        (lambda anchors, neutral: anchors.update({"4": neutral}), "unsupported level"),
        (lambda anchors, neutral: anchors.update({"0": neutral + 1}), "must equal the axis neutral"),
        (lambda anchors, neutral: anchors.update({"-1": neutral + 1}), "must be ordered"),
    ],
)
def test_validate_semantic_axis_profile_rejects_invalid_level_anchors(
    tmp_path,
    mutate,
    expected_message: str,
) -> None:
    profile = _build_valid_profile(tmp_path)
    axis = profile["axes"][0]
    mutate(axis["level_anchors"], axis["neutral"])

    _expect_profile_error(profile, expected_message)


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

    extra_axis = next(
        axis
        for axis in profile["axes"]
        if axis["parameter_bindings"][0]["parameter_id"] == "ParamAccessoryGlow"
    )
    assert extra_axis["id"].startswith("debug_paramaccessoryglow_")
    assert extra_axis["control_role"] == "debug"
    assert extra_axis["parameter_bindings"][0]["parameter_id"] == "ParamAccessoryGlow"


def test_default_semantic_axis_profile_uses_motion_axis_roles(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")
    model_payload = _build_model_payload()
    _add_motion_axis_parameters(model_payload)

    profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )
    axes = {axis["id"]: axis for axis in profile["axes"]}

    assert axes["body_yaw"]["control_role"] == "primary"
    assert axes["body_roll"]["control_role"] == "primary"
    assert axes["body_pitch"]["control_role"] == "primary"
    assert axes["body_pitch"]["parameter_bindings"][0]["parameter_id"] == "BodyAngleY"
    couplings = {coupling["id"]: coupling for coupling in profile["couplings"]}
    assert couplings["head_yaw_to_body_yaw"]["scale"] == 0.5
    relation_edges = {
        edge["id"]: edge
        for edge in profile["relation_graph"]["edges"]
    }
    assert relation_edges["head_yaw_to_body_yaw"]["kind"] == "bounded_ratio"
    assert axes["eye_open_left"]["control_role"] == "primary"
    assert axes["eye_open_left"]["neutral"] == 100.0
    assert axes["eye_open_left"]["parameter_bindings"][0]["invert"] is False
    assert axes["eye_open_right"]["control_role"] == "primary"
    assert axes["eye_open_right"]["neutral"] == 100.0
    assert axes["eye_open_right"]["parameter_bindings"][0]["invert"] is False
    assert axes["eye_smile_left"]["control_role"] == "primary"
    assert axes["eye_smile_right"]["control_role"] == "primary"
    assert axes["mouth_smile"]["control_role"] == "hint"
    assert axes["mouth_x"]["control_role"] == "hint"
    assert axes["brow_bias"]["control_role"] == "hint"
    assert axes["brow_left_detail"]["control_role"] == "hint"
    assert axes["brow_right_detail"]["control_role"] == "hint"
    assert axes["mouth_open"]["control_role"] == "runtime"
    assert axes["breath"]["control_role"] == "ambient"


def test_default_semantic_axis_profile_uses_stronger_roll_body_coupling(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")
    model_payload = _build_model_payload()
    _add_motion_axis_parameters(model_payload)
    parameter_scan = model_payload["parameter_scan"]
    parameter_scan["standard_channels"]["head_roll"] = {
        "label": "Head Roll",
        "available": True,
        "primary_parameter_id": "ParamAngleZ",
        "primary_parameter_name": "ParamAngleZ",
        "group_name": "Head",
        "candidate_parameter_ids": ["ParamAngleZ"],
    }

    profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )
    couplings = {coupling["id"]: coupling for coupling in profile["couplings"]}

    assert couplings["head_roll_to_body_roll"]["scale"] == 0.45


def test_ensure_semantic_axis_profile_migrates_old_generated_default_design(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")
    model_payload = _build_model_payload()
    _add_motion_axis_parameters(model_payload)

    old_profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )
    old_profile["axes"] = [
        axis
        for axis in old_profile["axes"]
        if axis["id"] not in {"body_pitch", "eye_smile_left", "eye_smile_right"}
    ]
    for axis in old_profile["axes"]:
        if axis["id"] in {"body_yaw", "body_roll"}:
            axis["control_role"] = "derived"
        if axis["id"] == "mouth_smile":
            axis["control_role"] = "primary"
    build_semantic_axis_profile_path(model_dir).write_text(
        json.dumps(old_profile, ensure_ascii=False),
        encoding="utf-8",
    )

    migrated_profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )
    axes = {axis["id"]: axis for axis in migrated_profile["axes"]}

    assert migrated_profile["revision"] == old_profile["revision"] + 1
    assert migrated_profile["status"] == "generated"
    assert migrated_profile["user_modified"] is False
    assert axes["body_yaw"]["control_role"] == "primary"
    assert axes["body_roll"]["control_role"] == "primary"
    assert axes["mouth_smile"]["control_role"] == "hint"
    assert "body_pitch" in axes
    assert "eye_smile_left" in axes
    assert "eye_smile_right" in axes


def test_ensure_semantic_axis_profile_persists_relation_graph_migration(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")
    model_payload = _build_model_payload()
    _add_motion_axis_parameters(model_payload)

    original_profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )
    original_path = build_semantic_axis_profile_path(model_dir)
    legacy_payload = json.loads(original_path.read_text(encoding="utf-8"))
    legacy_payload.pop("relation_graph", None)
    original_path.write_text(
        json.dumps(legacy_payload, ensure_ascii=False),
        encoding="utf-8",
    )

    migrated_profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )
    persisted_payload = json.loads(original_path.read_text(encoding="utf-8"))

    assert migrated_profile["revision"] == original_profile["revision"]
    assert persisted_payload["revision"] == original_profile["revision"]
    assert persisted_payload["axes"] == legacy_payload["axes"]
    assert persisted_payload["couplings"] == legacy_payload["couplings"]
    assert persisted_payload["relation_graph"] == migrated_profile["relation_graph"]


def test_ensure_semantic_axis_profile_persists_missing_level_anchors(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")
    model_payload = _build_model_payload()

    original_profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )
    profile_path = build_semantic_axis_profile_path(model_dir)
    legacy_payload = json.loads(profile_path.read_text(encoding="utf-8"))
    for axis in legacy_payload["axes"]:
        axis.pop("level_anchors", None)
    profile_path.write_text(
        json.dumps(legacy_payload, ensure_ascii=False),
        encoding="utf-8",
    )

    migrated_profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )
    persisted_payload = json.loads(profile_path.read_text(encoding="utf-8"))

    assert migrated_profile["revision"] == original_profile["revision"]
    assert all(
        set(axis["level_anchors"]) == {"-3", "-2", "-1", "0", "1", "2", "3"}
        for axis in persisted_payload["axes"]
    )


def test_ensure_semantic_axis_profile_refreshes_stale_user_modified_old_default_design(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")
    model_payload = _build_model_payload()
    _add_motion_axis_parameters(model_payload)

    old_profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )
    old_profile["status"] = "user_modified"
    old_profile["user_modified"] = True
    old_profile["axes"] = [
        axis
        for axis in old_profile["axes"]
        if axis["id"] != "body_pitch"
    ]
    for axis in old_profile["axes"]:
        if axis["id"] == "mouth_smile":
            axis["control_role"] = "primary"
    build_semantic_axis_profile_path(model_dir).write_text(
        json.dumps(old_profile, ensure_ascii=False),
        encoding="utf-8",
    )

    stale_profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )
    axes = {axis["id"]: axis for axis in stale_profile["axes"]}

    assert stale_profile["revision"] == old_profile["revision"]
    assert stale_profile["status"] == "stale"
    assert stale_profile["user_modified"] is True
    assert "body_pitch" not in axes
    assert axes["mouth_smile"]["control_role"] == "primary"

    refreshed_profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )
    refreshed_axes = {axis["id"]: axis for axis in refreshed_profile["axes"]}
    assert refreshed_profile["revision"] == stale_profile["revision"] + 1
    assert refreshed_profile["status"] == "generated"
    assert refreshed_profile["user_modified"] is False
    assert "body_pitch" in refreshed_axes
    assert refreshed_axes["mouth_smile"]["control_role"] == "hint"


def test_default_semantic_axis_profile_uses_single_preferred_binding_per_axis(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")
    model_payload = _build_model_payload()
    parameter_scan = model_payload["parameter_scan"]
    parameter_scan["standard_channels"]["head_yaw"]["candidate_parameter_ids"] = [
        "ParamAngleX",
        "ParamBodyAngleX",
    ]
    parameter_scan["standard_channels"]["body_yaw"] = {
        "label": "Body Yaw",
        "available": True,
        "primary_parameter_id": "ParamBodyAngleX",
        "primary_parameter_name": "ParamBodyAngleX",
        "group_name": "Body",
        "candidate_parameter_ids": ["ParamBodyAngleX"],
    }
    parameter_scan["parameters"].append(
        {
            "id": "ParamBodyAngleX",
            "name": "ParamBodyAngleX",
            "group_id": "Body",
            "group_name": "Body",
            "kind": "core",
            "domain": "body",
            "channels": ["body_yaw"],
        }
    )

    profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )

    head_yaw = next(axis for axis in profile["axes"] if axis["id"] == "head_yaw")
    body_yaw = next(axis for axis in profile["axes"] if axis["id"] == "body_yaw")
    assert [binding["parameter_id"] for binding in head_yaw["parameter_bindings"]] == ["ParamAngleX"]
    assert [binding["parameter_id"] for binding in body_yaw["parameter_bindings"]] == ["ParamBodyAngleX"]
    validate_semantic_axis_profile(
        profile,
        model_name="DemoModel",
        enforce_runtime_contracts=True,
    )


def test_default_semantic_axis_profile_skips_already_bound_preferred_parameter(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")
    model_payload = _build_model_payload()
    parameter_scan = model_payload["parameter_scan"]
    parameter_scan["standard_channels"]["body_yaw"] = {
        "label": "Body Yaw",
        "available": True,
        "primary_parameter_id": "ParamAngleX",
        "primary_parameter_name": "ParamAngleX",
        "group_name": "Body",
        "candidate_parameter_ids": ["ParamAngleX"],
    }

    profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )

    assert [axis["id"] for axis in profile["axes"]].count("head_yaw") == 1
    assert all(axis["id"] != "body_yaw" for axis in profile["axes"])
    validate_semantic_axis_profile(
        profile,
        model_name="DemoModel",
        enforce_runtime_contracts=True,
    )


def test_ensure_semantic_axis_profile_decouples_debug_axis_id_from_parameter_id(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")
    model_payload = _build_model_payload()
    raw_parameter_id = "01.Param-Accessory:Glow"
    model_payload["parameter_scan"]["parameters"].append(
        {
            "id": raw_parameter_id,
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

    extra_axis = next(
        axis
        for axis in profile["axes"]
        if axis["parameter_bindings"][0]["parameter_id"] == raw_parameter_id
    )
    assert extra_axis["id"] != raw_parameter_id
    assert extra_axis["id"].startswith("debug_param_01_param_accessory_glow_")
    validate_semantic_axis_profile(
        profile,
        model_name="DemoModel",
        known_parameter_ids={item["id"] for item in model_payload["parameter_scan"]["parameters"]},
    )


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


def test_save_semantic_axis_profile_recovers_missing_profile_file(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")

    profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=_build_model_payload(),
    )
    build_semantic_axis_profile_path(model_dir).unlink()

    saved_profile = save_semantic_axis_profile(
        model_dir=model_dir,
        model_name="DemoModel",
        profile_payload=profile,
        expected_revision=profile["revision"],
    )

    assert build_semantic_axis_profile_path(model_dir).exists()
    assert saved_profile["revision"] == profile["revision"] + 1
    assert saved_profile["status"] == "user_modified"


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


def test_validate_semantic_axis_profile_rejects_duplicate_parameter_id_across_axes_when_runtime_contracts_enforced(
    tmp_path,
) -> None:
    profile = _build_valid_profile(tmp_path)
    shared_binding = deepcopy(profile["axes"][0]["parameter_bindings"][0])
    profile["axes"][1]["parameter_bindings"] = [shared_binding]

    with pytest.raises(SemanticAxisProfileError, match="unique across axes"):
        validate_semantic_axis_profile(
            profile,
            model_name="DemoModel",
            enforce_runtime_contracts=True,
        )


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


def test_validate_semantic_axis_profile_rejects_invalid_relation_graph_kind(tmp_path) -> None:
    profile = _build_valid_profile(tmp_path)
    source_axis_id = profile["axes"][0]["id"]
    target_axis_id = profile["axes"][1]["id"]
    profile["relation_graph"]["edges"] = [
        {
            "id": "invalid_kind",
            "source_axis_id": source_axis_id,
            "target_axis_id": target_axis_id,
            "kind": "unknown",
            "mode": "same_direction",
            "scale": 1.0,
            "deadzone": 0.0,
            "max_delta": 1.0,
        }
    ]

    _expect_profile_error(profile, "relation_graph\\.edge\\.kind")


def test_validate_semantic_axis_profile_rejects_relation_graph_unknown_axis(tmp_path) -> None:
    profile = _build_valid_profile(tmp_path)
    profile["relation_graph"]["edges"] = [
        {
            "id": "unknown_target",
            "source_axis_id": profile["axes"][0]["id"],
            "target_axis_id": "missing_axis",
            "kind": "derive",
            "mode": "same_direction",
            "scale": 1.0,
            "deadzone": 0.0,
            "max_delta": 1.0,
        }
    ]

    _expect_profile_error(profile, "relation rule.*references an unknown axis")


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


@pytest.mark.parametrize(
    ("field_name", "expected_message"),
    [
        ("scale", r"coupling\.scale"),
        ("deadzone", r"coupling\.deadzone"),
        ("max_delta", r"coupling\.max_delta"),
    ],
)
def test_validate_semantic_axis_profile_rejects_negative_coupling_limits(
    tmp_path,
    field_name: str,
    expected_message: str,
) -> None:
    profile = _build_valid_profile(tmp_path)
    profile["couplings"] = [
        {
            "id": "negative_limit",
            "source_axis_id": profile["axes"][0]["id"],
            "target_axis_id": profile["axes"][1]["id"],
            "mode": "same_direction",
            "scale": 1.0,
            "deadzone": 0.0,
            "max_delta": 1.0,
        }
    ]
    profile["couplings"][0][field_name] = -0.01

    _expect_profile_error(
        profile,
        expected_message,
        enforce_runtime_contracts=True,
    )


def test_validate_semantic_axis_profile_rejects_duplicate_coupling_target_when_runtime_contracts_enforced(
    tmp_path,
) -> None:
    profile = _build_valid_profile(tmp_path)
    source_axis_id = profile["axes"][0]["id"]
    target_axis_id = profile["axes"][1]["id"]
    profile["couplings"] = [
        {
            "id": "first_target",
            "source_axis_id": source_axis_id,
            "target_axis_id": target_axis_id,
            "mode": "same_direction",
            "scale": 1.0,
            "deadzone": 0.0,
            "max_delta": 1.0,
        },
        {
            "id": "second_target",
            "source_axis_id": source_axis_id,
            "target_axis_id": target_axis_id,
            "mode": "opposite_direction",
            "scale": 1.0,
            "deadzone": 0.0,
            "max_delta": 1.0,
        },
    ]

    _expect_profile_error(
        profile,
        "share the same target axis",
        enforce_runtime_contracts=True,
    )


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


def test_ensure_semantic_axis_profile_marks_stale_before_current_parameter_validation(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    model_file = model_dir / "Demo.model3.json"
    model_file.write_text("{}", encoding="utf-8")
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

    initial_profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=model_payload,
    )
    saved_profile = save_semantic_axis_profile(
        model_dir=model_dir,
        model_name="DemoModel",
        profile_payload=initial_profile,
        expected_revision=initial_profile["revision"],
        known_parameter_ids={item["id"] for item in model_payload["parameter_scan"]["parameters"]},
    )

    next_model_payload = _build_model_payload()
    model_file.write_text(json.dumps({"changed": True}), encoding="utf-8")
    stale_profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=next_model_payload,
    )

    assert stale_profile["revision"] == saved_profile["revision"]
    assert stale_profile["status"] == "stale"
    assert stale_profile["user_modified"] is True
    assert any(
        binding["parameter_id"] == "ParamAccessoryGlow"
        for axis in stale_profile["axes"]
        for binding in axis["parameter_bindings"]
    )


def test_save_semantic_axis_profile_rejects_duplicate_parameter_id_across_axes(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")

    profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=_build_model_payload(),
    )
    profile["axes"][1]["parameter_bindings"] = [
        deepcopy(profile["axes"][0]["parameter_bindings"][0])
    ]

    with pytest.raises(SemanticAxisProfileError, match="unique across axes"):
        save_semantic_axis_profile(
            model_dir=model_dir,
            model_name="DemoModel",
            profile_payload=profile,
            expected_revision=profile["revision"],
        )


def test_save_semantic_axis_profile_rejects_duplicate_coupling_targets(tmp_path) -> None:
    model_dir = tmp_path / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")

    profile = ensure_semantic_axis_profile(
        model_dir=model_dir,
        model_payload=_build_model_payload(),
    )
    source_axis_id = profile["axes"][0]["id"]
    target_axis_id = profile["axes"][1]["id"]
    profile["couplings"] = [
        {
            "id": "first_target",
            "source_axis_id": source_axis_id,
            "target_axis_id": target_axis_id,
            "mode": "same_direction",
            "scale": 1.0,
            "deadzone": 0.0,
            "max_delta": 1.0,
        },
        {
            "id": "second_target",
            "source_axis_id": source_axis_id,
            "target_axis_id": target_axis_id,
            "mode": "opposite_direction",
            "scale": 1.0,
            "deadzone": 0.0,
            "max_delta": 1.0,
        },
    ]

    with pytest.raises(SemanticAxisProfileError, match="share the same target axis"):
        save_semantic_axis_profile(
            model_dir=model_dir,
            model_name="DemoModel",
            profile_payload=profile,
            expected_revision=profile["revision"],
        )


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
