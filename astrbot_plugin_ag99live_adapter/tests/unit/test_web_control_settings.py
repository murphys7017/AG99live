from __future__ import annotations

import pytest

from astrbot_plugin_ag99live_adapter.runtime.plugin_runtime import (
    DEFAULT_PRE_ACTION_PROVIDER_ID,
)
from astrbot_plugin_ag99live_adapter.web_control import (
    ConfigValidationError,
    default_settings,
    normalize_settings_patch,
)


def test_pre_action_provider_is_exposed_with_lightweight_default() -> None:
    settings = default_settings()
    assert settings["pre_action"]["provider_id"] == DEFAULT_PRE_ACTION_PROVIDER_ID


def test_pre_action_provider_is_normalized_and_validated_as_provider() -> None:
    settings = normalize_settings_patch(
        {"pre_action": {"enabled": True, "provider_id": " ollama/qwen3:1.7b "}}
    )
    assert settings["pre_action"]["provider_id"] == "ollama/qwen3:1.7b"


def test_unknown_pre_action_provider_is_rejected(monkeypatch) -> None:
    import astrbot_plugin_ag99live_adapter.web_control as web_control

    monkeypatch.setattr(
        web_control,
        "_list_chat_providers",
        lambda: [{"id": "ollama/qwen3:1.7b", "name": "Qwen3 1.7B"}],
    )
    with pytest.raises(ConfigValidationError) as exc_info:
        normalize_settings_patch(
            {"pre_action": {"provider_id": "missing/provider"}}
        )
    assert exc_info.value.code == "settings_provider_unknown"
    assert exc_info.value.field == "pre_action.provider_id"
