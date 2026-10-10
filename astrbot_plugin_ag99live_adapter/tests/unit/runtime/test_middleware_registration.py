from __future__ import annotations

import asyncio
import importlib
import sys
import types
from types import SimpleNamespace


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


def test_register_ag99live_interaction_contributors_keeps_motion_only(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.middleware")
    module = importlib.reload(module)

    prompt_collectors: list[object] = []
    result_contributors: list[object] = []
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

        def register_interaction_result_contributor(self, contributor: object) -> None:
            result_contributors.append(contributor)

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
    assert "AstrBot 在桌面上的身体" in extension.value
    assert "虚拟主播" in extension.value


def test_official_companion_identity_prompt_is_appended(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.companion"
    )
    module = importlib.reload(module)
    request = types.SimpleNamespace(system_prompt="existing system prompt")

    module.append_official_companion_prompt(request)

    assert request.system_prompt.startswith("existing system prompt\n\n")
    assert "桌宠式的长期陪伴者" in request.system_prompt


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


def test_enhanced_interaction_requires_llm_response_hook(
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

    assert not module.supports_llm_response_hook()
    assert not module.supports_interaction_contributors(context)


def test_independent_motion_results_match_each_visible_persona_reply(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    module = importlib.reload(module)

    immediate = module.IndependentMotionResult(
        assistant_text="我先查一下。",
        motion_payload={"schema_version": "ag99.motion_intent.v4", "intent_tags": ["thinking"]},
        reason="ok",
        image_count=0,
    )
    final = module.IndependentMotionResult(
        assistant_text="已经查到了。",
        motion_payload={"schema_version": "ag99.motion_intent.v4", "intent_tags": ["happy"]},
        reason="ok",
        image_count=1,
    )
    runtime_state = SimpleNamespace(independent_motion_result_cache={})
    persona_request = types.SimpleNamespace(
        metadata={
            "interaction.persona_expression_intent": {"phase": "immediate"}
        }
    )
    core_request = types.SimpleNamespace(metadata={"source": "core"})

    assert module.is_persona_expression_request(persona_request)
    assert not module.is_persona_expression_request(core_request)
    assert module.store_motion_result_for_turn(
        runtime_state,
        turn_id="turn-1",
        result=immediate,
        assistant_text=immediate.assistant_text,
    )
    assert module.store_motion_result_for_turn(
        runtime_state,
        turn_id="turn-1",
        result=final,
        assistant_text=final.assistant_text,
    )

    assert module.take_motion_result_for_turn(
        runtime_state,
        turn_id="turn-1",
        assistant_text="not a reply in this turn",
    ) is None
    assert module.take_motion_result_for_turn(
        runtime_state,
        turn_id="turn-1",
        assistant_text=immediate.assistant_text,
    ) == immediate
    assert module.take_motion_result_for_turn(
        runtime_state,
        turn_id="turn-1",
        assistant_text=final.assistant_text,
    ) == final
    assert runtime_state.independent_motion_result_cache == {}


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

    async def generate(_event, _bundle, *, provider, assistant_text):
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
    runtime_state = SimpleNamespace(selected_independent_motion_provider=object())
    bundle = SimpleNamespace(runtime_state=runtime_state)

    async def generate(_event, _bundle, *, provider, assistant_text):
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
            assert module.track_motion_generation_task(
                runtime_state,
                turn_id="turn-1",
                task=task,
            )
            try:
                await module.generate_independent_motion_for_segments(
                    object(),
                    bundle,
                    speech_segments=("first", "second"),
                    parallel=True,
                    tasks=set(),
                )
            finally:
                module.untrack_motion_generation_task(
                    runtime_state,
                    turn_id="turn-1",
                    task=task,
                )

        hook_task = asyncio.create_task(persona_result_hook())
        await provider_started.wait()
        hook_task.cancel()
        await asyncio.gather(hook_task, return_exceptions=True)

    asyncio.run(run_case())

    assert provider_cancelled.is_set()
    assert runtime_state.independent_motion_generation_tasks_by_turn == {}


def test_independent_motion_segment_batch_requires_exact_candidate_speech(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    module = importlib.reload(module)
    runtime_state = SimpleNamespace()
    result = module.IndependentMotionResult(
        assistant_text="third",
        motion_payload={"schema_version": "ag99.motion_intent.v4"},
        reason="ok",
        image_count=0,
    )
    assert module.store_motion_segment_batch(
        runtime_state,
        turn_id="turn-1",
        phase="final",
        kind="reply",
        speech_segments=("first", "", "third"),
        results_by_index={2: result},
    )
    other_candidate = module.IndependentMotionResult(
        assistant_text="different",
        motion_payload={"schema_version": "ag99.motion_intent.v4"},
        reason="ok",
        image_count=0,
    )
    assert module.store_motion_segment_batch(
        runtime_state,
        turn_id="turn-1",
        phase="final",
        kind="reply",
        speech_segments=("different",),
        results_by_index={0: other_candidate},
    )

    assert module.take_motion_segment_batch(
        runtime_state,
        turn_id="turn-1",
        phase="immediate",
        purpose="interaction",
        speech_segments=("first", "", "third"),
    ) is None
    batch = module.take_motion_segment_batch(
        runtime_state,
        turn_id="turn-1",
        phase="final",
        purpose="interaction",
        speech_segments=("first", "", "third"),
    )

    assert batch is not None
    assert batch.results_by_index == {2: result}
    other_batch = module.take_motion_segment_batch(
        runtime_state,
        turn_id="turn-1",
        phase="final",
        purpose="interaction",
        speech_segments=("different",),
    )
    assert other_batch is not None
    assert other_batch.results_by_index == {0: other_candidate}
    assert runtime_state.independent_motion_segment_batches_by_turn == {}


def test_independent_motion_result_matches_sanitized_visible_reply(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    module = importlib.reload(module)
    result = module.IndependentMotionResult(
        assistant_text=(
            '<system_reminder>hidden</system_reminder>'
            '已经查到了。<@anim {"motion":"wave"}>'
        ),
        motion_payload={
            "schema_version": "ag99.motion_intent.v4",
            "intent_tags": ["happy"],
        },
        reason="ok",
        image_count=0,
    )
    runtime_state = SimpleNamespace(independent_motion_result_cache={})

    assert module.store_motion_result_for_turn(
        runtime_state,
        turn_id="turn-1",
        result=result,
        assistant_text=result.assistant_text,
    )
    selected = module.take_motion_result_for_turn(
        runtime_state,
        turn_id="turn-1",
        assistant_text="已经查到了。",
    )

    assert selected is not None
    assert selected.motion_payload == result.motion_payload
    assert selected.assistant_text == "已经查到了。"


def test_independent_motion_request_uses_prior_text_and_only_current_images(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_middleware_astrbot_stubs(install_fake_astrbot, monkeypatch)
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
        turn_coordinator=object(),
    )
    calls: list[dict[str, object]] = []

    class Provider:
        async def text_chat(self, **kwargs):
            calls.append(kwargs)
            return types.SimpleNamespace(
                completion_text=(
                    '{"intent_tags":["平和"],"axis_levels":{"head_roll":0}}'
                )
            )

    monkeypatch.setattr(
        module,
        "_build_motion_static_capability_payload",
        lambda _state: {"axes": [], "resources": []},
    )
    monkeypatch.setattr(
        module,
        "_build_motion_runtime_payload",
        lambda *args, **kwargs: ({}, []),
    )
    monkeypatch.setattr(
        module,
        "_build_motion_capability_prompt_payload",
        lambda _payload: {"axes": [], "resources": []},
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
    assert current_result.image_count == 1
    assert reused_snapshot_result.motion_payload is not None
    assert reused_snapshot_result.image_count == 0
    assert calls[0]["image_urls"] == ["file:///current.png"]
    assert calls[1]["image_urls"] is None
    expected_history = [
        {"role": "user", "content": "上一轮问题"},
        {"role": "assistant", "content": "上一轮回答"},
    ]
    assert calls[0]["contexts"] == expected_history
    assert calls[1]["contexts"] == expected_history
    assert "本轮输入" in str(calls[0]["prompt"])
    assert "回复文本" in str(calls[0]["prompt"])
