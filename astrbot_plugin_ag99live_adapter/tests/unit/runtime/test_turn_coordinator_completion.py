from __future__ import annotations

import asyncio
import importlib
import sys
import types


def _install_astrbot_stubs(install_fake_astrbot, monkeypatch) -> None:
    install_fake_astrbot()

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
    monkeypatch.setitem(
        sys.modules, "astrbot.api.message_components", message_components
    )

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


def _create_session_state_stub(
    *,
    client_uid: str = "test-client",
    current_turn_id: str | None = "turn-1",
    waiting_for_playback_complete: bool = False,
    orchestrration_id: str | None = "orch-1",
):
    st = type(
        "SessionStateStub",
        (),
        {
            "client_uid": client_uid,
            "current_turn_id": current_turn_id,
            "waiting_for_playback_complete": waiting_for_playback_complete,
            "current_orchestration_id": orchestrration_id,
        },
    )()
    st.mark_playback_complete = lambda: setattr(st, "waiting_for_playback_complete", False)
    return st


def _load_module(install_fake_astrbot, monkeypatch):
    _install_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.runtime.turn_coordinator"
    )
    return module.TurnCoordinator


# ── close_turn_output_queue ────────────────────────────────────────

def test_close_turn_output_queue_sends_synth_finished(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = _create_session_state_stub(current_turn_id="turn-1")

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json

    asyncio.run(coordinator.close_turn_output_queue())

    assert len(sent_payloads) == 1
    assert sent_payloads[0].get("type") == "control.synth_finished"
    assert sent_payloads[0].get("turn_id") == "turn-1"


def test_close_turn_output_queue_skips_when_no_turn_id(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = _create_session_state_stub(current_turn_id=None)

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json

    asyncio.run(coordinator.close_turn_output_queue())
    assert len(sent_payloads) == 0


def test_close_turn_output_queue_is_idempotent_via_mark_flag(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    closed: list[bool] = [False]
    st = _create_session_state_stub(current_turn_id="turn-1")

    def mark_closed() -> bool:
        if closed[0]:
            return False
        closed[0] = True
        return True

    st.mark_output_queue_closed = mark_closed

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json

    asyncio.run(coordinator.close_turn_output_queue())
    assert len(sent_payloads) == 1

    asyncio.run(coordinator.close_turn_output_queue())
    assert len(sent_payloads) == 1


def test_close_turn_output_queue_is_idempotent_via_attr_flag(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(current_turn_id="turn-1")
    st.output_queue_closed = False

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json

    asyncio.run(coordinator.close_turn_output_queue())
    assert len(sent_payloads) == 1
    assert st.output_queue_closed is True

    asyncio.run(coordinator.close_turn_output_queue())
    assert len(sent_payloads) == 1


# ── finalize_turn ───────────────────────────────────────────────────

def test_finalize_turn_sends_turn_finished_and_clears_waiting_flag(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(
        current_turn_id="turn-1",
        waiting_for_playback_complete=True,
    )
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json
    coordinator._current_turn_index = lambda: 0
    coordinator._mark_turn_timing = lambda *args, **kwargs: None
    coordinator._elapsed_ms = lambda *args: 100.0

    asyncio.run(coordinator.finalize_turn(turn_id="turn-1", success=True, reason="ok"))

    assert len(sent_payloads) == 1
    assert sent_payloads[0].get("type") == "control.turn_finished"
    assert sent_payloads[0].get("turn_id") == "turn-1"
    payload = sent_payloads[0].get("payload", {})
    assert isinstance(payload, dict)
    assert payload.get("success") is True
    assert payload.get("reason") == "ok"
    assert st.waiting_for_playback_complete is False


def test_finalize_turn_ignores_when_not_waiting(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(
        current_turn_id="turn-1",
        waiting_for_playback_complete=False,
    )
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json

    asyncio.run(coordinator.finalize_turn(turn_id="turn-1", success=True))
    assert len(sent_payloads) == 0


def test_finalize_turn_ignores_stale_turn_id(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(
        current_turn_id="turn-current",
        waiting_for_playback_complete=True,
    )
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json

    asyncio.run(coordinator.finalize_turn(turn_id="turn-other", success=True))
    assert len(sent_payloads) == 0


# ── handle_msg routes playback_finished ─────────────────────────────

def test_handle_msg_routes_playback_finished_to_finalize_turn(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(
        current_turn_id="turn-1",
        waiting_for_playback_complete=True,
    )
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json
    coordinator._current_turn_index = lambda: 0
    coordinator._mark_turn_timing = lambda *args, **kwargs: None
    coordinator._elapsed_ms = lambda *args: 100.0

    raw_message = {
        "type": "control.playback_finished",
        "version": "v2",
        "message_id": "msg-1",
        "turn_id": "turn-1",
        "source": "frontend",
        "payload": {"success": True, "reason": "text_delivered"},
    }

    asyncio.run(coordinator.handle_msg(raw_message))

    assert len(sent_payloads) == 1
    assert sent_payloads[0].get("type") == "control.turn_finished"
    turn_payload = sent_payloads[0].get("payload", {})
    assert isinstance(turn_payload, dict)
    assert turn_payload.get("success") is True
    assert turn_payload.get("reason") == "text_delivered"


def test_handle_msg_playback_finished_respects_not_waiting(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(
        current_turn_id="turn-1",
        waiting_for_playback_complete=False,
    )
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json

    raw_message = {
        "type": "control.playback_finished",
        "version": "v2",
        "message_id": "msg-2",
        "turn_id": "turn-1",
        "source": "frontend",
        "payload": {"success": True},
    }

    asyncio.run(coordinator.handle_msg(raw_message))
    assert len(sent_payloads) == 0
