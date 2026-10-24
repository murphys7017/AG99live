from __future__ import annotations

import asyncio
import importlib
import json
import sys
import types
from types import SimpleNamespace

import pytest


def _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch) -> None:
    install_fake_astrbot()
    event_module = types.ModuleType("astrbot.api.event")

    class _Filter:
        @staticmethod
        def on_llm_response():
            def decorator(fn):
                return fn

            return decorator

    event_module.filter = _Filter()
    monkeypatch.setitem(sys.modules, "astrbot.api.event", event_module)

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


def test_register_ag99live_interaction_contributors_tracks_persona_effect_mode(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.middleware")
    module = importlib.reload(module)

    prompt_collectors: list[object] = []
    result_contributors: list[object] = []
    result_event_filters: list[object] = []
    persona_effects: list[object] = []
    removed_extension_prefixes: list[str] = []
    removed_result_prefixes: list[str] = []

    class ContextStub:
        def remove_prompt_extension_collectors_by_module_prefix(self, prefix: str) -> None:
            removed_extension_prefixes.append(prefix)
            prompt_collectors[:] = [
                item
                for item in prompt_collectors
                if not type(item).__module__.startswith(prefix)
            ]

        def remove_interaction_result_contributors_by_module_prefix(self, prefix: str) -> None:
            removed_result_prefixes.append(prefix)
            result_contributors[:] = [
                item
                for item in result_contributors
                if not type(item).__module__.startswith(prefix)
            ]

        def unregister_persona_effects(self, *, plugin_id: str | None = None) -> None:
            persona_effects[:] = [
                item
                for item in persona_effects
                if getattr(item, "plugin_id", None) != plugin_id
            ]

        def register_prompt_extension_collector(self, collector: object) -> None:
            prompt_collectors.append(collector)

        def register_interaction_result_contributor(
            self,
            contributor: object,
            *,
            event_filter=None,
        ) -> None:
            result_contributors.append(contributor)
            result_event_filters.append(event_filter)

        def register_persona_effect(self, effect: object, **kwargs) -> None:
            del kwargs
            persona_effects.append(effect)

    context = ContextStub()
    module.register_ag99live_interaction_contributors(context)
    module.register_ag99live_interaction_contributors(context)

    assert "astrbot_plugin_ag99live_adapter.middleware" in removed_extension_prefixes
    assert "data.plugins.astrbot_plugin_ag99live_adapter.middleware" in removed_extension_prefixes
    assert removed_extension_prefixes == removed_result_prefixes
    assert [item.plugin_id for item in prompt_collectors] == [
        "ag99live.companion_identity.prompt",
        "ag99live.motion.prompt",
    ]
    assert [item.plugin_id for item in result_contributors] == [
        "ag99live.motion.result",
    ]
    assert len(prompt_collectors) == 2
    assert len(result_contributors) == 1
    assert callable(result_event_filters[0])
    stream_event = SimpleNamespace(
        get_extra=lambda key, default=None: (
            True if key == "_interaction_persona_segment_stream_active" else default
        )
    )
    request_only_event = SimpleNamespace(
        get_extra=lambda key, default=None: (
            True if key == "_interaction_persona_segment_stream_requested" else default
        )
    )
    ordinary_event = SimpleNamespace(get_extra=lambda _key, default=None: default)
    assert result_event_filters[0](stream_event) is False
    assert result_event_filters[0](request_only_event) is True
    assert result_event_filters[0](ordinary_event) is True
    assert len(persona_effects) == 1
    assert not module.set_ag99live_motion_persona_effect_enabled(
        context,
        enabled=False,
    )
    assert persona_effects == []

    assert module.set_ag99live_motion_persona_effect_enabled(
        context,
        enabled=True,
    )
    assert len(persona_effects) == 1


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
    assert all(extension.meta["targets"] == ["persona"] for extension in extensions)


def test_companion_identity_prompt_targets_persona(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.companion"
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
    monkeypatch.setattr(module, "_resolve_motion_runtime_bundle", lambda event: object())

    extensions = asyncio.run(
        module.AG99liveCompanionIdentityPromptContributor().collect(
            object(), object(), object()
        )
    )

    assert len(extensions) == 1
    extension = extensions[0]
    assert extension.plugin_id == "ag99live.companion_identity.prompt"
    assert extension.mount == "system"
    assert extension.meta["targets"] == ["persona"]
    assert "个人伙伴" in extension.value
    assert "AstrBot 在桌面上的身体" not in extension.value
    assert "虚拟主播" in extension.value


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


def test_enhanced_interaction_contributors_do_not_require_llm_response_hook(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    event_module = sys.modules["astrbot.api.event"]
    event_module.filter.on_llm_response = None
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.core_compatibility")
    module = importlib.reload(module)

    context = types.SimpleNamespace(
        register_persona_effect=lambda *_args, **_kwargs: None,
        register_prompt_extension_collector=lambda *_args, **_kwargs: None,
        register_interaction_result_contributor=lambda *_args, **_kwargs: None,
        remove_prompt_extension_collectors_by_module_prefix=lambda *_args: None,
        remove_interaction_result_contributors_by_module_prefix=lambda *_args: None,
        unregister_persona_effects=lambda *_args, **_kwargs: None,
    )

    assert module.supports_interaction_contributors(context)


def test_interaction_contributor_and_stream_filter_support_are_separate(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.core_compatibility")
    module = importlib.reload(module)
    context = types.SimpleNamespace(
        register_persona_effect=lambda *_args, **_kwargs: None,
        register_prompt_extension_collector=lambda *_args, **_kwargs: None,
        register_interaction_result_contributor=lambda _contributor: None,
        remove_prompt_extension_collectors_by_module_prefix=lambda *_args: None,
        remove_interaction_result_contributors_by_module_prefix=lambda *_args: None,
        unregister_persona_effects=lambda *_args, **_kwargs: None,
    )

    assert module.supports_interaction_contributors(context)
    assert not module.supports_interaction_result_event_filter(context)
    context.register_interaction_result_contributor = lambda *_args, **_kwargs: None
    assert module.supports_interaction_contributors(context)
    assert module.supports_interaction_result_event_filter(context)

    def positional_only(_contributor, event_filter, /):
        del event_filter

    def positional_only_with_kwargs(_contributor, event_filter, /, **kwargs):
        del event_filter, kwargs

    context.register_interaction_result_contributor = positional_only
    assert not module.supports_interaction_result_event_filter(context)
    context.register_interaction_result_contributor = positional_only_with_kwargs
    assert module.supports_interaction_result_event_filter(context)


def test_interaction_registration_keeps_legacy_core_contributor_api(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.middleware")
    module = importlib.reload(module)
    result_contributors: list[object] = []

    class LegacyContext:
        def register_persona_effect(self, effect: object, **_kwargs) -> None:
            del effect

        def register_prompt_extension_collector(self, _collector: object) -> None:
            pass

        def register_interaction_result_contributor(self, contributor: object) -> None:
            result_contributors.append(contributor)

        def remove_prompt_extension_collectors_by_module_prefix(self, _prefix: str) -> None:
            pass

        def remove_interaction_result_contributors_by_module_prefix(
            self,
            _prefix: str,
        ) -> None:
            pass

        def unregister_persona_effects(self, **_kwargs) -> None:
            pass

    assert module.register_ag99live_interaction_contributors(LegacyContext())
    assert [item.plugin_id for item in result_contributors] == [
        "ag99live.motion.result",
    ]


@pytest.mark.parametrize("first_binding_present", [True, False])
def test_incremental_motion_finalizer_only_waits_for_requested_segment(
    install_fake_astrbot, monkeypatch, first_binding_present,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.reload(importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.scheduling"
    ))
    independent = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    from astrbot_plugin_ag99live_adapter.runtime.persona_lifecycle import (
        PersonaTtsBinding,
        PersonaTurnSessionRegistry,
    )

    state = SimpleNamespace(persona_sessions=PersonaTurnSessionRegistry())
    event_extras = {
        "_turn_id": "core-turn",
    }
    event = SimpleNamespace(
        get_platform_id=lambda: "olv_pet_adapter",
        get_platform_name=lambda: "olv_pet_adapter",
        get_extra=lambda key, default=None: event_extras.get(key, default),
        set_extra=lambda key, value: event_extras.__setitem__(key, value),
        adapter=SimpleNamespace(
            runtime_state=state,
            turn_coordinator=SimpleNamespace(
                runtime_state=state,
                output_segments=SimpleNamespace(
                    deferred_motion=SimpleNamespace(register=lambda *_args, **_kwargs: None)
                ),
            ),
        ),
        message_obj=SimpleNamespace(raw_message={"turn_id": "frontend-turn"}),
    )

    async def run():
        loop = asyncio.get_running_loop()
        futures = {index: loop.create_future() for index in range(2)}
        first = independent.IndependentMotionResult("first", {"intent_tags": ["first"]}, "ok", 0)
        second = independent.IndependentMotionResult("second", None, "motion_timeout", 0)
        futures[0].set_result(first)

        async def all_results():
            return {0: first, 1: await futures[1]}

        task = asyncio.create_task(all_results())
        work = state.persona_sessions.session("core-turn").result(
            "persona",
            phase="immediate",
            parent_message_id="parent",
        )
        work.expected_segment_count = 2
        work.generation_task = task
        for index, speech in enumerate(("first", "second")):
            segment_state = work.segment(index)
            segment_state.bind_content(speech=speech, actions=(), tendency={})
            segment_state.result_future = futures[index]
        if first_binding_present:
            work.segments[0].tts_binding = PersonaTtsBinding(
                turn_id="core-turn",
                parent_message_id="parent",
                persona_result_id="persona",
                segment_index=0,
                segment_count=2,
                message_id="message-0",
                tts_request_id="tts-0",
            )
        contributor = module.AG99liveMotionResultContributor()
        first_output = await asyncio.wait_for(
            contributor.finalize_output(
                event,
                object(),
                turn_id="core-turn",
                phase="immediate",
                parent_message_id="parent",
                persona_result_id="persona",
                materialization={
                    "persona_segment_index": 0,
                    "persona_last_output_segment": False,
                },
            ),
            timeout=0.2,
        )
        if first_binding_present:
            assert first_output.client_objects[0]["persona_segment_index"] == 0
        else:
            assert first_output.client_objects == []
            assert first_output.metadata["ag99live_motion_schedule"][
                "persona_motion_failure_reasons"
            ] == {"0": "tts_binding_missing"}
        assert not task.done()
        assert state.persona_sessions.get_result("core-turn", "persona") is work
        futures[1].set_result(second)
        second_output = await contributor.finalize_output(
            event,
            object(),
            turn_id="core-turn",
            phase="immediate",
            parent_message_id="parent",
            persona_result_id="persona",
            materialization={
                "persona_segment_index": 1,
                "persona_last_output_segment": True,
            },
        )
        assert second_output.client_objects == []
        assert second_output.metadata["ag99live_motion_schedule"][
            "persona_motion_failure_reasons"
        ] == {"1": "motion_timeout"}
        assert state.persona_sessions.get_result("core-turn", "persona") is None
        await task

    asyncio.run(run())


def test_independent_motion_segment_results_preserve_speech_indexes(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    module = importlib.reload(module)
    calls: list[str] = []
    selected_provider = object()

    async def generate(_event, _bundle, *, provider, assistant_text, segment_intent=None):
        assert provider is selected_provider
        calls.append(assistant_text)
        return module.IndependentMotionResult(
            assistant_text=assistant_text,
            motion_payload={
                "schema_version": "ag99.motion_intent.v4",
                "intent_tags": [assistant_text],
            },
            reason="ok",
            image_count=0,
        )

    monkeypatch.setattr(module, "generate_independent_motion", generate)
    bundle = SimpleNamespace(
        runtime_state=SimpleNamespace(
            selected_independent_motion_provider=selected_provider,
        )
    )

    async def run_generation():
        return await module.generate_independent_motion_for_segments(
            object(),
            bundle,
            speech_segments=("", "first", "  ", "third"),
            parallel=True,
            tasks=set(),
        )

    results = asyncio.run(run_generation())

    assert calls == ["first", "third"]
    assert set(results) == {1, 3}
    assert results[1].assistant_text == "first"
    assert results[3].assistant_text == "third"


@pytest.mark.parametrize(
    ("matched_snapshot", "expected_step"),
    [
        (
            {
                "step": 7,
                "emotion": {"joy": 0.7},
                "behavior": {"engagement": 0.5},
                "last_tendency": {"Joy": 8},
            },
            7,
        ),
        (None, None),
    ],
)
def test_segment_motion_reads_current_neurobrain_state(
    install_fake_astrbot,
    monkeypatch,
    matched_snapshot,
    expected_step,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    module = importlib.reload(module)
    prompts: list[dict[str, object]] = []

    class ReadOnlyAPI:
        def get_state(self):
            return matched_snapshot

    class PluginContext:
        def get_registered_star(self, plugin_id):
            assert plugin_id == "astrbot_plugin_neurobrain"
            return SimpleNamespace(
                star_cls=SimpleNamespace(
                    enabled=True,
                    readonly_api=ReadOnlyAPI(),
                )
            )

    class Provider:
        async def text_chat_stream(self, *, prompt, **_kwargs):
            prompts.append(json.loads(prompt))
            yield SimpleNamespace(
                role="assistant",
                completion_text="",
                is_chunk=True,
            )

    monkeypatch.setattr(
        module,
        "_build_motion_static_capability_payload",
        lambda _state: {},
    )
    monkeypatch.setattr(
        module,
        "_build_motion_runtime_payload",
        lambda *_args, **_kwargs: ({}, []),
    )
    monkeypatch.setattr(
        module,
        "_record_motion_prompt_reference_observation",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        module,
        "_build_motion_capability_prompt_payload",
        lambda _payload: {},
    )

    bundle = SimpleNamespace(
        runtime_state=SimpleNamespace(
            plugin_context=PluginContext(),
            selected_independent_motion_provider=Provider(),
            independent_motion_history_turns=0,
            independent_motion_segment_timeout_seconds=1,
            independent_motion_max_concurrency=2,
        ),
        turn_coordinator=object(),
    )
    event = SimpleNamespace(
        message_str="hello",
        get_extra=lambda key, default=None: (
            "turn-1" if key == "_turn_id" else default
        ),
    )

    async def run_generation():
        return await module.generate_independent_motion_for_segments(
            event,
            bundle,
            speech_segments=("first", "second"),
            parallel=True,
            tasks=set(),
            persona_result_id="result-1",
        )

    asyncio.run(run_generation())

    assert len(prompts) == 2
    for prompt in prompts:
        if expected_step is None:
            assert "neurobrain_state" not in prompt
        else:
            assert prompt["neurobrain_state"]["step"] == expected_step


def test_persona_hook_cancellation_reaches_segment_provider_requests(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    module = importlib.reload(module)
    provider_started = asyncio.Event()
    provider_cancelled = asyncio.Event()
    from astrbot_plugin_ag99live_adapter.runtime.persona_lifecycle import (
        PersonaTurnSessionRegistry,
    )

    runtime_state = SimpleNamespace(
        selected_independent_motion_provider=object(),
        persona_sessions=PersonaTurnSessionRegistry(),
    )
    bundle = SimpleNamespace(runtime_state=runtime_state)

    async def generate(_event, _bundle, *, provider, assistant_text, segment_intent=None):
        del provider, assistant_text
        provider_started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            provider_cancelled.set()
            raise

    monkeypatch.setattr(module, "generate_independent_motion", generate)

    async def run_case() -> None:
        async def persona_result_hook() -> None:
            task = asyncio.current_task()
            assert task is not None
            runtime_state.persona_sessions.register_task("turn-1", task)
            await module.generate_independent_motion_for_segments(
                object(),
                bundle,
                speech_segments=("first", "second"),
                parallel=True,
                tasks=set(),
            )

        hook_task = asyncio.create_task(persona_result_hook())
        await provider_started.wait()
        runtime_state.persona_sessions.clear_turn("turn-1")
        await asyncio.gather(hook_task, return_exceptions=True)

    asyncio.run(run_case())

    assert provider_cancelled.is_set()
    assert runtime_state.persona_sessions.get_session("turn-1") is None


def test_independent_motion_segment_generation_respects_concurrency_limit(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    module = importlib.reload(module)
    selected_provider = object()
    active = 0
    max_active = 0

    async def generate(_event, _bundle, *, provider, assistant_text, segment_intent=None):
        nonlocal active, max_active
        assert provider is selected_provider
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.02)
        active -= 1
        return module.IndependentMotionResult(
            assistant_text=assistant_text,
            motion_payload={"intent_tags": [assistant_text]},
            reason="ok",
            image_count=0,
        )

    monkeypatch.setattr(module, "generate_independent_motion", generate)
    bundle = SimpleNamespace(
        runtime_state=SimpleNamespace(
            selected_independent_motion_provider=selected_provider,
            independent_motion_max_concurrency=2,
            independent_motion_segment_timeout_seconds=1,
        )
    )

    async def run_generation():
        return await module.generate_independent_motion_for_segments(
            object(),
            bundle,
            speech_segments=("first", "second", "third", "fourth"),
            parallel=True,
            tasks=set(),
        )

    results = asyncio.run(run_generation())

    assert max_active == 2
    assert set(results) == {0, 1, 2, 3}


def test_independent_motion_segment_timeout_returns_indexed_failure(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    module = importlib.reload(module)

    async def generate(_event, _bundle, *, provider, assistant_text, segment_intent=None):
        del provider, assistant_text
        await asyncio.Future()

    monkeypatch.setattr(module, "generate_independent_motion", generate)
    bundle = SimpleNamespace(
        runtime_state=SimpleNamespace(
            selected_independent_motion_provider=object(),
            independent_motion_max_concurrency=2,
            independent_motion_segment_timeout_seconds=0.01,
        )
    )
    tasks: set[asyncio.Task] = set()

    async def run_generation():
        return await module.generate_independent_motion_for_segments(
            object(),
            bundle,
            speech_segments=("first", "second"),
            parallel=True,
            tasks=tasks,
        )

    results = asyncio.run(run_generation())

    assert results[0].reason == "motion_timeout"
    assert results[1].reason == "motion_timeout"
    assert tasks == set()


def test_persona_motion_work_is_scoped_by_turn_and_result_id(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    module = importlib.reload(module)
    from astrbot_plugin_ag99live_adapter.runtime.persona_lifecycle import (
        PersonaTurnSessionRegistry,
    )

    registry = PersonaTurnSessionRegistry()
    first = registry.session("turn-1").result("result-1")
    first.expected_segment_count = 3
    first.segment(0).bind_content(speech="first", actions=(), tendency={})
    first.segment(1).bind_content(speech="", actions=(), tendency={})
    first.segment(2).bind_content(speech="third", actions=(), tendency={})
    second = registry.session("turn-1").result("result-2")

    assert registry.get_result("turn-1", "result-1") is first
    assert registry.get_result("turn-1", "result-2") is second
    assert registry.get_result("other-turn", "result-1") is None

    registry.clear_result("turn-1", "result-1")
    assert registry.get_result("turn-1", "result-1") is None
    assert registry.get_result("turn-1", "result-2") is second


def test_persona_tts_requests_bind_by_segment_index_and_validate_identity(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    independent = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    independent = importlib.reload(independent)
    scheduling = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.scheduling"
    )
    scheduling = importlib.reload(scheduling)

    from astrbot_plugin_ag99live_adapter.runtime.persona_lifecycle import (
        PersonaTurnSessionRegistry,
    )

    runtime_state = SimpleNamespace(persona_sessions=PersonaTurnSessionRegistry())
    work = runtime_state.persona_sessions.session("turn-1").result(
        "result-1",
        phase="final",
        parent_message_id="parent-1",
    )
    work.expected_segment_count = 3
    for index, speech in enumerate(("first", "", "third")):
        work.segment(index).bind_content(speech=speech, actions=(), tendency={})
    turn_coordinator = SimpleNamespace(
        runtime_state=runtime_state,
        performance_curves=SimpleNamespace(start_request=lambda **_kwargs: None),
    )
    event_extras = {}
    event = SimpleNamespace(
        adapter=SimpleNamespace(
            turn_coordinator=turn_coordinator,
            runtime_state=runtime_state,
        ),
        get_platform_id=lambda: "olv_pet_adapter",
        get_platform_name=lambda: "olv_pet_adapter",
        get_extra=lambda key, default=None: event_extras.get(key, default),
        set_extra=lambda key, value: event_extras.__setitem__(key, value),
    )

    def track(index: int, message_id: str, request_id: str, *, parent: str = "parent-1"):
        return scheduling.start_deferred_performance_curve_request(
            event,
            turn_id="turn-1",
            message_id=message_id,
            tts_request_id=request_id,
            external_correlation_id="frontend-turn-1",
            stage="interaction.outbound_tts",
            status="requested",
            parent_message_id=parent,
            persona_result_id="result-1",
            persona_segment_index=index,
            persona_segment_count=3,
        )

    assert track(2, "message-2", "tts-2") is None
    assert track(0, "message-0", "tts-0") is None
    assert {index for index, segment in work.segments.items() if segment.tts_binding} == {0, 2}
    assert work.segments[2].tts_binding.message_id == "message-2"
    assert work.segments[2].tts_binding.tts_request_id == "tts-2"
    assert work.segments[0].tts_binding.message_id == "message-0"
    assert {
        index: segment.tts_binding.segment_index
        for index, segment in work.segments.items()
        if segment.tts_binding is not None
    } == {0: 0, 2: 2}

    assert track(1, "message-wrong-parent", "tts-wrong", parent="other-parent") is None
    assert track(2, "message-2", "tts-retry") is None
    assert work.segments[2].tts_binding.tts_request_id == "tts-2"


def test_independent_motion_request_uses_text_memory_and_segment_without_images(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    json_recovery_module = types.ModuleType("astrbot.core.prompt.json_recovery")

    async def recover_json_record(value, **_kwargs):
        import json

        return json.loads(value)

    json_recovery_module.recover_json_record = recover_json_record
    monkeypatch.setitem(
        sys.modules,
        "astrbot.core.prompt.json_recovery",
        json_recovery_module,
    )
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    module = importlib.reload(module)

    class ConversationManager:
        async def get_curr_conversation_id(self, _origin: str) -> str:
            return "conversation-1"

        async def get_conversation(self, _origin: str, _conversation_id: str):
            return types.SimpleNamespace(
                history=[
                    {"role": "user", "content": "更早的问题"},
                    {"role": "assistant", "content": "更早的回答"},
                    {"role": "user", "content": "上一轮问题"},
                    {"role": "assistant", "content": "上一轮回答"},
                    {"role": "user", "content": "本轮输入"},
                    {"role": "assistant", "content": "本轮文本回复"},
                ]
            )

    runtime_state = SimpleNamespace(
        independent_motion_history_turns=1,
        independent_motion_provider_id="motion-provider",
        plugin_context=types.SimpleNamespace(
            conversation_manager=ConversationManager()
        ),
    )
    bundle = types.SimpleNamespace(
        runtime_state=runtime_state,
        turn_coordinator=SimpleNamespace(motion_observations=SimpleNamespace(
            get_prompt_motion_history=lambda: [{
                "intent_tags": ["最近点头"], "axis_levels": {"head_roll": 0},
                "schema_version": "runtime-only", "message_id": "private-runtime-id",
                "expression_resource_id": "", "motion_resource_id": "",
            }],
        )),
    )
    calls: list[dict[str, object]] = []

    class Provider:
        async def text_chat_stream(self, **kwargs):
            calls.append(kwargs)
            completion = (
                '{"intent_tags":["平和"],"axis_levels":{"head_roll":0}}'
            )
            yield types.SimpleNamespace(
                role="assistant",
                completion_text=completion,
                is_chunk=True,
            )
            yield types.SimpleNamespace(
                role="assistant",
                completion_text=completion,
                is_chunk=False,
            )

    monkeypatch.setattr(
        module,
        "_build_motion_static_capability_payload",
        lambda _state: {"axes": [], "resources": []},
    )
    monkeypatch.setattr(
        module,
        "_build_motion_runtime_payload",
        lambda *args, **kwargs: ({"reference_examples": [{
            "input": "自然点头", "output": {"intent_tags": ["点头"], "axis_levels": {"head_roll": 0}},
        }]}, []),
    )
    monkeypatch.setattr(
        module,
        "_build_motion_capability_prompt_payload",
        lambda _payload: {"axes": [{"id": "head_roll", "available_levels": [-1, 0, 1]}], "resources": []},
    )
    monkeypatch.setattr(
        module,
        "_record_motion_prompt_reference_observation",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        module,
        "normalize_motion_arguments_payload",
        lambda *_args, **_kwargs: (
            {"schema_version": "ag99.motion_intent.v4", "intent_tags": ["平和"]},
            "ok",
        ),
    )

    def build_event(raw_message: dict[str, object]):
        extras = {"_turn_id": "turn-1"}
        event = types.SimpleNamespace(
            message_str="本轮输入",
            message_obj=types.SimpleNamespace(raw_message=raw_message),
            unified_msg_origin="olv_pet_adapter:FriendMessage:desktop-client",
            _interaction_turn_state=SimpleNamespace(context_material=SimpleNamespace(
                prompt_context_pack=SimpleNamespace(slots={"memory.short_term": SimpleNamespace(
                    name="memory.short_term", llm_exposure="allowed",
                    value={"short_summary": "喜欢自然点头", "umo": "private-id"},
                )}),
            )),
        )
        event.get_extra = lambda key, default=None: extras.get(key, default)
        return event

    current_event = build_event(
        {
            "resolved_images": [
                {"type": "input_image", "image_url": "file:///current.png"}
            ]
        }
    )
    current_result = asyncio.run(
        module.generate_independent_motion(
            current_event,
            bundle,
            provider=Provider(),
            assistant_text="回复文本",
            segment_intent={"actions": ["nod"], "tendency": {"Joy": 4}},
        )
    )
    reused_snapshot_event = build_event(
        {
            "reused_desktop_snapshot": True,
            "resolved_images": [
                {"type": "input_image", "image_url": "file:///stale.png"}
            ],
        }
    )
    reused_snapshot_result = asyncio.run(
        module.generate_independent_motion(
            reused_snapshot_event,
            bundle,
            provider=Provider(),
            assistant_text="回复文本",
        )
    )

    assert current_result.motion_payload is not None
    assert current_result.image_count == 0
    assert reused_snapshot_result.motion_payload is not None
    assert reused_snapshot_result.image_count == 0
    assert "image_urls" not in calls[0]
    assert "image_urls" not in calls[1]
    import json
    request_input = json.loads(calls[0]["prompt"])
    # Conversation memory is retained in the sampling context, not injected
    # into the provider prompt. Keeping it out preserves the provider cache key
    # and the current-turn request contract.
    assert "memory" not in request_input
    assert request_input["user"] == "本轮输入"
    assert request_input["segment"] == {"speech": "回复文本", "actions": ["nod"], "tendency": {"Joy": 4}}
    assert "private-id" not in calls[0]["prompt"]
    assert '"examples":[{"input":"自然点头"' in calls[0]["system_prompt"]
    assert '"recent_executed":[{"input":"最近执行动作"' in calls[0]["system_prompt"]
    assert "private-runtime-id" not in calls[0]["system_prompt"]
    assert "runtime-only" not in calls[0]["system_prompt"]
    expected_history = [
        {"role": "user", "content": "上一轮问题"},
        {"role": "assistant", "content": "上一轮回答"},
    ]
    assert calls[0]["contexts"] == expected_history
    assert calls[1]["contexts"] == expected_history
    assert "本轮输入" in str(calls[0]["prompt"])
    assert "回复文本" in str(calls[0]["prompt"])
