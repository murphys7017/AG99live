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
    def __init__(self, platform_name: str = "olv_pet_adapter") -> None:
        self.platform_name = platform_name
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
            "remote_operator_computers": {
                "server": "服务器",
                "work": "工作电脑",
            },
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
            "remote_operator_computers": {
                "server": "服务器",
                "work": "工作电脑",
            },
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
    assert "不要自行因为任务看起来复杂就升档" in extension.value


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
            "remote_operator_computers": {
                "server": "服务器",
                "work": "工作电脑",
            },
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
            "remote_operator_computers": {"work": "工作电脑"},
        },
    )
    module.set_remote_operator_online_computers(["work"])

    contributor = module.AG99liveRemoteOperatorPromptContributor()
    payload = asyncio.run(contributor.collect(EventStub("other_platform"), None, None))

    assert payload is None


def test_parse_remote_operator_request_accepts_two_field_json(
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
            "remote_operator_computers": {"work": "工作电脑"},
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
            "remote_operator_computers": {"work": "工作电脑"},
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
            "remote_operator_computers": {
                "work": "工作电脑",
                "server": "服务器",
            },
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
            "remote_operator_computers": {"work": "工作电脑"},
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
            "remote_operator_computers": {"work": "工作电脑"},
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
            "remote_operator_computers": {"work": "工作电脑"},
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
