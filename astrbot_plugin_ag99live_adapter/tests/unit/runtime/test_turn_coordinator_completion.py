from __future__ import annotations

import asyncio
import importlib
import sys
import types

import pytest


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
):
    st = type(
        "SessionStateStub",
        (),
        {
            "client_uid": client_uid,
            "current_turn_id": current_turn_id,
            "waiting_for_playback_complete": waiting_for_playback_complete,
        },
    )()
    st.mark_playback_complete = lambda: setattr(st, "waiting_for_playback_complete", False)
    st.output_queue_closing_turn_id = None
    st.output_queue_closed = False

    def begin_output_queue_close(turn_id: str) -> bool:
        if turn_id != st.current_turn_id:
            raise RuntimeError("output_queue_close_turn_mismatch")
        if st.output_queue_closing_turn_id is not None or st.output_queue_closed:
            return False
        st.output_queue_closing_turn_id = turn_id
        return True

    def complete_output_queue_close(turn_id: str) -> None:
        if st.output_queue_closing_turn_id != turn_id or st.current_turn_id != turn_id:
            raise RuntimeError("output_queue_close_turn_mismatch")
        st.output_queue_closing_turn_id = None
        st.output_queue_closed = True

    st.begin_output_queue_close = begin_output_queue_close
    st.complete_output_queue_close = complete_output_queue_close
    st.abort_output_queue_close = lambda turn_id: (
        setattr(st, "output_queue_closing_turn_id", None)
        if st.output_queue_closing_turn_id == turn_id
        else None
    )
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
    cancelled_curve_turns: list[str] = []
    coordinator.runtime_state = types.SimpleNamespace(
        performance_curve_runtime=types.SimpleNamespace(
            cancel_turn=lambda turn_id: cancelled_curve_turns.append(turn_id)
        )
    )

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json
    coordinator._flushed_output_segment_count = 1

    asyncio.run(coordinator.close_turn_output_queue())

    assert len(sent_payloads) == 1
    assert sent_payloads[0].get("type") == "control.synth_finished"
    assert sent_payloads[0].get("turn_id") == "turn-1"
    assert cancelled_curve_turns == ["turn-1"]


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


def test_close_turn_output_queue_is_idempotent(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(current_turn_id="turn-1")

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json
    coordinator._flushed_output_segment_count = 1

    asyncio.run(coordinator.close_turn_output_queue())
    assert len(sent_payloads) == 1

    asyncio.run(coordinator.close_turn_output_queue())
    assert len(sent_payloads) == 1


def test_close_turn_output_queue_send_failure_keeps_queue_open(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(current_turn_id="turn-1")
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st

    async def fake_send_json(payload):
        del payload
        return False

    coordinator._send_json = fake_send_json
    coordinator._flushed_output_segment_count = 1

    with pytest.raises(RuntimeError, match="synth_finished_send_failed"):
        asyncio.run(coordinator.close_turn_output_queue())
    assert st.output_queue_closed is False
    assert st.output_queue_closing_turn_id is None


def test_close_turn_output_queue_rejects_zero_segments(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = _create_session_state_stub(current_turn_id="turn-1")
    coordinator._flushed_output_segment_count = 0

    with pytest.raises(RuntimeError, match="output_segment_missing"):
        asyncio.run(coordinator.close_turn_output_queue())


def test_output_queue_close_ownership_cannot_cross_turns() -> None:
    from astrbot_plugin_ag99live_adapter.runtime.session_state import SessionState

    state = SessionState()
    state.begin_turn("first", turn_id="turn-1")
    assert state.begin_output_queue_close("turn-1") is True

    state.begin_turn("second", turn_id="turn-2")
    state.abort_output_queue_close("turn-1")
    with pytest.raises(RuntimeError, match="output_queue_close_turn_mismatch"):
        state.complete_output_queue_close("turn-1")

    assert state.current_turn_id == "turn-2"
    assert state.output_queue_closed is False
    assert state.output_queue_closing_turn_id is None


def test_emit_message_chain_converts_audio_off_thread(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.runtime.turn_coordinator"
    )
    message_utils = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.runtime.message_utils"
    )
    Record = message_utils.Record
    to_thread_calls: list[tuple[object, tuple[object, ...]]] = []

    async def fake_to_thread(func, *args):
        to_thread_calls.append((func, args))
        return func(*args)

    monkeypatch.setattr(module.asyncio, "to_thread", fake_to_thread)

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.runtime_state = type("RuntimeStateStub", (), {})()
    coordinator.session_state = _create_session_state_stub(current_turn_id="turn-1")
    coordinator._flushed_output_segment_count = 0
    coordinator.chat_buffer = type("ChatBufferStub", (), {"add": lambda self, *_args: None})()
    coordinator.speaker_name = "assistant"
    coordinator._mark_turn_timing = lambda *_args, **_kwargs: None
    coordinator._record_motion_lab_raw_event = lambda **_kwargs: None
    coordinator._motion_lab_chat_context = lambda: {}

    class MediaServiceStub:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def cache_audio_file(self, path: str):
            self.calls.append(path)
            return path, "/cache/audio.wav"

    media_service = MediaServiceStub()
    coordinator.media_service = media_service

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json

    asyncio.run(
        coordinator.emit_message_chain(
            message_chain=[Record(file="voice.wav", text="assistant reply")],
            platform_extras={"logical_message_id": "standard_reply"},
        )
    )
    asyncio.run(coordinator._flush_pending_output_segments())

    assert to_thread_calls
    assert media_service.calls == ["voice.wav"]
    segment = next(
        payload for payload in sent_payloads if payload.get("type") == "output.segment"
    )
    assert segment["payload"]["text"] == {
        "state": "present",
        "content": "assistant reply",
    }
    assert segment["payload"]["audio"]["state"] == "present"


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
