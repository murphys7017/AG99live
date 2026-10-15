from __future__ import annotations

import asyncio
import importlib
import sys
import types


def _install_main_astrbot_stubs(install_fake_astrbot, monkeypatch) -> None:
    install_fake_astrbot()

    event_module = types.ModuleType("astrbot.api.event")

    class _Filter:
        @staticmethod
        def on_decorating_result():
            def decorator(fn):
                return fn

            return decorator

        @staticmethod
        def on_tts_state_changed():
            def decorator(fn):
                return fn

            return decorator

        @staticmethod
        def on_llm_request():
            def decorator(fn):
                return fn

            return decorator

        @staticmethod
        def on_llm_response():
            def decorator(fn):
                return fn

            return decorator

    class AstrMessageEvent:
        pass

    class TTSState:
        def __init__(self, *, status: str) -> None:
            self.turn_id = "turn-1"
            self.message_id = "message-1"
            self.tts_request_id = "tts-1"
            self.external_correlation_id = "frontend-turn-1"
            self.parent_message_id = "parent-1"
            self.persona_result_id = "persona-result-1"
            self.persona_segment_index = 2
            self.persona_segment_count = 3
            self.stage = "interaction.outbound_tts"
            self.status = status

    event_module.AstrMessageEvent = AstrMessageEvent
    event_module.TTSState = TTSState
    event_module.filter = _Filter()
    monkeypatch.setitem(sys.modules, "astrbot.api.event", event_module)

    message_components = types.ModuleType("astrbot.api.message_components")

    class Plain:
        def __init__(self, text: str = "") -> None:
            self.text = text

    message_components.Plain = Plain
    monkeypatch.setitem(sys.modules, "astrbot.api.message_components", message_components)

    provider_module = types.ModuleType("astrbot.api.provider")

    class ProviderRequest:
        pass

    class LLMResponse:
        pass

    provider_module.ProviderRequest = ProviderRequest
    provider_module.LLMResponse = LLMResponse
    monkeypatch.setitem(sys.modules, "astrbot.api.provider", provider_module)

    star_module = types.ModuleType("astrbot.api.star")

    class Context:
        pass

    class Star:
        def __init__(self, context: Context):
            self.context = context

    star_module.Context = Context
    star_module.Star = Star
    monkeypatch.setitem(sys.modules, "astrbot.api.star", star_module)

    web_control_module = types.ModuleType(
        "astrbot_plugin_ag99live_adapter.web_control"
    )
    web_control_module.register_web_control_page = lambda *_args: False
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.web_control",
        web_control_module,
    )



def test_main_plugin_normalizes_output_and_starts_curve_on_tts_generating(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_main_astrbot_stubs(install_fake_astrbot, monkeypatch)

    # Stub plugin runtime side effects
    plugin_runtime = types.ModuleType("astrbot_plugin_ag99live_adapter.runtime.plugin_runtime")
    plugin_runtime.ADAPTER_DISPLAY_NAME = "AG99live 桌宠适配器"
    plugin_runtime.ADAPTER_PLATFORM_NAME = "olv_pet_adapter"
    plugin_runtime.get_live_control_platform = lambda *_args: None
    plugin_runtime.get_plugin_context = lambda: None
    plugin_runtime.reconcile_control_platforms = lambda _context: []
    plugin_runtime.set_plugin_config = lambda _config: None
    plugin_runtime.set_plugin_context = lambda _context: None
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.runtime.plugin_runtime",
        plugin_runtime,
    )

    middleware_module = types.ModuleType("astrbot_plugin_ag99live_adapter.middleware")
    middleware_module.__path__ = []
    middleware_module.register_ag99live_interaction_contributors = (
        lambda _context, **_options: True
    )
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.middleware",
        middleware_module,
    )
    curve_starts: list[dict[str, str]] = []
    interaction_motion_module = types.ModuleType(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion"
    )

    def start_deferred_performance_curve_request(event, **identity) -> None:
        assert identity["stage"] == "interaction.outbound_tts"
        if identity["status"] == "generating":
            assert event.get_extra("ag99live_raw_reply_text")
            curve_starts.append(identity)
            event.set_extra("_ag99live_pending_performance_curve", None)

    interaction_motion_module.start_deferred_performance_curve_request = (
        start_deferred_performance_curve_request
    )
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion",
        interaction_motion_module,
    )

    platform_adapter_module = types.ModuleType("astrbot_plugin_ag99live_adapter.platform_adapter")
    platform_adapter_module.OLVPetPlatformAdapter = object
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.platform_adapter",
        platform_adapter_module,
    )

    sys.modules.pop("astrbot_plugin_ag99live_adapter.main", None)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.main")
    MyPlugin = module.MyPlugin
    TTSState = sys.modules["astrbot.api.event"].TTSState

    plugin = MyPlugin(context=module.Context(), config={})

    extras: dict[str, object] = {}

    class ResultStub:
        def __init__(self) -> None:
            self.chain = [
                module.Plain(
                    'hello <system_reminder>private</system_reminder>'
                    '<@anim {"mode":"inline","intent":{}}>'
                )
            ]

    class EventStub:
        def get_platform_name(self) -> str:
            return "olv_pet_adapter"

        def get_result(self):
            return self.result

        def get_extra(self, key: str, default=None):
            return extras.get(key, default)

        def set_extra(self, key: str, value: object) -> None:
            extras[key] = value

    event = EventStub()
    event.result = ResultStub()
    asyncio.run(plugin.sanitize_hidden_output_markup(event))

    assert extras.get("ag99live_raw_reply_text") == (
        'hello <system_reminder>private</system_reminder>'
        '<@anim {"mode":"inline","intent":{}}>'
    )
    assert event.result.chain[0].text == (
        'hello <@anim {"mode":"inline","intent":{}}>'
    )

    asyncio.run(
        plugin.handle_tts_generation_state(event, TTSState(status="requested"))
    )
    asyncio.run(
        plugin.handle_tts_generation_state(event, TTSState(status="generating"))
    )
    asyncio.run(
        plugin.handle_tts_generation_state(event, TTSState(status="succeeded"))
    )

    assert curve_starts == [
        {
            "turn_id": "turn-1",
            "message_id": "message-1",
            "tts_request_id": "tts-1",
            "external_correlation_id": "frontend-turn-1",
            "stage": "interaction.outbound_tts",
            "status": "generating",
            "parent_message_id": "parent-1",
            "persona_result_id": "persona-result-1",
            "persona_segment_index": 2,
            "persona_segment_count": 3,
        }
    ]


