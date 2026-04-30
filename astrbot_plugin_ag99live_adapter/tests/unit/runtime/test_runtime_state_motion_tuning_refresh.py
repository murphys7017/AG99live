from __future__ import annotations

import importlib
import json
import sys
from copy import deepcopy

import pytest

from astrbot_plugin_ag99live_adapter.prompts.motion_selector import (
    resolve_selector_few_shot_examples,
)
from astrbot_plugin_ag99live_adapter.tests.unit.live2d.test_support import build_seed_model_info


def _import_runtime_state_with_fake_astrbot(
    *,
    install_fake_astrbot,
):
    install_fake_astrbot()
    sys.modules.pop("astrbot_plugin_ag99live_adapter.runtime.state", None)
    return importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.state")


def _build_motion_tuning_sample(
    *,
    sample_id: str = "sample-1",
    profile_revision: int = 1,
) -> dict[str, object]:
    return {
        "id": sample_id,
        "created_at": "2026-04-29T00:00:00+00:00",
        "source_record_id": f"record-{sample_id}",
        "model_name": "DemoModel",
        "profile_id": "DemoModel.semantic.v1",
        "profile_revision": profile_revision,
        "emotion_label": "joy",
        "assistant_text": f"好的 {sample_id}",
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


def test_runtime_state_does_not_silently_truncate_motion_tuning_samples(
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

    for index in range(205):
        state.save_motion_tuning_sample(
            _build_motion_tuning_sample(
                sample_id=f"sample-{index}",
                profile_revision=current_revision,
            )
        )

    expected_ids = {f"sample-{index}" for index in range(205)}
    saved_ids = {item["id"] for item in state.list_motion_tuning_samples()}

    assert len(state.list_motion_tuning_samples()) == 205
    assert saved_ids == expected_ids
    assert len(state.motion_tuning_reference_examples) == 205

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

    reloaded_ids = {item["id"] for item in reloaded_state.list_motion_tuning_samples()}
    assert len(reloaded_state.list_motion_tuning_samples()) == 205
    assert reloaded_ids == expected_ids
    assert len(reloaded_state.motion_tuning_reference_examples) == 205


def test_runtime_state_marks_motion_tuning_sample_cache_error_on_invalid_persisted_sample(
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
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / "live2d_runtime_cache.json"
    cache_path.write_text(
        json.dumps(
            {
                "schema_version": "live2d_runtime_cache.v1",
                "scan_cache": {},
                "action_filter_cache": {},
                "motion_tuning_samples": [
                    {
                        "id": "",
                        "created_at": "2026-04-29T00:00:00+00:00",
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

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

    assert state.list_motion_tuning_samples() == []
    assert state.get_motion_tuning_samples_load_error() == (
        "motion_tuning_samples_invalid_persisted_sample: "
        "motion_tuning_sample_id_required"
    )
    assert state.motion_tuning_reference_examples == []


def test_runtime_state_exposes_fewshot_shortage_diagnostics(
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
        plugin_config={
            "live2d_model_name": "DemoModel",
            "realtime_motion_fewshot_count": 3,
        },
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

    resolved_examples = resolve_selector_few_shot_examples(runtime_state=state)
    assert len(resolved_examples) == 3
    assert state.list_motion_tuning_fewshot_diagnostics() == [
        "motion_tuning_user_samples_insufficient:requested=3:user_available=1",
        "motion_tuning_default_backfill_applied:count=2",
    ]


def test_runtime_state_preserves_motion_tuning_samples_when_scan_cache_segment_is_invalid(
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
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / "live2d_runtime_cache.json"
    sample = _build_motion_tuning_sample(profile_revision=3)
    cache_path.write_text(
        json.dumps(
            {
                "schema_version": "live2d_runtime_cache.v1",
                "scan_cache": [],
                "action_filter_cache": {},
                "motion_tuning_samples": [sample],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

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

    assert state.get_runtime_cache_root_error() == ""
    assert state.get_motion_tuning_samples_load_error() == ""
    assert state.list_runtime_cache_segment_errors() == {
        "scan_cache": "live2d_runtime_cache_scan_cache_invalid"
    }
    assert state.list_motion_tuning_samples() == [sample]
    persisted_payload = json.loads(cache_path.read_text(encoding="utf-8"))
    assert persisted_payload["scan_cache"] == []


def test_runtime_state_preserves_motion_tuning_samples_when_action_filter_cache_segment_is_invalid(
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
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / "live2d_runtime_cache.json"
    sample = _build_motion_tuning_sample(profile_revision=3)
    cache_path.write_text(
        json.dumps(
            {
                "schema_version": "live2d_runtime_cache.v1",
                "scan_cache": {},
                "action_filter_cache": [],
                "motion_tuning_samples": [sample],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

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

    assert state.get_runtime_cache_root_error() == ""
    assert state.get_motion_tuning_samples_load_error() == ""
    assert state.list_runtime_cache_segment_errors() == {
        "action_filter_cache": "live2d_runtime_cache_action_filter_cache_invalid"
    }
    assert state.list_motion_tuning_samples() == [sample]
    persisted_payload = json.loads(cache_path.read_text(encoding="utf-8"))
    assert persisted_payload["action_filter_cache"] == []


def test_runtime_state_rejects_motion_tuning_sample_save_when_root_cache_error_is_active(
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
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / "live2d_runtime_cache.json"
    cache_path.write_text("{broken json", encoding="utf-8")

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

    with pytest.raises(ValueError, match="runtime_cache_root_error_active:"):
        state.save_motion_tuning_sample(_build_motion_tuning_sample(profile_revision=3))


def test_runtime_state_rejects_motion_tuning_sample_save_when_segment_cache_error_is_active(
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
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / "live2d_runtime_cache.json"
    cache_path.write_text(
        json.dumps(
            {
                "schema_version": "live2d_runtime_cache.v1",
                "scan_cache": [],
                "action_filter_cache": {},
                "motion_tuning_samples": [],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

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

    with pytest.raises(ValueError, match="runtime_cache_segment_error_active:"):
        state.save_motion_tuning_sample(_build_motion_tuning_sample(profile_revision=3))


def test_runtime_state_rejects_motion_tuning_sample_delete_when_root_cache_error_is_active(
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
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / "live2d_runtime_cache.json"
    cache_path.write_text("{broken json", encoding="utf-8")

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

    with pytest.raises(ValueError, match="runtime_cache_root_error_active:"):
        state.delete_motion_tuning_sample("sample-1")


def test_runtime_state_rejects_motion_tuning_sample_delete_when_segment_cache_error_is_active(
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
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / "live2d_runtime_cache.json"
    cache_path.write_text(
        json.dumps(
            {
                "schema_version": "live2d_runtime_cache.v1",
                "scan_cache": {},
                "action_filter_cache": [],
                "motion_tuning_samples": [],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

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

    with pytest.raises(ValueError, match="runtime_cache_segment_error_active:"):
        state.delete_motion_tuning_sample("sample-1")


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
