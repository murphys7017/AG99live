from __future__ import annotations

from types import SimpleNamespace

from astrbot_plugin_ag99live_adapter.runtime import plugin_runtime
from astrbot_plugin_ag99live_adapter.runtime.plugin_runtime import (
    get_config_value,
    prune_retired_plugin_config_fields,
)


def test_get_config_value_uses_mapping_values_and_defaults() -> None:
    config = {"configured": "value", "empty": None}

    assert get_config_value(config, "configured", "default") == "value"
    assert get_config_value(config, "missing", "default") == "default"
    assert get_config_value(config, "empty", "default") == "default"
    assert get_config_value(None, "configured", "default") == "default"


def test_prune_retired_plugin_fields_keeps_active_and_unowned_config() -> None:
    config = {
        "independent_motion": {
            "per_speech_segment": True,
            "segment_stream_enabled": True,
        },
        "desktop_observation": {
            "enabled": True,
            "provider_id": "retired-provider",
            "timeout_seconds": 5,
        },
        "remote_operator": {
            "default_computer": "local",
            "computer_entries": [{"id": "local"}],
            "default_profile": "simple",
            "probe_max_failures": 3,
            "profiles": {"simple": {}},
        },
        "performance_curve": {"enabled": True, "provider_id": "active-provider"},
        "image_cooldown_seconds": 10,
        "remote_operator_default_computer": "local",
        "remote_operator_computer_entries": [{"id": "local"}],
        "remote_operator_default_profile": "simple",
        "remote_operator_probe_max_failures": 3,
        "remote_operator_profiles": {"simple": {}},
        "memory": {"enabled": True},
    }

    removed = prune_retired_plugin_config_fields(config)

    assert set(removed) == {
        "image_cooldown_seconds",
        "independent_motion.segment_stream_enabled",
        "desktop_observation.provider_id",
        "desktop_observation.timeout_seconds",
        "remote_operator.default_computer",
        "remote_operator.computer_entries",
        "remote_operator.default_profile",
        "remote_operator.probe_max_failures",
        "remote_operator.profiles",
        "remote_operator",
        "remote_operator_default_computer",
        "remote_operator_computer_entries",
        "remote_operator_default_profile",
        "remote_operator_probe_max_failures",
        "remote_operator_profiles",
    }
    assert config == {
        "independent_motion": {"per_speech_segment": True},
        "desktop_observation": {"enabled": True},
        "performance_curve": {"enabled": True, "provider_id": "active-provider"},
        "memory": {"enabled": True},
    }


def test_plugin_config_snapshot_reports_injected_and_file_sources(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setattr(plugin_runtime, "_plugin_config", {"general": {"client_uid": "injected"}})
    monkeypatch.setattr(plugin_runtime, "_plugin_config_path", None)
    monkeypatch.setattr(plugin_runtime, "_default_plugin_config_paths", ())

    injected_snapshot = plugin_runtime.get_plugin_config_snapshot()

    assert injected_snapshot.source == "injected_snapshot"
    assert injected_snapshot.path is None
    assert injected_snapshot.mtime_ns is None
    assert injected_snapshot.config == {"general": {"client_uid": "injected"}}

    config_path = tmp_path / "plugin-config.json"
    config_path.write_text('{"general":{"client_uid":"file"}}', encoding="utf-8")
    monkeypatch.setattr(plugin_runtime, "_plugin_config_path", str(config_path))

    file_snapshot = plugin_runtime.get_plugin_config_snapshot()

    assert file_snapshot.source == "plugin_config_file"
    assert file_snapshot.path == str(config_path)
    assert file_snapshot.mtime_ns == config_path.stat().st_mtime_ns
    assert file_snapshot.config == {"general": {"client_uid": "file"}}


def test_reconcile_finds_surviving_adapter_by_metadata_after_reload(monkeypatch) -> None:
    adapter = SimpleNamespace(
        platform_id="adapter-1",
        meta=lambda: SimpleNamespace(name=plugin_runtime.ADAPTER_PLATFORM_NAME),
    )
    context = SimpleNamespace(
        platform_manager=SimpleNamespace(platform_insts=[adapter]),
    )
    monkeypatch.setattr(plugin_runtime, "_control_platforms", {})

    assert plugin_runtime.reconcile_control_platforms(context) == [adapter]
    assert plugin_runtime.get_live_control_platform(context, "adapter-1") is adapter
