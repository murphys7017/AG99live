from __future__ import annotations

import asyncio
import importlib
import sys
import types


def _install_prompt_stub(install_fake_astrbot, monkeypatch) -> None:
    install_fake_astrbot()

    prompt_module = types.ModuleType("astrbot.core.prompt")
    interaction_module = types.ModuleType("astrbot.core.interaction")

    class PromptExtension:
        def __init__(
            self,
            *,
            plugin_id: str,
            mount: str,
            title: str | None = None,
            value=None,
            value_kind: str = "mapping",
            order: int = 100,
            meta: dict | None = None,
        ) -> None:
            self.plugin_id = plugin_id
            self.mount = mount
            self.title = title
            self.value = value
            self.value_kind = value_kind
            self.order = order
            self.meta = meta or {}

    prompt_module.PromptExtension = PromptExtension

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

    interaction_module.InteractionResultContribution = InteractionResultContribution
    monkeypatch.setitem(sys.modules, "astrbot.core.prompt", prompt_module)
    monkeypatch.setitem(sys.modules, "astrbot.core.interaction", interaction_module)


def _load_module():
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.remote_operator"
    )
    return importlib.reload(module)


class EventStub:
    def __init__(
        self,
        platform_name: str = "olv_pet_adapter",
        message_str: str = "",
    ) -> None:
        self.platform_name = platform_name
        self.message_str = message_str
        self.extras: dict[str, object] = {}

    def get_platform_name(self) -> str:
        return self.platform_name

    def get_platform_id(self) -> str:
        return self.platform_name

    def get_extra(self, key):
        return self.extras.get(key)

    def set_extra(self, key, value):
        self.extras[key] = value


def test_prompt_contributor_skips_when_no_online_computer(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "server", "label": "服务器", "endpoint": "ws://127.0.0.1:4501"},
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers([])

    contributor = module.AG99liveRemoteOperatorPromptContributor()
    payload = asyncio.run(contributor.collect(EventStub(), None, None))

    assert payload is None


def test_prompt_contributor_injects_only_online_computer_keys(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "server",
            "remote_operator_computer_entries": [
                {"key": "server", "label": "服务器", "endpoint": "ws://127.0.0.1:4501"},
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["work", "unknown"])

    contributor = module.AG99liveRemoteOperatorPromptContributor()
    extension = asyncio.run(contributor.collect(EventStub(), None, None))

    assert extension is not None
    assert extension.plugin_id == "ag99live.remote_operator.prompt"
    assert extension.mount == "system"
    assert extension.value_kind == "text"
    assert "工作电脑 -> work（默认）" in extension.value
    assert "服务器 -> server" not in extension.value
    assert '"computer":"<computer_key>"' in extension.value
    assert '"profile":"simple|complex"' in extension.value
    assert '"prompt":"<交给远程执行器的完整任务说明>"' in extension.value
    assert "绝不能选择 self_reply" in extension.value
    assert "core_task_spec.execution_prompt" in extension.value
    assert "不能调用 astrbot_execute_shell" in extension.value
    assert "不要自行因为任务看起来复杂就升档" in extension.value


def test_prompt_contributor_reads_computer_entries(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {
                    "key": "work",
                    "label": "工作电脑",
                    "endpoint": "ws://127.0.0.1:4500",
                }
            ],
        },
    )
    module.set_remote_operator_online_computers(["work"])

    contributor = module.AG99liveRemoteOperatorPromptContributor()
    extension = asyncio.run(contributor.collect(EventStub(), None, None))

    assert extension is not None
    assert "工作电脑 -> work（默认）" in extension.value


def test_prompt_contributor_uses_configured_default_when_online(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "server", "label": "服务器", "endpoint": "ws://127.0.0.1:4501"},
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["server", "work"])

    contributor = module.AG99liveRemoteOperatorPromptContributor()
    extension = asyncio.run(contributor.collect(EventStub(), None, None))

    assert extension is not None
    assert "工作电脑 -> work（默认）" in extension.value
    assert "服务器 -> server" in extension.value


def test_prompt_contributor_skips_non_ag99live_events(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["work"])

    contributor = module.AG99liveRemoteOperatorPromptContributor()
    payload = asyncio.run(contributor.collect(EventStub("other_platform"), None, None))

    assert payload is None


def test_parse_remote_operator_request_accepts_remote_operator_json(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["work"])
    view = types.SimpleNamespace(
        final_result='{"computer":"work","profile":"simple","prompt":"打开浏览器并搜索天气"}',
        core_result=None,
    )

    request, reason = module.parse_remote_operator_request_from_view(
        EventStub(),
        view,
    )

    assert reason == "ok"
    assert request.computer == "work"
    assert request.profile == "simple"
    assert request.prompt == "打开浏览器并搜索天气"


