from __future__ import annotations

import importlib
import sys


def _reload_remote_operator_modules() -> tuple[object, object]:
    for module_name in (
        "astrbot_plugin_ag99live_adapter.middleware.remote_operator",
        "astrbot_plugin_ag99live_adapter.services.remote_operator_runtime",
    ):
        sys.modules.pop(module_name, None)

    runtime = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.services.remote_operator_runtime"
    )
    middleware = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.remote_operator"
    )
    return runtime, middleware


def test_prompt_config_projects_only_runtime_executable_targets(install_fake_astrbot):
    install_fake_astrbot()
    runtime, middleware = _reload_remote_operator_modules()
    config = {
        "default_computer": "untrusted",
        "default_profile": "complex",
        "computer_entries": [
            {
                "key": "untrusted",
                "label": "未授权电脑",
                "enabled": True,
                "allow_unrestricted_access": False,
                "backend": "codex_app_server",
                "endpoint": "ws://untrusted.example",
            },
            {
                "key": "trusted",
                "label": "受信任电脑",
                "enabled": True,
                "allow_unrestricted_access": True,
                "backend": "opencode",
                "description": "受信任的项目执行器",
            },
            {
                "key": "disabled",
                "label": "已禁用电脑",
                "enabled": False,
                "allow_unrestricted_access": True,
                "backend": "opencode",
            },
        ],
        "profiles": {
            "complex": {
                "label": "深入执行",
                "model": "gpt-5.4-codex",
                "effort": "high",
            }
        },
    }

    endpoint_config = runtime.resolve_remote_operator_endpoint_config(config)
    prompt_config = middleware.resolve_remote_operator_prompt_config(config)

    assert endpoint_config is not None
    assert prompt_config is not None
    assert endpoint_config.computers == {"trusted": "受信任电脑"}
    assert prompt_config.computers == endpoint_config.computers
    assert prompt_config.default_computer == endpoint_config.default_computer == "trusted"
    assert prompt_config.default_profile == endpoint_config.default_profile == "complex"
    assert prompt_config.profiles["complex"] == "深入执行"
    assert prompt_config.target_descriptions == {"trusted": "受信任的项目执行器"}
