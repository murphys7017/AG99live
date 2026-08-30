from __future__ import annotations

import asyncio
import importlib
import sys
import types
from types import SimpleNamespace


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
    interaction_module.get_interaction_route_decision = lambda event: None

    class PersonaEffectSpec:
        def __init__(self, **kwargs) -> None:
            self.__dict__.update(kwargs)

    interaction_module.PersonaEffectSpec = PersonaEffectSpec
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

        def register_persona_effect(self, effect: object, **kwargs) -> None:
            return None

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


def test_motion_effect_schema_limits_axis_names_to_current_profile(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.effects"
    )
    module = importlib.reload(module)
    runtime_state = SimpleNamespace(
        model_info={
            "selected_model": "V4",
            "models": [
                {
                    "name": "V4",
                    "semantic_axis_profile": {
                        "schema_version": "ag99.semantic_axis_profile.v3",
                        "profile_id": "V4.semantic.v1",
                        "model_id": "V4",
                        "revision": 1,
                        "status": "ready",
                        "axes": [
                            {
                                "id": "head_roll",
                                "control_role": "primary",
                                "neutral": 0,
                                "level_anchors": {"-2": -20, "0": 0, "2": 20},
                            },
                            {
                                "id": "brow_bias",
                                "control_role": "hint",
                                "neutral": 0,
                                "level_anchors": {"-1": -10, "0": 0, "1": 10},
                            },
                        ],
                    },
                }
            ],
        }
    )
    monkeypatch.setattr(
        module,
        "_resolve_motion_runtime_bundle",
        lambda event: SimpleNamespace(runtime_state=runtime_state),
    )

    schema = module._build_ag99live_motion_effect_parameters(object())
    axis_levels = schema["properties"]["axis_levels"]

    assert axis_levels["additionalProperties"] is False
    assert set(axis_levels["properties"]) == {"head_roll", "brow_bias"}
    assert axis_levels["properties"]["head_roll"]["enum"] == [-2, 0, 2]
    assert "head_tilt" not in axis_levels["properties"]
    assert "brow_raise" not in axis_levels["properties"]


def test_motion_static_prompt_extensions_target_persona(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.prompt"
    )
    module = importlib.reload(module)

    class PromptExtension:
        def __init__(self, **kwargs) -> None:
            self.__dict__.update(kwargs)

    monkeypatch.setattr(
        module,
        "get_interaction_capabilities",
        lambda: types.SimpleNamespace(prompt_extension=PromptExtension),
    )
    monkeypatch.setattr(
        module,
        "_resolve_motion_runtime_bundle",
        lambda event: types.SimpleNamespace(
            runtime_state=object(),
            turn_coordinator=object(),
        ),
    )
    monkeypatch.setattr(module, "_should_contribute_motion_prompt", lambda view: True)
    monkeypatch.setattr(
        module,
        "_build_motion_static_capability_payload",
        lambda runtime_state: {"semantic_profile": {}},
    )
    monkeypatch.setattr(
        module,
        "_build_motion_runtime_payload",
        lambda *args, **kwargs: ({}, []),
    )
    monkeypatch.setattr(
        module,
        "_record_motion_prompt_reference_observation",
        lambda **kwargs: None,
    )

    extensions = asyncio.run(
        module.AG99liveMotionPromptContributor().collect(object(), object(), object())
    )

    assert [extension.mount for extension in extensions] == ["system", "system"]
    assert all(
        extension.meta["targets"] == ["persona", "core"]
        for extension in extensions
    )


def test_enhanced_interaction_requires_dynamic_effect_schema_support(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    interaction_module = sys.modules["astrbot.core.interaction"]

    class LegacyPersonaEffectSpec:
        def __init__(self, plugin_id, name, description, parameters) -> None:
            self.plugin_id = plugin_id
            self.name = name
            self.description = description
            self.parameters = parameters

    interaction_module.PersonaEffectSpec = LegacyPersonaEffectSpec
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.core_compatibility")
    module = importlib.reload(module)

    assert module.get_interaction_capabilities() is None