def test_main_plugin_registers_interaction_contributors_during_init(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_main_astrbot_stubs(install_fake_astrbot, monkeypatch)

    plugin_runtime = types.ModuleType("astrbot_plugin_ag99live_adapter.runtime.plugin_runtime")
    plugin_runtime.ADAPTER_DISPLAY_NAME = "AG99live 桌宠适配器"
    plugin_runtime.ADAPTER_PLATFORM_NAME = "olv_pet_adapter"
    plugin_runtime.get_live_control_platform = lambda *_args: None
    plugin_runtime.get_plugin_context = lambda: None
    plugin_runtime.reconcile_control_platforms = lambda _context: []
    plugin_runtime.set_plugin_config = lambda _config: None
    plugin_runtime.set_plugin_context = lambda _context: None
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.runtime.plugin_runtime",
        plugin_runtime,
    )

    registered_contexts: list[object] = []
    registered_effect_enabled: list[bool] = []
    middleware_module = types.ModuleType("astrbot_plugin_ag99live_adapter.middleware")
    middleware_module.__path__ = []

    def register_contributors(context, *, persona_effect_enabled: bool = True) -> bool:
        registered_contexts.append(context)
        registered_effect_enabled.append(persona_effect_enabled)
        return True

    middleware_module.register_ag99live_interaction_contributors = register_contributors
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.middleware",
        middleware_module,
    )

    platform_adapter_module = types.ModuleType("astrbot_plugin_ag99live_adapter.platform_adapter")
    platform_adapter_module.OLVPetPlatformAdapter = object
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.platform_adapter",
        platform_adapter_module,
    )

    sys.modules.pop("astrbot_plugin_ag99live_adapter.main", None)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.main")
    context = module.Context()
    module.MyPlugin(
        context=context,
        config={"independent_motion": {"enabled": True}},
    )

    assert registered_contexts == [context]
    assert registered_effect_enabled == [False]


