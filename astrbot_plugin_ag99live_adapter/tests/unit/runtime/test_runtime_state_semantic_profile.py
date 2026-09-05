from __future__ import annotations

import asyncio
import importlib
import json
import sys
from copy import deepcopy

from astrbot_plugin_ag99live_adapter.tests.unit.live2d.test_support import build_seed_model_info


def _import_runtime_state_with_fake_astrbot(*, install_fake_astrbot):
    install_fake_astrbot()
    sys.modules.pop("astrbot_plugin_ag99live_adapter.runtime.state", None)
    return importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.state")


def test_runtime_state_keeps_current_config_when_loader_has_no_snapshot(
    install_fake_astrbot,
    tmp_path,
) -> None:
    runtime_state = _import_runtime_state_with_fake_astrbot(
        install_fake_astrbot=install_fake_astrbot,
    )
    state = runtime_state.RuntimeState(
        platform_config={},
        plugin_context=None,
        plugin_config={"general": {"client_uid": "configured-client"}},
        plugin_config_loader=lambda: None,
        host="127.0.0.1",
        http_port=12397,
        client_uid="desktop-client",
        live2ds_dir=tmp_path / "live2ds",
    )

    assert state._load_latest_plugin_config() is None
    assert state.plugin_config == {"general": {"client_uid": "configured-client"}}


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

    payload = state.build_current_model_payload()
    payload_model = payload["payload"]["model_info"]["models"][0]
    assert payload_model["semantic_axis_profile"]["revision"] == 1
    assert "expression_example_library" not in payload_model
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
        '{"schema_version":"live2d_runtime_cache.v3","scan_cache":[]}',
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

    payload = state.build_current_model_payload()
    assert payload["payload"]["runtime_cache_errors"] == {
        "scan_cache": "live2d_runtime_cache_scan_cache_invalid",
    }
    assert "runtime_cache_errors" not in payload["payload"]["model_info"]


def test_runtime_state_invalidates_old_scan_cache_version(
    monkeypatch,
    install_fake_astrbot,
    tmp_path,
) -> None:
    runtime_state = _import_runtime_state_with_fake_astrbot(
        install_fake_astrbot=install_fake_astrbot,
    )
    seed_model_info = build_seed_model_info()
    scan_calls = 0

    def scan_stub(**kwargs):
        nonlocal scan_calls
        scan_calls += 1
        return deepcopy(seed_model_info)

    monkeypatch.setattr(runtime_state, "scan_live2d_models", scan_stub)
    monkeypatch.setattr(runtime_state, "build_live2d_directory_md5", lambda _path: "sig-current")

    model_dir = tmp_path / "live2ds" / "DemoModel"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "Demo.model3.json").write_text("{}", encoding="utf-8")
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / "live2d_runtime_cache.json"
    cache_path.write_text(
        json.dumps(
            {
                "schema_version": "live2d_runtime_cache.v3",
                "scan_cache": {
                    # This was the cache marker used while model snapshots still
                    # contained ag99.voice_following_profile.v1.
                    "cache_version": "voice_following_tuning.v2",
                    "live2d_dir_md5": "sig-current",
                    "base_url": "http://127.0.0.1:12397",
                    "model_info": {"selected_model": "CachedOnly", "models": []},
                },
            },
            ensure_ascii=False,
        ),
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

    assert scan_calls == 1
    assert state.model_info["selected_model"] == "DemoModel"
    persisted_payload = json.loads(cache_path.read_text(encoding="utf-8"))
    assert persisted_payload["scan_cache"]["cache_version"] == runtime_state.LIVE2D_SCAN_CACHE_VERSION
    assert persisted_payload["scan_cache"]["model_info"]["selected_model"] == "DemoModel"
