from __future__ import annotations

import asyncio
import importlib
import sys
from copy import deepcopy

from astrbot_plugin_ag99live_adapter.tests.unit.live2d.test_support import build_seed_model_info


def _import_runtime_state_with_fake_astrbot(*, install_fake_astrbot):
    install_fake_astrbot()
    sys.modules.pop("astrbot_plugin_ag99live_adapter.runtime.state", None)
    return importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.state")


def test_runtime_state_injects_semantic_profile_into_model_sync(
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

    model_dir = tmp_path / "live2ds" / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")

    state = runtime_state.RuntimeState(
        platform_config={},
        plugin_context=None,
        plugin_config={},
        plugin_config_loader=None,
        host="127.0.0.1",
        http_port=12397,
        client_uid="desktop-client",
        live2ds_dir=tmp_path / "live2ds",
    )
    asyncio.run(state.refresh_async())

    model = state.model_info["models"][0]
    assert "semantic_axis_profile" in model
    assert model["semantic_axis_profile"]["profile_id"] == "DemoModel.semantic.v1"

    payload = state.build_current_model_payload(
        conf_name="conf",
        conf_uid="conf-uid",
        client_uid="desktop-client",
    )
    payload_model = payload["payload"]["model_info"]["models"][0]
    assert payload_model["semantic_axis_profile"]["revision"] == 1
    assert payload["payload"]["runtime_cache_errors"] == {}


def test_runtime_state_exposes_runtime_cache_segment_errors_in_model_sync(
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

    model_dir = tmp_path / "live2ds" / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / "live2d_runtime_cache.json").write_text(
        '{"schema_version":"live2d_runtime_cache.v1","scan_cache":[],"action_filter_cache":[],"motion_tuning_samples":[]}',
        encoding="utf-8",
    )

    state = runtime_state.RuntimeState(
        platform_config={},
        plugin_context=None,
        plugin_config={},
        plugin_config_loader=None,
        host="127.0.0.1",
        http_port=12397,
        client_uid="desktop-client",
        live2ds_dir=tmp_path / "live2ds",
        runtime_cache_dir=cache_dir,
    )
    asyncio.run(state.refresh_async())

    payload = state.build_current_model_payload(
        conf_name="conf",
        conf_uid="conf-uid",
        client_uid="desktop-client",
    )
    assert payload["payload"]["runtime_cache_errors"] == {
        "scan_cache": "live2d_runtime_cache_scan_cache_invalid",
        "action_filter_cache": "live2d_runtime_cache_action_filter_cache_invalid",
    }
    assert payload["payload"]["model_info"]["runtime_cache_errors"] == {
        "scan_cache": "live2d_runtime_cache_scan_cache_invalid",
        "action_filter_cache": "live2d_runtime_cache_action_filter_cache_invalid",
    }
