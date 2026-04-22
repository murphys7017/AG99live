from __future__ import annotations

import asyncio
import importlib


def _build_valid_parameter_plan(mode: str = "expressive") -> dict:
    return {
        "schema_version": "engine.parameter_plan.v1",
        "mode": mode,
        "emotion_label": "test",
        "timing": {
            "duration_ms": 1200,
            "blend_in_ms": 120,
            "hold_ms": 840,
            "blend_out_ms": 240,
        },
        "key_axes": {
            "head_yaw": {"value": 62},
            "head_roll": {"value": 50},
            "head_pitch": {"value": 50},
            "body_yaw": {"value": 50},
            "body_roll": {"value": 50},
            "gaze_x": {"value": 50},
            "gaze_y": {"value": 50},
            "eye_open_left": {"value": 52},
            "eye_open_right": {"value": 52},
            "mouth_open": {"value": 48},
            "mouth_smile": {"value": 64},
            "brow_bias": {"value": 56},
        },
        "supplementary_params": [
            {
                "parameter_id": "ParamCheek",
                "target_value": 0.42,
                "weight": 0.36,
                "source_atom_id": "head_yaw.positive.01",
                "channel": "head_yaw",
            }
        ],
    }


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
        return _build_valid_parameter_plan()

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
        return _build_valid_parameter_plan()

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
        'hello <@anim {"mode":"inline","plan":{"schema_version":"engine.parameter_plan.v1","mode":"expressive","emotion_label":"inline","timing":{"duration_ms":900,"blend_in_ms":120,"hold_ms":620,"blend_out_ms":160},"key_axes":{"head_yaw":{"value":61},"head_roll":{"value":50},"head_pitch":{"value":50},"body_yaw":{"value":50},"body_roll":{"value":50},"gaze_x":{"value":50},"gaze_y":{"value":50},"eye_open_left":{"value":55},"eye_open_right":{"value":55},"mouth_open":{"value":52},"mouth_smile":{"value":63},"brow_bias":{"value":58}},"supplementary_params":[{"parameter_id":"ParamCheek","target_value":0.3,"weight":0.4,"source_atom_id":"inline.1","channel":"head_yaw"}]}}> world'
    )

    assert "<@anim" not in text.lower()
    assert "hello" in text.lower()
    assert "world" in text.lower()
    assert isinstance(plan, dict)
    assert plan.get("schema_version") == "engine.parameter_plan.v1"
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


def test_emit_message_chain_inline_plan_uses_primary_route(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("adapter.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator
    Plain = module.Plain

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = type(
        "SessionStateStub",
        (),
        {
            "client_uid": "desktop-client",
            "current_turn_id": "turn-inline",
            "last_user_text": "fallback user text",
        },
    )()

    class ChatBufferStub:
        def __init__(self) -> None:
            self.items: list[tuple[str, str]] = []

        def add(self, role: str, text: str) -> None:
            self.items.append((role, text))

    coordinator.chat_buffer = ChatBufferStub()
    coordinator.speaker_name = "assistant"
    coordinator._mark_turn_timing = lambda *_args, **_kwargs: None

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json

    scheduled: dict[str, object] = {}

    def fake_schedule_realtime_motion_plan_preview(*, reply_text: str, origin_turn_id: str | None = None):
        scheduled["reply_text"] = reply_text
        scheduled["origin_turn_id"] = origin_turn_id

    coordinator._schedule_realtime_motion_plan_preview = fake_schedule_realtime_motion_plan_preview

    inline_broadcast: dict[str, object] = {}

    async def fake_broadcast_motion_plan_preview(**kwargs):
        inline_broadcast.update(kwargs)
        return True

    coordinator.broadcast_motion_plan_preview = fake_broadcast_motion_plan_preview

    async def fake_finish_turn(*, success: bool, reason: str | None):
        del success
        del reason

    coordinator._finish_turn = fake_finish_turn

    asyncio.run(
        coordinator.emit_message_chain(
            message_chain=[
                Plain('hello <@anim {"mode":"inline","plan":{"schema_version":"engine.parameter_plan.v1","mode":"expressive","emotion_label":"inline","timing":{"duration_ms":900,"blend_in_ms":120,"hold_ms":620,"blend_out_ms":160},"key_axes":{"head_yaw":{"value":61},"head_roll":{"value":50},"head_pitch":{"value":50},"body_yaw":{"value":50},"body_roll":{"value":50},"gaze_x":{"value":50},"gaze_y":{"value":50},"eye_open_left":{"value":55},"eye_open_right":{"value":55},"mouth_open":{"value":52},"mouth_smile":{"value":63},"brow_bias":{"value":58}},"supplementary_params":[{"parameter_id":"ParamCheek","target_value":0.3,"weight":0.4,"source_atom_id":"inline.1","channel":"head_yaw"}]}}> world')
            ],
        )
    )

    assert inline_broadcast.get("source") == "engine.inline_motion_plan"
    assert inline_broadcast.get("mode") == "inline"
    assert inline_broadcast.get("turn_id") == "turn-inline"
    assert "reply_text" not in scheduled
    assert sent_payloads
    output_text_payload = sent_payloads[0]
    assert output_text_payload.get("type") == "output.text"
    assert "<@anim" not in str(output_text_payload.get("payload", {}).get("text", "")).lower()


def test_emit_message_chain_inline_parse_fail_falls_back_to_secondary_request(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("adapter.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator
    Plain = module.Plain

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = type(
        "SessionStateStub",
        (),
        {
            "client_uid": "desktop-client",
            "current_turn_id": "turn-inline-fallback",
            "last_user_text": "fallback user text",
        },
    )()

    class ChatBufferStub:
        def add(self, role: str, text: str) -> None:
            del role
            del text

    coordinator.chat_buffer = ChatBufferStub()
    coordinator.speaker_name = "assistant"
    coordinator._mark_turn_timing = lambda *_args, **_kwargs: None

    async def fake_send_json(_payload):
        return True

    coordinator._send_json = fake_send_json

    scheduled: dict[str, object] = {}

    def fake_schedule_realtime_motion_plan_preview(*, reply_text: str, origin_turn_id: str | None = None):
        scheduled["reply_text"] = reply_text
        scheduled["origin_turn_id"] = origin_turn_id

    coordinator._schedule_realtime_motion_plan_preview = fake_schedule_realtime_motion_plan_preview

    called_broadcast: dict[str, object] = {}

    async def fake_broadcast_motion_plan_preview(**kwargs):
        called_broadcast.update(kwargs)
        return True

    coordinator.broadcast_motion_plan_preview = fake_broadcast_motion_plan_preview

    async def fake_finish_turn(*, success: bool, reason: str | None):
        del success
        del reason

    coordinator._finish_turn = fake_finish_turn

    asyncio.run(
        coordinator.emit_message_chain(
            message_chain=[
                Plain('hello <@anim {"mode":"inline" \nworld')
            ],
        )
    )

    assert called_broadcast == {}
    assert scheduled.get("origin_turn_id") == "turn-inline-fallback"
    assert str(scheduled.get("reply_text") or "").strip()