def test_persona_segment_ready_starts_motion_future_for_that_index(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_main_astrbot_stubs(install_fake_astrbot, monkeypatch)

    plugin_runtime = types.ModuleType("astrbot_plugin_ag99live_adapter.runtime.plugin_runtime")
    plugin_runtime.ADAPTER_DISPLAY_NAME = "AG99live 桌宠适配器"
    plugin_runtime.ADAPTER_PLATFORM_NAME = "olv_pet_adapter"
    plugin_runtime.get_live_control_platform = lambda *_args: None
    plugin_runtime.get_plugin_context = lambda: None
    plugin_runtime.reconcile_control_platforms = lambda _context: []
    plugin_runtime.set_plugin_config = lambda _config: None
    plugin_runtime.set_plugin_context = lambda _context: None
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.runtime.plugin_runtime",
        plugin_runtime,
    )

    middleware_module = types.ModuleType("astrbot_plugin_ag99live_adapter.middleware")
    middleware_module.__path__ = []
    middleware_module.register_ag99live_interaction_contributors = (
        lambda *_args, **_kwargs: True
    )
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.middleware",
        middleware_module,
    )
    motion_package = types.ModuleType(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion"
    )
    motion_package.__path__ = []
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion",
        motion_package,
    )

    result = types.SimpleNamespace(
        assistant_text="hello",
        motion_payload={"axis_levels": {"Joy": 0.8}},
        reason="independent_provider",
        image_count=0,
    )
    prepared_context = object()
    generation_calls: list[dict] = []

    class IndependentMotionResult:
        def __init__(self, **kwargs) -> None:
            self.__dict__.update(kwargs)

    async def prepare_context(event, bundle, *, persona_result_id):
        del event, bundle, persona_result_id
        return prepared_context

    async def generate_for_segments(event, bundle, **kwargs):
        del event, bundle
        generation_calls.append(kwargs)
        return {0: result}

    independent_module = types.ModuleType(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent"
    )
    independent_module.PERSONA_RESULT_ID_METADATA_KEY = (
        "interaction.persona_result_id"
    )
    independent_module.IndependentMotionResult = IndependentMotionResult
    independent_module._prepare_independent_motion_context = prepare_context
    independent_module.generate_independent_motion_for_segments = generate_for_segments
    independent_module.is_persona_expression_request = lambda _request: True
    independent_module.persona_expression_intent = lambda _request: {
        "phase": "immediate",
        "kind": "reply",
    }
    independent_module.track_motion_generation_task = lambda *_args, **_kwargs: True
    independent_module.untrack_motion_generation_task = lambda *_args, **_kwargs: None
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.independent",
        independent_module,
    )
    shared_module = types.ModuleType(
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.shared"
    )
    shared_module._resolve_motion_runtime_bundle = lambda _event: bundle
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.middleware.interaction_motion.shared",
        shared_module,
    )

    platform_adapter_module = types.ModuleType(
        "astrbot_plugin_ag99live_adapter.platform_adapter"
    )
    platform_adapter_module.OLVPetPlatformAdapter = object
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.platform_adapter",
        platform_adapter_module,
    )

    sys.modules.pop("astrbot_plugin_ag99live_adapter.main", None)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.main")
    plugin = module.MyPlugin.__new__(module.MyPlugin)
    plugin._official_core_compatibility = False
    plugin._independent_motion_tasks = set()

    runtime_state = types.SimpleNamespace(
        independent_motion_enabled=True,
        independent_motion_per_speech_segment=True,
        independent_motion_parallel=False,
        independent_motion_max_concurrency=2,
        independent_motion_segment_timeout_seconds=5,
    )
    bundle = types.SimpleNamespace(runtime_state=runtime_state)
    extras = {
        "_turn_id": "turn-1",
        "_interaction_persona_segment_stream_active": True,
        "provider_request": object(),
    }

    class EventStub:
        def get_platform_name(self) -> str:
            return "olv_pet_adapter"

        def get_extra(self, key: str, default=None):
            return extras.get(key, default)

        def set_extra(self, key: str, value) -> None:
            extras[key] = value

        def stop_event(self) -> None:
            extras["stopped"] = True

    event = EventStub()

    async def run() -> None:
        await plugin.handle_persona_expression_segment_ready(
            event,
            turn_id="turn-1",
            persona_result_id="result-1",
            segment_index=0,
            message_id="stream-parent",
            segment={
                "speech": " hello ",
                "actions": [{"name": "blink"}],
                "tendency": {"Joy": 0.2},
            },
        )
        work = event.get_extra("_ag99live_persona_stream_motion_work")
        motion = await work["segment_result_futures"][0]
        await asyncio.gather(*tuple(work["tasks"]))
        assert motion is result
        await plugin.handle_persona_expression_result(
            event,
            types.SimpleNamespace(
                metadata={"interaction.persona_result_id": "result-1"},
                segments=[{"speech": "hello"}],
            ),
        )

    asyncio.run(run())
    assert generation_calls[0]["speech_segments"] == (" hello ",)
    assert generation_calls[0]["segment_intents"] == (
        {"actions": [{"name": "blink"}], "tendency": {"Joy": 0.2}},
    )
    assert generation_calls[0]["prepared_context"] is prepared_context
    assert len(generation_calls) == 1
    assert not extras.get("stopped", False)
