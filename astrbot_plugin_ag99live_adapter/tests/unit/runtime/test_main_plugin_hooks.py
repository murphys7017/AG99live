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

    provider_module.ProviderRequest = ProviderRequest
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

    remote_operator_module = types.ModuleType(
        "astrbot_plugin_ag99live_adapter.middleware.remote_operator"
    )
    remote_operator_module.arbitrate_remote_operator_tools_for_request = (
        lambda _event, _request: None
    )
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.middleware.remote_operator",
        remote_operator_module,
    )


def test_main_plugin_normalizes_output_and_starts_curve_on_tts_generating(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_main_astrbot_stubs(install_fake_astrbot, monkeypatch)

    # Stub plugin runtime side effects
    plugin_runtime = types.ModuleType("astrbot_plugin_ag99live_adapter.runtime.plugin_runtime")
    plugin_runtime.set_plugin_config = lambda _config: None
    plugin_runtime.set_plugin_context = lambda _context: None
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.runtime.plugin_runtime",
        plugin_runtime,
    )

    middleware_module = types.ModuleType("astrbot_plugin_ag99live_adapter.middleware")
    middleware_module.__path__ = []
    middleware_module.register_ag99live_interaction_contributors = lambda _context: True
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
            self.chain = [module.Plain('hello <@anim {"mode":"inline","intent":{}}>')]

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

    assert extras.get("ag99live_raw_reply_text") == 'hello <@anim {"mode":"inline","intent":{}}>'
    assert event.result.chain[0].text == "hello"

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
        }
    ]


def test_main_plugin_registers_interaction_contributors_during_init(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_main_astrbot_stubs(install_fake_astrbot, monkeypatch)

    plugin_runtime = types.ModuleType("astrbot_plugin_ag99live_adapter.runtime.plugin_runtime")
    plugin_runtime.set_plugin_config = lambda _config: None
    plugin_runtime.set_plugin_context = lambda _context: None
    monkeypatch.setitem(
        sys.modules,
        "astrbot_plugin_ag99live_adapter.runtime.plugin_runtime",
        plugin_runtime,
    )

    registered_contexts: list[object] = []
    middleware_module = types.ModuleType("astrbot_plugin_ag99live_adapter.middleware")
    middleware_module.__path__ = []

    def register_contributors(context) -> bool:
        registered_contexts.append(context)
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
    module.MyPlugin(context=context, config={})

    assert registered_contexts == [context]
