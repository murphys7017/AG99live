from __future__ import annotations

from astrbot_plugin_ag99live_adapter.runtime.plugin_runtime import get_config_value


def test_get_config_value_uses_mapping_values_and_defaults() -> None:
    config = {"configured": "value", "empty": None}

    assert get_config_value(config, "configured", "default") == "value"
    assert get_config_value(config, "missing", "default") == "default"
    assert get_config_value(config, "empty", "default") == "default"
    assert get_config_value(None, "configured", "default") == "default"
