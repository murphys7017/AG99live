from __future__ import annotations

import asyncio
import importlib


def _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch) -> None:
    install_fake_astrbot()

    import types
    import sys

    message_components = types.ModuleType("astrbot.api.message_components")

    class Plain:
        def __init__(self, text: str = "") -> None:
            self.text = text

    class Image:
        def __init__(self, file: str = "") -> None:
            self.file = file

    class Record:
        def __init__(self, file: str = "", text: str = "") -> None:
            self.file = file
            self.text = text

    message_components.Plain = Plain
    message_components.Image = Image
    message_components.Record = Record
    monkeypatch.setitem(sys.modules, "astrbot.api.message_components", message_components)

    message_session_module = types.ModuleType("astrbot.core.platform.message_session")

    class MessageSession:
        def __init__(self, platform_name: str, message_type: str, session_id: str) -> None:
            self.platform_name = platform_name
            self.message_type = message_type
            self.session_id = session_id

        def __str__(self) -> str:
            return f"{self.platform_name}:{self.message_type}:{self.session_id}"

    message_session_module.MessageSession = MessageSession
    monkeypatch.setitem(sys.modules, "astrbot.core.platform.message_session", message_session_module)

    message_type_module = types.ModuleType("astrbot.core.platform.message_type")
    message_type_module.MessageType = types.SimpleNamespace(FRIEND_MESSAGE="friend_message")
    monkeypatch.setitem(sys.modules, "astrbot.core.platform.message_type", message_type_module)

    registry_module = types.ModuleType("astrbot.core.utils.active_event_registry")
    registry_module.active_event_registry = types.SimpleNamespace(
        stop_all=lambda *_args, **_kwargs: 0,
        request_agent_stop_all=lambda *_args, **_kwargs: 0,
    )
    monkeypatch.setitem(sys.modules, "astrbot.core.utils.active_event_registry", registry_module)


def test_realtime_motion_plan_skips_when_turn_becomes_stale(install_fake_astrbot, monkeypatch) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("adapter.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = type("SessionStateStub", (), {"current_turn_id": "turn-b"})()

    async def fake_generate_realtime_motion_plan(*, user_text: str, assistant_text: str):
        del user_text
        del assistant_text
        return {"steps": [{"atom_id": "x"}]}

    called: dict[str, object] = {}

    async def fake_broadcast_motion_plan_preview(**kwargs):
        called.update(kwargs)
        return True

    coordinator._generate_realtime_motion_plan = fake_generate_realtime_motion_plan
    coordinator._realtime_motion_mode_getter = lambda: "realtime"
    coordinator.broadcast_motion_plan_preview = fake_broadcast_motion_plan_preview

    asyncio.run(
        coordinator._generate_and_broadcast_realtime_motion_plan(
            user_text="u",
            assistant_text="a",
            origin_turn_id="turn-a",
        )
    )

    assert called == {}


def test_realtime_motion_plan_uses_origin_turn_id_when_session_is_idle(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("adapter.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = type("SessionStateStub", (), {"current_turn_id": None})()

    async def fake_generate_realtime_motion_plan(*, user_text: str, assistant_text: str):
        del user_text
        del assistant_text
        return {"steps": [{"atom_id": "x"}]}

    called: dict[str, object] = {}

    async def fake_broadcast_motion_plan_preview(**kwargs):
        called.update(kwargs)
        return True

    coordinator._generate_realtime_motion_plan = fake_generate_realtime_motion_plan
    coordinator._realtime_motion_mode_getter = lambda: "realtime"
    coordinator.broadcast_motion_plan_preview = fake_broadcast_motion_plan_preview

    asyncio.run(
        coordinator._generate_and_broadcast_realtime_motion_plan(
            user_text="u",
            assistant_text="a",
            origin_turn_id="turn-a",
        )
    )

    assert called.get("turn_id") == "turn-a"
    assert called.get("source") == "engine.realtime_motion_plan"


def test_extract_inline_motion_plan_strips_valid_tag(install_fake_astrbot, monkeypatch) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("adapter.turn_coordinator")

    text, plan, mode = module._extract_inline_motion_plan(
        'hello <@anim {"mode":"inline","plan":{"steps":[{"atom_id":"x"}]}}> world'
    )

    assert "<@anim" not in text.lower()
    assert "hello" in text.lower()
    assert "world" in text.lower()
    assert isinstance(plan, dict)
    assert isinstance(plan.get("steps"), list)
    assert mode == "inline"


def test_extract_inline_motion_plan_strips_malformed_tag(install_fake_astrbot, monkeypatch) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("adapter.turn_coordinator")

    text, plan, mode = module._extract_inline_motion_plan(
        'hello <@anim {"mode":"inline" \nworld'
    )

    assert "<@anim" not in text.lower()
    assert "hello" in text.lower()
    assert "world" in text.lower()
    assert plan is None
    assert mode is None
