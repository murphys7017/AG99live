from __future__ import annotations

import json
import importlib

import pytest

from astrbot_plugin_ag99live_adapter.live2d.semantic_axis_profile import (
    SemanticAxisProfileError,
    SemanticAxisProfileRevisionError,
    build_semantic_axis_profile_path,
    ensure_semantic_axis_profile,
    save_semantic_axis_profile,
)

from .test_support import build_seed_model_info


def _build_model_payload() -> dict:
    return build_seed_model_info()["models"][0]


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
