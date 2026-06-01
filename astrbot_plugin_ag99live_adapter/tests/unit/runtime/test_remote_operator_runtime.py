from __future__ import annotations

import asyncio
import json
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
    assert config.default_profile == "simple"
    assert config.profiles["simple"].model == "gpt-5.3-codex"
    assert config.profiles["simple"].effort == "low"
    assert config.profiles["complex"].model == "gpt-5.4-codex"
    assert config.profiles["complex"].effort == "high"


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
            self.calls = []
            pass

        async def execute(self, prompt: str, *, model=None, effort=None) -> str:
            self.calls.append((prompt, model, effort))
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
            RemoteOperatorRequest(computer="work", profile="complex", prompt="打开浏览器")
        )
    )

    assert len(submitted) == 1
    text, metadata = submitted[0]
    assert "[系统级输入：远程执行器结果]" in text
    assert "执行状态：completed" in text
    assert "done: 打开浏览器" in text
    assert metadata["ag99live_input_source"] == "remote_operator_result"
    assert metadata["remote_operator"]["computer"] == "work"
    assert metadata["remote_operator"]["profile"] == "complex"
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
            RemoteOperatorRequest(computer="work", profile="simple", prompt="打开浏览器")
        )
    )

    text, metadata = submitted[0]
    assert "执行状态：failed" in text
    assert metadata["remote_operator"]["status"] == "failed"
    assert metadata["remote_operator"]["error"] == "remote_operator_endpoint_unavailable"


def test_codex_client_accepts_nested_thread_id_and_sends_text_input(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_remote_operator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    from astrbot_plugin_ag99live_adapter.services.remote_operator_runtime import (
        CodexAppServerClient,
    )

    sent_payloads = []

    class WebSocketStub:
        def __init__(self) -> None:
            self.responses = []

        async def send(self, raw: str) -> None:
            payload = json.loads(raw)
            if payload.get("method") == "initialize":
                self.responses.append(
                    {
                        "jsonrpc": "2.0",
                        "id": payload["id"],
                        "result": {},
                    }
                )
            elif payload.get("method") == "thread/start":
                self.responses.append(
                    {
                        "jsonrpc": "2.0",
                        "id": payload["id"],
                        "result": {
                            "thread": {
                                "id": "thr_123",
                            }
                        },
                    }
                )
            elif payload.get("method") == "turn/start":
                self.responses.extend(
                    [
                        {
                            "jsonrpc": "2.0",
                            "id": payload["id"],
                            "result": {},
                        },
                        {
                            "jsonrpc": "2.0",
                            "method": "turn/completed",
                            "params": {
                                "text": "done",
                            },
                        },
                    ]
                )
            sent_payloads.append(payload)

        async def recv(self) -> str:
            return json.dumps(self.responses.pop(0))

    websocket = WebSocketStub()
    client = CodexAppServerClient("ws://127.0.0.1:4500")

    result = asyncio.run(
        client._execute_unbounded_with_websocket(
            websocket,
            "打开浏览器",
            model="gpt-5.3-codex",
            effort="low",
        )
    )

    assert result == "done"
    turn_start = next(payload for payload in sent_payloads if payload.get("method") == "turn/start")
    assert turn_start["params"]["threadId"] == "thr_123"
    assert turn_start["params"]["input"] == [
        {
            "type": "text",
            "text": "打开浏览器",
        }
    ]
    assert turn_start["params"]["model"] == "gpt-5.3-codex"
    assert turn_start["params"]["effort"] == "low"