def test_parse_remote_operator_request_rejects_extra_field(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["work"])
    view = types.SimpleNamespace(
        final_result='{"computer":"work","profile":"simple","prompt":"do it","steps":[]}',
        core_result=None,
    )

    request, reason = module.parse_remote_operator_request_from_view(
        EventStub(),
        view,
    )

    assert request is None
    assert reason == "payload_keys_invalid"


def test_parse_remote_operator_request_rejects_unavailable_computer(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
                {"key": "server", "label": "服务器", "endpoint": "ws://127.0.0.1:4501"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["work"])
    view = types.SimpleNamespace(
        final_result='{"computer":"server","profile":"simple","prompt":"检查服务"}',
        core_result=None,
    )

    request, reason = module.parse_remote_operator_request_from_view(
        EventStub(),
        view,
    )

    assert request is None
    assert reason == "computer_unavailable"


def test_parse_remote_operator_request_rejects_unknown_profile(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["work"])
    view = types.SimpleNamespace(
        final_result='{"computer":"work","profile":"ultra","prompt":"检查服务"}',
        core_result=None,
    )

    request, reason = module.parse_remote_operator_request_from_view(
        EventStub(),
        view,
    )

    assert request is None
    assert reason == "profile_empty"


def test_prompt_contributor_skips_remote_operator_result_event(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["work"])

    class ResultEventStub(EventStub):
        def get_extra(self, key):
            if key == "ag99live_input_source":
                return "remote_operator_result"
            return None

    contributor = module.AG99liveRemoteOperatorPromptContributor()
    payload = asyncio.run(contributor.collect(ResultEventStub(), None, None))

    assert payload is None


def test_result_contributor_schedules_remote_operator_task(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["work"])

    scheduled = []

    class RuntimeStub:
        async def execute_and_submit(self, request):
            scheduled.append(request)

    class AdapterStub:
        remote_operator_runtime = RuntimeStub()

        def spawn_background_task(self, coroutine):
            scheduled.append(coroutine)
            coroutine.close()

    class EventWithAdapter(EventStub):
        adapter = AdapterStub()

    view = types.SimpleNamespace(
        final_result='{"computer":"work","profile":"complex","prompt":"打开记事本"}',
        core_result=None,
    )
    contributor = module.AG99liveRemoteOperatorResultContributor()

    contribution = asyncio.run(contributor.collect(EventWithAdapter(), None, view))

    assert contribution is not None
    assert contribution.metadata["ag99live_remote_operator"]["scheduled"] is True
    assert contribution.metadata["ag99live_remote_operator"]["computer"] == "work"
    assert contribution.metadata["ag99live_remote_operator"]["profile"] == "complex"
    assert scheduled


def test_result_contributor_skips_after_request_scheduled(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    event = EventStub()
    event.set_extra("ag99live_remote_operator_scheduled", True)
    view = types.SimpleNamespace(
        final_result='{"computer":"work","profile":"simple","prompt":"打开记事本"}',
        core_result=None,
    )
    contributor = module.AG99liveRemoteOperatorResultContributor()

    contribution = asyncio.run(contributor.collect(event, None, view))

    assert contribution is None


def test_register_remote_operator_contributors_registers_main_prompt_collector(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()

    prompt_collectors = []
    prompt_contributors = []
    result_contributors = []
    removed_prefixes = []

    class ContextStub:
        def remove_prompt_extension_collectors_by_module_prefix(self, prefix):
            removed_prefixes.append(prefix)

        def register_prompt_extension_collector(self, collector):
            prompt_collectors.append(collector)

        def register_interaction_prompt_contributor(self, contributor):
            prompt_contributors.append(contributor)

        def register_interaction_result_contributor(self, contributor):
            result_contributors.append(contributor)

    module.register_remote_operator_interaction_contributors(ContextStub())

    assert removed_prefixes == ["astrbot_plugin_ag99live_adapter.middleware"]
    assert len(prompt_collectors) == 1
    assert len(prompt_contributors) == 1
    assert len(result_contributors) == 1


def test_main_prompt_collector_accepts_astrbot_collector_signature(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["work"])

    collector = module.AG99liveRemoteOperatorPromptExtensionCollector()
    extensions = asyncio.run(
        collector.collect(
            EventStub(),
            plugin_context=None,
            config=object(),
            provider_request=object(),
        )
    )

    assert len(extensions) == 1
    extension = extensions[0]
    assert extension is not None
    assert extension.plugin_id == "ag99live.remote_operator.prompt"
    assert "工作电脑 -> work（默认）" in extension.value


def test_tool_arbitration_removes_conflicting_tools_for_desktop_action(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["work"])

    class Tool:
        def __init__(self, name):
            self.name = name

    class ToolSet:
        def __init__(self):
            self.tools = [
                Tool("astrbot_execute_shell"),
                Tool("astrbot_file_read_tool"),
                Tool("ordinary_tool"),
            ]

        def get_tool(self, name):
            return next((tool for tool in self.tools if tool.name == name), None)

        def remove_tool(self, name):
            self.tools = [tool for tool in self.tools if tool.name != name]

    request = types.SimpleNamespace(
        prompt="帮我打开钉钉",
        func_tool=ToolSet(),
        system_prompt="existing prompt",
    )

    event = EventStub()
    removed = module.arbitrate_remote_operator_tools_for_request(event, request)

    assert removed == ["astrbot_execute_shell", "astrbot_file_read_tool"]
    assert [tool.name for tool in request.func_tool.tools] == ["ordinary_tool"]
    assert "existing prompt" in request.system_prompt
    assert "<ag99live_remote_operator_core_override>" in request.system_prompt
    assert "不得声称调用 astrbot_execute_shell" in request.system_prompt
    assert "不得把历史结果当成本轮执行结果复述" in request.system_prompt
    assert "输出必须从 `{` 开始并以 `}` 结束" in request.system_prompt
    assert '"computer":"work"' in request.system_prompt
    assert '"profile":"simple"' in request.system_prompt
    assert event.extras["ag99live_remote_operator_core_override"] == {
        "computer": "work",
        "profile": "simple",
        "reason": "desktop_action_remote_operator_priority",
    }


def test_tool_arbitration_appends_override_even_without_tools(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["work"])
    event = EventStub()
    request = types.SimpleNamespace(
        prompt="帮我关闭Edge",
        func_tool=types.SimpleNamespace(tools=[]),
        system_prompt="existing prompt",
    )

    removed = module.arbitrate_remote_operator_tools_for_request(event, request)

    assert removed == []
    assert "existing prompt" in request.system_prompt
    assert "<ag99live_remote_operator_core_override>" in request.system_prompt
    assert '"computer":"work"' in request.system_prompt
    assert event.extras["ag99live_remote_operator_core_override"]["computer"] == "work"


def test_tool_arbitration_skips_when_remote_operator_offline(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers([])
    tool = types.SimpleNamespace(name="astrbot_execute_shell")
    request = types.SimpleNamespace(
        prompt="帮我打开钉钉",
        func_tool=types.SimpleNamespace(tools=[tool]),
        system_prompt="existing prompt",
    )

    removed = module.arbitrate_remote_operator_tools_for_request(EventStub(), request)

    assert removed == []
    assert request.func_tool.tools == [tool]
    assert request.system_prompt == "existing prompt"


def test_tool_arbitration_skips_non_ag99live_event(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["work"])
    tool = types.SimpleNamespace(name="astrbot_execute_shell")
    request = types.SimpleNamespace(
        prompt="帮我打开钉钉",
        func_tool=types.SimpleNamespace(tools=[tool]),
        system_prompt="existing prompt",
    )

    removed = module.arbitrate_remote_operator_tools_for_request(
        EventStub("other_platform"),
        request,
    )

    assert removed == []
    assert request.func_tool.tools == [tool]
    assert request.system_prompt == "existing prompt"


def test_tool_arbitration_skips_non_desktop_action_text(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_prompt_stub(install_fake_astrbot, monkeypatch)
    module = _load_module()
    monkeypatch.setattr(
        module,
        "_load_plugin_config",
        lambda: {
            "remote_operator_default_computer": "work",
            "remote_operator_computer_entries": [
                {"key": "work", "label": "工作电脑", "endpoint": "ws://127.0.0.1:4500"},
            ],
        },
    )
    module.set_remote_operator_online_computers(["work"])
    tool = types.SimpleNamespace(name="astrbot_execute_shell")
    request = types.SimpleNamespace(
        prompt="今天天气怎么样",
        func_tool=types.SimpleNamespace(tools=[tool]),
        system_prompt="existing prompt",
    )

    removed = module.arbitrate_remote_operator_tools_for_request(EventStub(), request)

    assert removed == []
    assert request.func_tool.tools == [tool]
    assert request.system_prompt == "existing prompt"
