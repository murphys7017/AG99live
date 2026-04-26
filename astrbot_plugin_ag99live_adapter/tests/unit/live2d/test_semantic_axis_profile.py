from __future__ import annotations

import json

import pytest

from astrbot_plugin_ag99live_adapter.live2d.semantic_axis_profile import (
    SemanticAxisProfileRevisionError,
    build_semantic_axis_profile_path,
    ensure_semantic_axis_profile,
    save_semantic_axis_profile,
)

from .test_support import build_seed_model_info


def _build_model_payload() -> dict:
    return build_seed_model_info()["models"][0]


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
