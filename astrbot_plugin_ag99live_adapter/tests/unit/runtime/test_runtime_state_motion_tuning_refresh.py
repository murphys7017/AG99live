from __future__ import annotations

import importlib
import sys
from copy import deepcopy

import pytest

from astrbot_plugin_ag99live_adapter.tests.unit.live2d.test_support import build_seed_model_info


def _import_runtime_state_with_fake_astrbot(
    *,
    install_fake_astrbot,
):
    install_fake_astrbot()
    sys.modules.pop("astrbot_plugin_ag99live_adapter.runtime.state", None)
    return importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.state")


def _build_motion_tuning_sample(*, profile_revision: int = 1) -> dict[str, object]:
    return {
        "id": "sample-1",
        "created_at": "2026-04-29T00:00:00+00:00",
        "source_record_id": "record-1",
        "model_name": "DemoModel",
        "profile_id": "DemoModel.semantic.v1",
        "profile_revision": profile_revision,
        "emotion_label": "joy",
        "assistant_text": "好的",
        "feedback": "嘴角再明显一点",
        "tags": ["smile"],
        "enabled_for_llm_reference": True,
        "original_axes": {"mouth_smile": 0.6},
        "adjusted_axes": {"mouth_smile": 0.8},
        "adjusted_plan": {
            "schema_version": "engine.parameter_plan.v2",
            "profile_id": "DemoModel.semantic.v1",
            "profile_revision": profile_revision,
            "model_id": "DemoModel",
            "mode": "expressive",
            "emotion_label": "joy",
            "timing": {
                "duration_ms": 1600,
                "blend_in_ms": 120,
                "hold_ms": 1120,
                "blend_out_ms": 360,
            },
            "parameters": [
                {
                    "axis_id": "mouth_smile",
                    "parameter_id": "ParamMouthSmile",
                    "target_value": 0.8,
                    "weight": 1.0,
                    "input_value": 0.8,
                    "source": "manual",
                }
            ],
        },
    }


def test_runtime_state_persists_motion_tuning_samples_across_refresh_and_rebuilds_few_shot(
    monkeypatch,
    install_fake_astrbot,
    tmp_path,
) -> None:
    runtime_state = _import_runtime_state_with_fake_astrbot(
        install_fake_astrbot=install_fake_astrbot,
    )
    seed_model_info = build_seed_model_info()
    monkeypatch.setattr(
        runtime_state,
        "scan_live2d_models",
        lambda **kwargs: deepcopy(seed_model_info),
    )
    live2ds_dir = tmp_path / "live2ds"
    (live2ds_dir / "DemoModel").mkdir(parents=True, exist_ok=True)
    cache_dir = tmp_path / "cache"

    state = runtime_state.RuntimeState(
        platform_config={},
        plugin_context=None,
        plugin_config={"live2d_model_name": "DemoModel"},
        plugin_config_loader=None,
        host="127.0.0.1",
        http_port=12397,
        client_uid="desktop-client",
        live2ds_dir=live2ds_dir,
        runtime_cache_dir=cache_dir,
    )
    state.refresh()
    current_revision = int(
        state.model_info["models"][0]["semantic_axis_profile"]["revision"]
    )

    saved_sample = state.save_motion_tuning_sample(
        _build_motion_tuning_sample(profile_revision=current_revision)
    )

    assert state.list_motion_tuning_samples() == [saved_sample]
    assert state.motion_tuning_reference_examples[0]["output"]["axes"]["mouth_smile"] == 0.8

    state.refresh()

    assert state.list_motion_tuning_samples() == [saved_sample]
    assert state.motion_tuning_reference_examples[0]["output"]["axes"]["mouth_smile"] == 0.8

    reloaded_state = runtime_state.RuntimeState(
        platform_config={},
        plugin_context=None,
        plugin_config={"live2d_model_name": "DemoModel"},
        plugin_config_loader=None,
        host="127.0.0.1",
        http_port=12397,
        client_uid="desktop-client",
        live2ds_dir=live2ds_dir,
        runtime_cache_dir=cache_dir,
    )
    monkeypatch.setattr(
        runtime_state,
        "scan_live2d_models",
        lambda **kwargs: deepcopy(seed_model_info),
    )
    reloaded_state.refresh()

    assert reloaded_state.list_motion_tuning_samples() == [saved_sample]
    assert reloaded_state.motion_tuning_reference_examples[0]["output"]["axes"]["mouth_smile"] == 0.8


def test_runtime_state_filters_few_shot_examples_by_current_profile_revision(
    monkeypatch,
    install_fake_astrbot,
    tmp_path,
) -> None:
    runtime_state = _import_runtime_state_with_fake_astrbot(
        install_fake_astrbot=install_fake_astrbot,
    )
    seed_model_info = build_seed_model_info()
    monkeypatch.setattr(
        runtime_state,
        "scan_live2d_models",
        lambda **kwargs: deepcopy(seed_model_info),
    )
    live2ds_dir = tmp_path / "live2ds"
    (live2ds_dir / "DemoModel").mkdir(parents=True, exist_ok=True)

    state = runtime_state.RuntimeState(
        platform_config={},
        plugin_context=None,
        plugin_config={"live2d_model_name": "DemoModel"},
        plugin_config_loader=None,
        host="127.0.0.1",
        http_port=12397,
        client_uid="desktop-client",
        live2ds_dir=live2ds_dir,
    )
    state.refresh()
    current_revision = int(
        state.model_info["models"][0]["semantic_axis_profile"]["revision"]
    )

    state.save_motion_tuning_sample(
        _build_motion_tuning_sample(profile_revision=current_revision)
    )
    state.save_motion_tuning_sample(
        {
            **_build_motion_tuning_sample(profile_revision=current_revision + 1),
            "id": "sample-2",
        }
    )

    assert len(state.list_motion_tuning_samples()) == 2
    assert len(state.motion_tuning_reference_examples) == 1
    assert state.motion_tuning_reference_examples[0]["output"]["axes"]["mouth_smile"] == 0.8


def test_runtime_state_delete_missing_motion_tuning_sample_raises(
    monkeypatch,
    install_fake_astrbot,
    tmp_path,
) -> None:
    runtime_state = _import_runtime_state_with_fake_astrbot(
        install_fake_astrbot=install_fake_astrbot,
    )
    seed_model_info = build_seed_model_info()
    monkeypatch.setattr(
        runtime_state,
        "scan_live2d_models",
        lambda **kwargs: deepcopy(seed_model_info),
    )
    live2ds_dir = tmp_path / "live2ds"
    (live2ds_dir / "DemoModel").mkdir(parents=True, exist_ok=True)

    state = runtime_state.RuntimeState(
        platform_config={},
        plugin_context=None,
        plugin_config={"live2d_model_name": "DemoModel"},
        plugin_config_loader=None,
        host="127.0.0.1",
        http_port=12397,
        client_uid="desktop-client",
        live2ds_dir=live2ds_dir,
    )
    state.refresh()
    current_revision = int(
        state.model_info["models"][0]["semantic_axis_profile"]["revision"]
    )
    saved_sample = state.save_motion_tuning_sample(
        _build_motion_tuning_sample(profile_revision=current_revision)
    )

    with pytest.raises(ValueError, match="motion_tuning_sample_not_found: missing-sample"):
        state.delete_motion_tuning_sample("missing-sample")

    assert state.list_motion_tuning_samples() == [saved_sample]
