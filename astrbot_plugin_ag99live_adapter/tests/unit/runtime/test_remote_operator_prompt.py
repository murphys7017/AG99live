from __future__ import annotations

import asyncio
import importlib
import sys
import types


def _install_prompt_stub(install_fake_astrbot, monkeypatch) -> None:
    install_fake_astrbot()

    prompt_module = types.ModuleType("astrbot.core.prompt")

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
    monkeypatch.setitem(sys.modules, "astrbot.core.prompt", prompt_module)


def _load_module():
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.remote_operator"
    )
    return importlib.reload(module)


class EventStub:
    def __init__(self, platform_name: str = "olv_pet_adapter") -> None:
        self.platform_name = platform_name

    def get_platform_name(self) -> str:
        return self.platform_name

    def get_platform_id(self) -> str:
        return self.platform_name


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
    assert '"prompt":"<交给远程执行器的完整任务说明>"' in extension.value


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
