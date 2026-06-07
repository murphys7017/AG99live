from __future__ import annotations

import importlib
import sys
import types


def _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch) -> None:
    install_fake_astrbot()
    prompt_module = types.ModuleType("astrbot.core.prompt")

    class PromptExtension:
        def __init__(self, **kwargs) -> None:
            self.__dict__.update(kwargs)

    prompt_module.PromptExtension = PromptExtension
    monkeypatch.setitem(sys.modules, "astrbot.core.prompt", prompt_module)

    interaction_module = types.ModuleType("astrbot.core.interaction")

    class InteractionResultContribution:
        def __init__(self, **kwargs) -> None:
            self.__dict__.update(kwargs)

    interaction_module.InteractionResultContribution = InteractionResultContribution
    interaction_module.get_interaction_decision = lambda event: None
    monkeypatch.setitem(sys.modules, "astrbot.core.interaction", interaction_module)


def test_register_ag99live_interaction_contributors_keeps_motion_and_remote(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.middleware")
    module = importlib.reload(module)

    prompt_collectors: list[object] = []
    prompt_contributors: list[object] = []
    result_contributors: list[object] = []
    removed_extension_prefixes: list[str] = []
    removed_prompt_prefixes: list[str] = []
    removed_result_prefixes: list[str] = []

    class ContextStub:
        def remove_prompt_extension_collectors_by_module_prefix(self, prefix: str) -> None:
            removed_extension_prefixes.append(prefix)

        def remove_interaction_prompt_contributors_by_module_prefix(self, prefix: str) -> None:
            removed_prompt_prefixes.append(prefix)

        def remove_interaction_result_contributors_by_module_prefix(self, prefix: str) -> None:
            removed_result_prefixes.append(prefix)

        def register_prompt_extension_collector(self, collector: object) -> None:
            prompt_collectors.append(collector)

        def register_interaction_prompt_contributor(self, contributor: object) -> None:
            prompt_contributors.append(contributor)

        def register_interaction_result_contributor(self, contributor: object) -> None:
            result_contributors.append(contributor)

    module.register_ag99live_interaction_contributors(ContextStub())

    assert "astrbot_plugin_ag99live_adapter.middleware" in removed_extension_prefixes
    assert "data.plugins.astrbot_plugin_ag99live_adapter.middleware" in removed_extension_prefixes
    assert removed_extension_prefixes == removed_prompt_prefixes
    assert removed_extension_prefixes == removed_result_prefixes
    assert [item.plugin_id for item in prompt_collectors] == [
        "ag99live.remote_operator.prompt",
    ]
    assert [item.plugin_id for item in prompt_contributors] == [
        "ag99live.motion.prompt",
        "ag99live.remote_operator.prompt",
    ]
    assert [item.plugin_id for item in result_contributors] == [
        "ag99live.motion.result",
        "ag99live.remote_operator.result",
    ]
