from __future__ import annotations

import asyncio
import importlib
import sys
import types
from types import SimpleNamespace


def _install_interaction_stubs(install_fake_astrbot, monkeypatch) -> None:
    install_fake_astrbot()

    interaction_module = types.ModuleType("astrbot.core.interaction")

    class InteractionResultContribution:
        def __init__(self, **kwargs) -> None:
            self.__dict__.update(kwargs)

    class PersonaEffectSpec:
        def __init__(self, **kwargs) -> None:
            self.__dict__.update(kwargs)

    interaction_module.InteractionResultContribution = InteractionResultContribution
    interaction_module.PersonaEffectSpec = PersonaEffectSpec
    interaction_module.get_interaction_route_decision = lambda event: None
    monkeypatch.setitem(sys.modules, "astrbot.core.interaction", interaction_module)

    prompt_module = types.ModuleType("astrbot.core.prompt")

    class PromptExtension:
        def __init__(self, **kwargs) -> None:
            self.__dict__.update(kwargs)

    prompt_module.PromptExtension = PromptExtension
    monkeypatch.setitem(sys.modules, "astrbot.core.prompt", prompt_module)


def test_motion_result_contributor_preserves_speech_cues_without_motion_attempt(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_interaction_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.scheduling"
    )
    module = importlib.reload(module)

    async def no_motion_attempt(event, view):
        return None

    monkeypatch.setattr(module, "_schedule_motion_from_interaction_result", no_motion_attempt)
    monkeypatch.setattr(module, "_resolve_motion_runtime_bundle", lambda event: None)

    class Event:
        def __init__(self) -> None:
            self.extras = {
                "_ag99live_pending_speech_cues": [
                    {"kind": "laugh", "phrase_index": 0, "position": "after"}
                ]
            }

        def get_extra(self, key, default=None):
            return self.extras.get(key, default)

        def set_extra(self, key, value):
            self.extras[key] = value

    event = Event()
    view = SimpleNamespace(
        metadata={"phase": "final"},
        segments=(),
        final_result="",
        core_result="",
        immediate_reply="",
    )

    contribution = asyncio.run(
        module.AG99liveMotionResultContributor().collect(event, None, view)
    )

    assert contribution is not None
    assert contribution.platform_extras == {
        "ag99live_speech_cues": [
            {"kind": "laugh", "phrase_index": 0, "position": "after"}
        ]
    }
    assert event.extras["_ag99live_pending_speech_cues"] is None

