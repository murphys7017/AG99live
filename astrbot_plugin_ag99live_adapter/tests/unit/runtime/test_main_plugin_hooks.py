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
        def on_llm_response():
            def decorator(fn):
                return fn

            return decorator

    class AstrMessageEvent:
        pass

    event_module.AstrMessageEvent = AstrMessageEvent
    event_module.filter = _Filter()
    monkeypatch.setitem(sys.modules, "astrbot.api.event", event_module)

    message_components = types.ModuleType("astrbot.api.message_components")

    class Plain:
        def __init__(self, text: str = "") -> None:
            self.text = text

    message_components.Plain = Plain
    monkeypatch.setitem(sys.modules, "astrbot.api.message_components", message_components)

    star_module = types.ModuleType("astrbot.api.star")

    class Context:
        pass

    class Star:
        def __init__(self, context: Context):
            self.context = context

    star_module.Context = Context
    star_module.Star = Star
    monkeypatch.setitem(sys.modules, "astrbot.api.star", star_module)


def test_main_plugin_sanitizes_hidden_output_markup_before_tts(
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
    middleware_module.register_ag99live_interaction_contributors = lambda _context: None
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

    module = importlib.import_module("astrbot_plugin_ag99live_adapter.main")
    Plain = module.Plain
    MyPlugin = module.MyPlugin

    plugin = MyPlugin(context=module.Context(), config={})

    extras: dict[str, object] = {}

    class ResultStub:
        def __init__(self) -> None:
            self.chain = [Plain('hello <@anim {"mode":"inline","intent":{}}>' )]

    class EventStub:
        def get_platform_name(self) -> str:
            return "olv_pet_adapter"

        def get_result(self):
            return ResultStub()

        def set_extra(self, key: str, value: object) -> None:
            extras[key] = value

    event = EventStub()
    asyncio.run(plugin.sanitize_hidden_output_markup_before_tts(event))

    assert extras.get("ag99live_raw_reply_text") == 'hello <@anim {"mode":"inline","intent":{}}>'
