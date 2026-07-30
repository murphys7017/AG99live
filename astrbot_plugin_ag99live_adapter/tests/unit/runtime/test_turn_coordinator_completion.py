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
):
    st = type(
        "SessionStateStub",
        (),
        {
            "client_uid": client_uid,
            "current_turn_id": current_turn_id,
        },
    )()

    def reset_to_idle() -> None:
        st.current_turn_id = None

    st.reset_to_idle = reset_to_idle
    return st


def _load_module(install_fake_astrbot, monkeypatch):
    _install_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.runtime.turn_coordinator"
    )
    return module.TurnCoordinator


def _prepare_turn_finalization(coordinator) -> None:
    coordinator._pending_output_segments = {}
    coordinator._closing_output_turn_ids = set()
    coordinator._closed_output_turn_ids = set()
    coordinator._output_emitted_turn_ids = set()
    coordinator._turn_timings = {}
    coordinator._events_by_turn_id = {}
    coordinator._active_vad_turn_by_capture_turn = {}


def test_reset_turn_tracking_clears_connection_owned_state(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    cancelled_turns: list[str] = []
    coordinator.runtime_state = types.SimpleNamespace(
        performance_curve_runtime=types.SimpleNamespace(
            cancel_turn=lambda turn_id: cancelled_turns.append(turn_id)
        )
    )
    coordinator._turn_timings = {"turn-1": {}}
    coordinator._pending_output_segments = {
        "turn-2|message-1": types.SimpleNamespace(turn_id="turn-2")
    }
    coordinator._closing_output_turn_ids = {"turn-2"}
    coordinator._closed_output_turn_ids = {"turn-1"}
    coordinator._output_emitted_turn_ids = {"turn-1", "turn-2"}
    coordinator._active_vad_turn_by_capture_turn = {"capture-1": "turn-1"}
    coordinator._last_prompt_motion_snapshot = {"turn_id": "turn-1"}
    coordinator._events_by_turn_id = {}

    coordinator.reset_turn_tracking()

    assert set(cancelled_turns) == {"turn-1", "turn-2"}
    assert coordinator._turn_timings == {}
    assert coordinator._pending_output_segments == {}
    assert coordinator._closing_output_turn_ids == set()
    assert coordinator._closed_output_turn_ids == set()
    assert coordinator._output_emitted_turn_ids == set()
    assert coordinator._active_vad_turn_by_capture_turn == {}
    assert coordinator._last_prompt_motion_snapshot is None


# ── proactive output turns ─────────────────────────────

def test_begin_proactive_output_turn_announces_independent_turn(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator._turn_lock = asyncio.Lock()
    coordinator._turn_timings = {}
    coordinator._current_turn_index = lambda: 1
    coordinator.session_state = types.SimpleNamespace(
        current_turn_id=None,
        begin_turn=lambda _text, *, turn_id: turn_id,
    )
    registered_turn_ids: list[str] = []
    coordinator.turn_identity_map = types.SimpleNamespace(
        register_frontend_turn=lambda turn_id: registered_turn_ids.append(turn_id),
    )
    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json

    turn_id = asyncio.run(coordinator.begin_proactive_output_turn())

    assert turn_id.startswith("proactive:")
    assert registered_turn_ids == [turn_id]
    assert len(sent_payloads) == 1
    assert sent_payloads[0]["type"] == "control.turn_started"
    assert sent_payloads[0]["turn_id"] == turn_id
    assert sent_payloads[0]["payload"] == {}


def test_begin_proactive_output_turn_rolls_back_when_frontend_is_unavailable(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator._turn_lock = asyncio.Lock()
    coordinator._turn_timings = {}
    coordinator._current_turn_index = lambda: 1

    class SessionStateStub:
        current_turn_id: str | None = None

        def begin_turn(self, _text: str, *, turn_id: str) -> str:
            self.current_turn_id = turn_id
            return turn_id

        def reset_to_idle(self) -> None:
            self.current_turn_id = None

    registered_turn_ids: list[str] = []
    cleared_turn_ids: list[str] = []
    coordinator.session_state = SessionStateStub()
    coordinator.turn_identity_map = types.SimpleNamespace(
        register_frontend_turn=lambda turn_id: registered_turn_ids.append(turn_id),
        clear_frontend_turn=lambda turn_id: cleared_turn_ids.append(turn_id),
    )

    async def reject_send(_payload):
        return False

    coordinator._send_json = reject_send

    with pytest.raises(RuntimeError, match="turn_started_send_failed:proactive:"):
        asyncio.run(coordinator.begin_proactive_output_turn())

    assert len(registered_turn_ids) == 1
    assert cleared_turn_ids == registered_turn_ids
    assert coordinator.session_state.current_turn_id is None
    assert coordinator._turn_timings == {}


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
    coordinator._closing_output_turn_ids = set()
    coordinator._closed_output_turn_ids = set()
    coordinator._output_emitted_turn_ids = set()

    async def flush_segments(*, turn_id: str) -> int:
        assert turn_id == "turn-1"
        return 1

    coordinator._flush_pending_output_segments = flush_segments

    asyncio.run(coordinator.close_turn_output_queue(turn_id="turn-1"))

    assert len(sent_payloads) == 1
    assert sent_payloads[0].get("type") == "control.synth_finished"
    assert sent_payloads[0].get("turn_id") == "turn-1"
    assert cancelled_curve_turns == ["turn-1"]


def test_close_turn_output_queue_requires_turn_id(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator._closing_output_turn_ids = set()
    coordinator._closed_output_turn_ids = set()
    coordinator._output_emitted_turn_ids = set()

    with pytest.raises(ValueError, match="non-empty turn_id"):
        asyncio.run(coordinator.close_turn_output_queue(turn_id=""))


def test_close_turn_output_queue_is_idempotent(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(current_turn_id="turn-1")

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st
    _prepare_turn_finalization(coordinator)

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json
    coordinator._closing_output_turn_ids = set()
    coordinator._closed_output_turn_ids = set()
    coordinator._output_emitted_turn_ids = set()

    async def flush_segments(*, turn_id: str) -> int:
        assert turn_id == "turn-1"
        return 1

    coordinator._flush_pending_output_segments = flush_segments

    asyncio.run(coordinator.close_turn_output_queue(turn_id="turn-1"))
    assert len(sent_payloads) == 1

    asyncio.run(coordinator.close_turn_output_queue(turn_id="turn-1"))
    assert len(sent_payloads) == 1


def test_close_turn_output_queue_retries_only_synth_finished_after_send_failure(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(current_turn_id="turn-1")
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st

    send_attempts = 0

    async def fake_send_json(payload):
        nonlocal send_attempts
        del payload
        send_attempts += 1
        return send_attempts > 1

    coordinator._send_json = fake_send_json
    coordinator._closing_output_turn_ids = set()
    coordinator._closed_output_turn_ids = set()
    coordinator._output_emitted_turn_ids = set()

    flush_attempts = 0

    async def flush_segments(*, turn_id: str) -> int:
        nonlocal flush_attempts
        assert turn_id == "turn-1"
        flush_attempts += 1
        return 1 if flush_attempts == 1 else 0

    coordinator._flush_pending_output_segments = flush_segments

    with pytest.raises(RuntimeError, match="synth_finished_send_failed"):
        asyncio.run(coordinator.close_turn_output_queue(turn_id="turn-1"))
    assert coordinator._closed_output_turn_ids == set()
    assert coordinator._closing_output_turn_ids == set()

    asyncio.run(coordinator.close_turn_output_queue(turn_id="turn-1"))
    assert send_attempts == 2
    assert flush_attempts == 2
    assert coordinator._closed_output_turn_ids == {"turn-1"}


def test_close_turn_output_queue_rejects_zero_segments(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = _create_session_state_stub(current_turn_id="turn-1")
    coordinator._closing_output_turn_ids = set()
    coordinator._closed_output_turn_ids = set()
    coordinator._output_emitted_turn_ids = set()

    async def flush_segments(*, turn_id: str) -> int:
        assert turn_id == "turn-1"
        return 0

    coordinator._flush_pending_output_segments = flush_segments

    with pytest.raises(RuntimeError, match="output_segment_missing"):
        asyncio.run(coordinator.close_turn_output_queue(turn_id="turn-1"))


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
            turn_id="turn-1",
            platform_extras={"logical_message_id": "standard_reply"},
        )
    )
    asyncio.run(coordinator._flush_pending_output_segments(turn_id="turn-1"))

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

def test_finalize_turn_sends_turn_finished_and_resets_latest_projection(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(current_turn_id="turn-1")
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st
    _prepare_turn_finalization(coordinator)

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
    assert st.current_turn_id is None


def test_finalize_turn_uses_explicit_turn_id(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(current_turn_id="turn-1")
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st
    _prepare_turn_finalization(coordinator)

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json
    coordinator._mark_turn_timing = lambda *args, **kwargs: None
    coordinator._elapsed_ms = lambda *args: 100.0

    asyncio.run(coordinator.finalize_turn(turn_id="turn-1", success=True))
    assert len(sent_payloads) == 1
    assert sent_payloads[0].get("turn_id") == "turn-1"


def test_finalize_older_turn_does_not_reset_latest_turn(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(current_turn_id="turn-current")
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st
    _prepare_turn_finalization(coordinator)

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json
    coordinator._mark_turn_timing = lambda *args, **kwargs: None
    coordinator._elapsed_ms = lambda *args: 100.0

    asyncio.run(coordinator.finalize_turn(turn_id="turn-other", success=True))
    assert len(sent_payloads) == 1
    assert sent_payloads[0].get("turn_id") == "turn-other"
    assert st.current_turn_id == "turn-current"


# ── handle_msg routes playback_finished ─────────────────────────────

def test_handle_msg_routes_playback_finished_to_finalize_turn(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(current_turn_id="turn-1")
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st
    _prepare_turn_finalization(coordinator)

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


def test_handle_msg_playback_finished_uses_explicit_turn_id(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    st = _create_session_state_stub(current_turn_id="turn-1")
    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = st
    _prepare_turn_finalization(coordinator)

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json
    coordinator._mark_turn_timing = lambda *args, **kwargs: None
    coordinator._elapsed_ms = lambda *args: 100.0

    raw_message = {
        "type": "control.playback_finished",
        "version": "v2",
        "message_id": "msg-2",
        "turn_id": "turn-1",
        "source": "frontend",
        "payload": {"success": True},
    }

    asyncio.run(coordinator.handle_msg(raw_message))
    assert len(sent_payloads) == 1
    assert sent_payloads[0].get("turn_id") == "turn-1"


def test_handle_msg_failure_finishes_the_affected_turn(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    TurnCoordinator = _load_module(install_fake_astrbot, monkeypatch)

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = _create_session_state_stub(current_turn_id="turn-1")
    _prepare_turn_finalization(coordinator)
    coordinator._mark_turn_timing = lambda *args, **kwargs: None

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    def fail_conversion(_raw_message):
        raise RuntimeError("conversion failed")

    coordinator._send_json = fake_send_json
    coordinator._convert_message = fail_conversion

    with pytest.raises(RuntimeError, match="conversion failed"):
        asyncio.run(
            coordinator.handle_msg(
                {
                    "type": "input.text",
                    "version": "v2",
                    "message_id": "msg-failed",
                    "turn_id": "turn-1",
                    "source": "frontend",
                    "payload": {"text": "hello"},
                }
            )
        )

    assert len(sent_payloads) == 1
    assert sent_payloads[0].get("type") == "control.turn_finished"
    assert sent_payloads[0].get("turn_id") == "turn-1"
    assert sent_payloads[0].get("payload") == {
        "success": False,
        "reason": "inbound_message_processing_failed:input.text",
    }
    assert coordinator.session_state.current_turn_id is None
