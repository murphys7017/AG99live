from __future__ import annotations

import asyncio
import sys
import types


def _install_remote_operator_astrbot_stubs(install_fake_astrbot, monkeypatch) -> None:
    install_fake_astrbot()
    interaction_module = types.ModuleType("astrbot.core.interaction")
    prompt_module = types.ModuleType("astrbot.core.prompt")

    class InteractionResultContribution:
        def __init__(
            self,
            *,
            plugin_id,
            platform_extras=None,
            client_objects=None,
            final_text_override=None,
            metadata=None,
            priority=100,
        ) -> None:
            self.plugin_id = plugin_id
            self.platform_extras = platform_extras or {}
            self.client_objects = client_objects or []
            self.final_text_override = final_text_override
            self.metadata = metadata or {}
            self.priority = priority

    class PromptExtension:
        pass

    interaction_module.InteractionResultContribution = InteractionResultContribution
    prompt_module.PromptExtension = PromptExtension
    monkeypatch.setitem(sys.modules, "astrbot.core.interaction", interaction_module)
    monkeypatch.setitem(sys.modules, "astrbot.core.prompt", prompt_module)


def test_resolve_endpoint_config_requires_matching_endpoint(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_remote_operator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    from astrbot_plugin_ag99live_adapter.services.remote_operator_runtime import (
        resolve_remote_operator_endpoint_config,
    )

    config = resolve_remote_operator_endpoint_config(
        {
            "remote_operator_default_computer": "server",
            "remote_operator_computers": {
                "server": "服务器",
                "work": "工作电脑",
            },
            "remote_operator_endpoints": {
                "work": "ws://127.0.0.1:4500",
            },
        }
    )

    assert config is not None
    assert config.default_computer == "work"
    assert config.computers == {"work": "工作电脑"}
    assert config.endpoints == {"work": "ws://127.0.0.1:4500"}


def test_runtime_refresh_online_once_filters_probe_failures(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_remote_operator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    from astrbot_plugin_ag99live_adapter.middleware import remote_operator
    from astrbot_plugin_ag99live_adapter.services.remote_operator_runtime import (
        RemoteOperatorRuntime,
    )

    class ClientStub:
        def __init__(self, endpoint: str) -> None:
            self.endpoint = endpoint

        async def probe(self) -> bool:
            return self.endpoint.endswith("4500")

    runtime = RemoteOperatorRuntime(
        plugin_config_loader=lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computers": {
                "work": "工作电脑",
                "server": "服务器",
            },
            "remote_operator_endpoints": {
                "work": "ws://127.0.0.1:4500",
                "server": "ws://127.0.0.1:4501",
            },
        },
        submit_system_text_input=lambda _text, _metadata: None,
        client_factory=ClientStub,
    )

    online = asyncio.run(runtime.refresh_online_once())

    assert online == {"work"}
    assert remote_operator.get_remote_operator_online_computers() == {"work"}


def test_runtime_execute_and_submit_success_metadata(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_remote_operator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    from astrbot_plugin_ag99live_adapter.services.remote_operator_runtime import (
        RemoteOperatorRequest,
        RemoteOperatorRuntime,
    )

    submitted = []

    class ClientStub:
        def __init__(self, _endpoint: str) -> None:
            pass

        async def execute(self, prompt: str) -> str:
            return f"done: {prompt}"

    async def submit(text, metadata):
        submitted.append((text, metadata))

    runtime = RemoteOperatorRuntime(
        plugin_config_loader=lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computers": {"work": "工作电脑"},
            "remote_operator_endpoints": {"work": "ws://127.0.0.1:4500"},
        },
        submit_system_text_input=submit,
        client_factory=ClientStub,
    )

    asyncio.run(
        runtime.execute_and_submit(
            RemoteOperatorRequest(computer="work", prompt="打开浏览器")
        )
    )

    assert len(submitted) == 1
    text, metadata = submitted[0]
    assert "[系统级输入：远程执行器结果]" in text
    assert "执行状态：completed" in text
    assert "done: 打开浏览器" in text
    assert metadata["ag99live_input_source"] == "remote_operator_result"
    assert metadata["remote_operator"]["computer"] == "work"
    assert metadata["remote_operator"]["status"] == "completed"


def test_runtime_execute_and_submit_failure_metadata(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_remote_operator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    from astrbot_plugin_ag99live_adapter.services.remote_operator_runtime import (
        RemoteOperatorRequest,
        RemoteOperatorRuntime,
    )

    submitted = []

    async def submit(text, metadata):
        submitted.append((text, metadata))

    runtime = RemoteOperatorRuntime(
        plugin_config_loader=lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computers": {"work": "工作电脑"},
            "remote_operator_endpoints": {},
        },
        submit_system_text_input=submit,
    )

    asyncio.run(
        runtime.execute_and_submit(
            RemoteOperatorRequest(computer="work", prompt="打开浏览器")
        )
    )

    text, metadata = submitted[0]
    assert "执行状态：failed" in text
    assert metadata["remote_operator"]["status"] == "failed"
    assert metadata["remote_operator"]["error"] == "remote_operator_endpoint_unavailable"
