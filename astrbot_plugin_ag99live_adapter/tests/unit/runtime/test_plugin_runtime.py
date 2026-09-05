from __future__ import annotations

from astrbot_plugin_ag99live_adapter.runtime import plugin_runtime
from astrbot_plugin_ag99live_adapter.runtime.plugin_runtime import get_config_value


def test_get_config_value_uses_mapping_values_and_defaults() -> None:
    config = {"configured": "value", "empty": None}

    assert get_config_value(config, "configured", "default") == "value"
    assert get_config_value(config, "missing", "default") == "default"
    assert get_config_value(config, "empty", "default") == "default"
    assert get_config_value(None, "configured", "default") == "default"


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
