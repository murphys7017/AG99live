from __future__ import annotations

import asyncio
import importlib
import json

import pytest


_AXIS_NAMES = [
    "head_yaw",
    "head_roll",
    "head_pitch",
    "body_yaw",
    "body_roll",
    "body_pitch",
    "eye_open_left",
    "eye_open_right",
    "eye_smile_left",
    "eye_smile_right",
    "gaze_x",
    "gaze_y",
    "mouth_smile",
    "mouth_x",
    "brow_bias",
    "brow_left_detail",
    "brow_right_detail",
    "mouth_open",
    "breath",
]


def _build_valid_parameter_plan(mode: str = "expressive") -> dict:
    return {
        "schema_version": "engine.parameter_plan.v2",
        "profile_id": "pet.semantic.v1",
        "profile_revision": 2,
        "model_id": "pet",
        "mode": mode,
        "emotion_label": "test",
        "timing": {
            "duration_ms": 1200,
            "blend_in_ms": 120,
            "hold_ms": 840,
            "blend_out_ms": 240,
        },
        "parameters": [
            {
                "axis_id": "head_yaw",
                "parameter_id": "ParamCheek",
                "target_value": 0.42,
                "weight": 0.36,
                "input_value": 62,
                "source": "semantic_axis",
            }
        ],
    }


def _build_valid_motion_intent(
    mode: str = "expressive",
    *,
    include_mode: bool = True,
) -> dict:
    intent = {
        "schema_version": "engine.motion_intent.v3",
        "profile_id": "pet.semantic.v1",
        "profile_revision": 2,
        "model_id": "pet",
        "intent_tags": ["test", "motion"],
        "resource_id": "",
        "duration_hint_ms": 1200,
        "axes": {
            "head_yaw": 62,
            "mouth_smile": 64,
        },
    }
    if include_mode:
        intent["mode"] = mode
    return intent


def _build_semantic_model_info() -> dict:
    return {
        "selected_model": "pet",
        "models": [
            {
                "name": "pet",
                "semantic_axis_profile": {
                    "schema_version": "ag99.semantic_axis_profile.v2",
                    "profile_id": "pet.semantic.v1",
                    "model_id": "pet",
                    "source_hash": "hash",
                    "last_scanned_hash": "hash",
                    "revision": 2,
                    "status": "user_modified",
                    "user_modified": True,
                    "generated_at": "2026-04-26T00:00:00+00:00",
                    "updated_at": "2026-04-26T00:00:00+00:00",
                    "axes": [
                        {
                            "id": "head_yaw",
                            "label": "Head Yaw",
                            "description": "turn head left/right",
                            "semantic_group": "head",
                            "control_role": "primary",
                            "neutral": 50,
                            "value_range": [0, 100],
                            "soft_range": [42, 58],
                            "strong_range": [30, 70],
                            "positive_semantics": ["turn right"],
                            "negative_semantics": ["turn left"],
                            "usage_notes": "Use for attention direction.",
                            "parameter_bindings": [],
                        },
                        {
                            "id": "debug_tail",
                            "label": "Tail",
                            "description": "debug only",
                            "semantic_group": "debug",
                            "control_role": "debug",
                            "neutral": 50,
                            "value_range": [0, 100],
                            "soft_range": [45, 55],
                            "strong_range": [35, 65],
                            "positive_semantics": ["up"],
                            "negative_semantics": ["down"],
                            "usage_notes": "Do not expose.",
                            "parameter_bindings": [],
                        },
                    ],
                    "couplings": [],
                },
            }
        ],
    }


def _runtime_state_stub(
    *,
    mode: str = "split_after_reply",
    enable_inline_motion_contract: bool = True,
    persona_effect_available: bool = True,
):
    return type(
        "RuntimeStateStub",
        (),
        {
            "motion_generation_mode": mode,
            "enable_inline_motion_contract": enable_inline_motion_contract,
            "ag99live_motion_persona_effect_available": persona_effect_available,
            "model_info": _build_semantic_model_info(),
            "motion_prompt_instruction": "Use readable exaggerated head and smile motion.",
        },
    )()


def _runtime_state_stub_with_motion_tuning_fallback():
    state = _runtime_state_stub(mode="inline_first")
    profile = state.model_info["models"][0]["semantic_axis_profile"]
    profile["axes"].extend(
        [
            {
                "id": "body_yaw",
                "label": "Body Yaw",
                "description": "body turn",
                "semantic_group": "body",
                "control_role": "primary",
                "neutral": 50,
                "value_range": [0, 100],
                "soft_range": [46, 54],
                "strong_range": [38, 62],
                "positive_semantics": ["body right"],
                "negative_semantics": ["body left"],
                "usage_notes": "Use for body posture.",
                "parameter_bindings": [],
            },
            {
                "id": "gaze_x",
                "label": "Gaze X",
                "description": "eye target",
                "semantic_group": "gaze",
                "control_role": "primary",
                "neutral": 50,
                "value_range": [0, 100],
                "soft_range": [44, 56],
                "strong_range": [30, 70],
                "positive_semantics": ["eyes right"],
                "negative_semantics": ["eyes left"],
                "usage_notes": "Use for gaze.",
                "parameter_bindings": [],
            },
            {
                "id": "mouth_smile",
                "label": "Mouth Smile",
                "description": "smile",
                "semantic_group": "mouth",
                "control_role": "hint",
                "neutral": 50,
                "value_range": [0, 100],
                "soft_range": [44, 60],
                "strong_range": [30, 75],
                "positive_semantics": ["smile"],
                "negative_semantics": ["frown"],
                "usage_notes": "Use for mouth detail.",
                "parameter_bindings": [],
            },
        ]
    )
    state.motion_tuning_samples = [
        {
            "id": "body_pose",
            "model_name": "pet",
            "profile_id": "pet.semantic.v1",
            "profile_revision": 2,
            "emotion_label": "happy",
            "enabled_for_llm_reference": True,
            "adjusted_axes": {
                "body_yaw": 66,
                "gaze_x": 64,
                "mouth_smile": 82,
            },
        }
    ]
    return state


async def _noop_async():
    return None


async def _return_true_async():
    return True


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


def test_commit_inbound_message_disables_streaming_in_split_mode(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.runtime_state = _runtime_state_stub(mode="split_after_reply")
    coordinator._turn_lock = asyncio.Lock()
    coordinator._motion_plan_scheduled_turn_ids = set()
    coordinator.turn_identity_map = None

    class SessionStateStub:
        client_uid = "desktop-client"
        current_turn_id = None
        waiting_for_playback_complete = False

        def begin_turn(self, _message_str: str, *, turn_id: str | None = None) -> str:
            self.current_turn_id = turn_id or "turn-split"
            return self.current_turn_id

    coordinator.session_state = SessionStateStub()
    coordinator.chat_buffer = type(
        "ChatBufferStub",
        (),
        {"add": lambda self, role, text: None},
    )()
    coordinator._begin_turn_timing = lambda *_args, **_kwargs: None
    coordinator._mark_turn_timing = lambda *_args, **_kwargs: None
    coordinator._emit_image_input_diagnostics = lambda _message_obj: _noop_async()
    coordinator._send_json = lambda _payload: _return_true_async()

    class EventStub:
        def __init__(self) -> None:
            self.message_str = "hello"
            self.extras: dict[str, object] = {}

        def set_extra(self, key: str, value: object) -> None:
            self.extras[key] = value

    event = EventStub()
    coordinator._build_platform_event = lambda _message_obj: event
    committed: list[object] = []
    coordinator._commit_event = lambda committed_event: committed.append(committed_event)

    message_obj = type("MessageObjectStub", (), {"message_str": "hello"})()
    asyncio.run(coordinator._commit_inbound_message(message_obj, turn_id="turn-split"))

    assert committed == [event]
    assert event.message_str == "hello"
    assert event.extras["enable_streaming"] is False
    assert event.extras["ag99live_motion_generation_mode"] == "single_response_effect"
    assert "ag99live_inline_motion_contract_applied" not in event.extras


def test_submit_system_text_input_commits_remote_operator_metadata(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.runtime_state = _runtime_state_stub(mode="split_after_reply")
    coordinator._turn_lock = asyncio.Lock()
    coordinator.turn_identity_map = None

    class SessionStateStub:
        client_uid = "desktop-client"
        current_turn_id = None
        waiting_for_playback_complete = False

        def begin_turn(self, _message_str: str, *, turn_id: str | None = None) -> str:
            self.current_turn_id = turn_id or "turn-system"
            return self.current_turn_id

    coordinator.session_state = SessionStateStub()
    coordinator.chat_buffer = type(
        "ChatBufferStub",
        (),
        {"add": lambda self, role, text: None},
    )()
    coordinator._begin_turn_timing = lambda *_args, **_kwargs: None
    coordinator._mark_turn_timing = lambda *_args, **_kwargs: None
    coordinator._emit_image_input_diagnostics = lambda _message_obj: _noop_async()
    coordinator._send_json = lambda _payload: _return_true_async()

    class EventStub:
        def __init__(self, message_str: str) -> None:
            self.message_str = message_str
            self.extras: dict[str, object] = {}

        def set_extra(self, key: str, value: object) -> None:
            self.extras[key] = value

    events: list[EventStub] = []

    def build_event(message_obj):
        event = EventStub(message_obj.message_str)
        events.append(event)
        return event

    coordinator._build_platform_event = build_event
    committed: list[object] = []
    coordinator._commit_event = lambda committed_event: committed.append(committed_event)

    class MessageFactoryStub:
        def build_message_object(self, *, text, raw_message, images=None):
            return type(
                "MessageObjectStub",
                (),
                {
                    "message_str": text,
                    "message_id": raw_message["message_id"],
                    "raw_message": raw_message,
                },
            )()

    coordinator._build_message_object = MessageFactoryStub().build_message_object

    asyncio.run(
        coordinator.submit_system_text_input(
            "[系统级输入：远程执行器结果]\n执行状态：completed",
            {
                "ag99live_input_source": "remote_operator_result",
                "remote_operator": {"computer": "work", "status": "completed"},
            },
        )
    )

    assert len(committed) == 1
    event = committed[0]
    assert event.message_str.startswith("[系统级输入：远程执行器结果]")
    assert event.extras["ag99live_input_source"] == "remote_operator_result"
    assert event.extras["remote_operator"]["computer"] == "work"


def test_emit_message_chain_ignores_inline_anim_when_persona_effect_is_available(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator
    Plain = module.Plain

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.runtime_state = _runtime_state_stub(
        mode="split_after_reply",
        persona_effect_available=True,
    )
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

    def fake_schedule_motion_after_reply(
        *,
        assistant_text: str,
        origin_turn_id: str | None = None,
        source: str = "reply_final",
    ):
        del source
        scheduled["reply_text"] = assistant_text
        scheduled["origin_turn_id"] = origin_turn_id
        return True

    coordinator.schedule_motion_after_reply = fake_schedule_motion_after_reply

    inline_broadcast: dict[str, object] = {}

    async def fake_broadcast_motion_payload(**kwargs):
        inline_broadcast.update(kwargs)
        return True

    coordinator.broadcast_motion_payload = fake_broadcast_motion_payload

    async def fake_finish_turn(*, success: bool, reason: str | None):
        del success
        del reason

    coordinator._finish_turn = fake_finish_turn
    tag_payload = json.dumps(
        {"mode": "inline", "intent": _build_valid_motion_intent(include_mode=False)},
        separators=(",", ":"),
    )

    asyncio.run(
        coordinator.emit_message_chain(
            message_chain=[
                Plain(f"hello <@anim {tag_payload}> world")
            ],
            platform_extras={"logical_message_id": "standard_reply"},
        )
    )
    coordinator._flushed_output_segment_count = 0
    asyncio.run(coordinator._flush_pending_output_segments())

    assert inline_broadcast == {}
    assert "reply_text" not in scheduled
    assert [item.get("type") for item in sent_payloads] == ["output.segment"]
    output_payload = sent_payloads[0]["payload"]
    assert output_payload["motion"]["state"] == "absent"
    output_text = str(output_payload["text"]["content"]).lower()
    assert "<@anim" not in output_text
    assert "hello" in output_text
    assert "world" in output_text


def test_emit_message_chain_dispatches_official_inline_anim_when_persona_effect_unavailable(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator
    Plain = module.Plain

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.runtime_state = _runtime_state_stub(
        mode="split_after_reply",
        persona_effect_available=False,
    )
    coordinator.session_state = type(
        "SessionStateStub",
        (),
        {
            "client_uid": "desktop-client",
            "current_turn_id": "turn-inline-compat",
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

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json

    inline_broadcast: dict[str, object] = {}

    async def fake_broadcast_motion_payload(**kwargs):
        inline_broadcast.update(kwargs)
        return True

    coordinator.broadcast_motion_payload = fake_broadcast_motion_payload

    async def fake_finish_turn(*, success: bool, reason: str | None):
        del success
        del reason

    coordinator._finish_turn = fake_finish_turn
    tag_payload = json.dumps(
        {"mode": "inline", "intent": _build_valid_motion_intent(include_mode=False)},
        separators=(",", ":"),
    )

    asyncio.run(
        coordinator.emit_message_chain(
            message_chain=[Plain("hello world")],
            raw_reply_text_override=f"hello <@anim {tag_payload}> world",
            platform_extras={"logical_message_id": "standard_reply"},
        )
    )
    coordinator._flushed_output_segment_count = 0
    asyncio.run(coordinator._flush_pending_output_segments())

    assert inline_broadcast == {}
    assert [item.get("type") for item in sent_payloads] == ["output.segment"]
    output_payload = sent_payloads[0]["payload"]
    motion_slot = output_payload["motion"]
    assert motion_slot["mode"] == "preview"
    assert motion_slot["source"] == "official_inline_anim_compat"
    motion_payload = motion_slot["payload"]
    assert motion_payload["schema_version"] == "engine.motion_intent.v3"
    assert motion_payload["mode"] == "expressive"
    assert motion_payload["axes"] == {"head_yaw": 62.0, "mouth_smile": 64.0}

    output_text = str(output_payload["text"]["content"])
    assert "<@anim" not in output_text.lower()
    assert "hello" in output_text.lower()
    assert "world" in output_text.lower()


def test_emit_message_chain_reuses_platform_visible_message_id_for_segment_outputs(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator
    Plain = module.Plain
    Record = module.Record

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.runtime_state = _runtime_state_stub(mode="inline_first")
    coordinator.session_state = type(
        "SessionStateStub",
        (),
        {
            "client_uid": "desktop-client",
            "current_turn_id": "turn-segment",
            "last_user_text": "user text",
            "mark_synthesizing": lambda self: None,
            "mark_playing": lambda self: None,
        },
    )()

    class ChatBufferStub:
        def add(self, role: str, text: str) -> None:
            del role
            del text

    class MediaServiceStub:
        def cache_audio_file(self, path: str):
            return path, "/cache/audio.wav"

    coordinator.chat_buffer = ChatBufferStub()
    coordinator.media_service = MediaServiceStub()
    coordinator.speaker_name = "assistant"
    coordinator._mark_turn_timing = lambda *_args, **_kwargs: None

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json
    coordinator.schedule_motion_after_reply = lambda **_kwargs: (_ for _ in ()).throw(
        AssertionError("platform motion client object should satisfy inline motion")
    )

    asyncio.run(
        coordinator.emit_message_chain(
            message_chain=[Plain("hello"), Record(file="voice.wav")],
            platform_extras={
                "visible_message_id": "visible-msg-1",
                "client_objects": [
                    {
                        "type": "ag99live.motion_payload",
                        "motion_payload": _build_valid_motion_intent(),
                        "mode": "preview",
                        "source": "persona_effect",
                    }
                ],
            },
        )
    )
    coordinator._flushed_output_segment_count = 0
    asyncio.run(coordinator._flush_pending_output_segments())

    assert [item.get("type") for item in sent_payloads] == ["output.segment"]
    output_segment = sent_payloads[0]
    assert output_segment["message_id"] == "visible-msg-1"
    assert output_segment["turn_id"] == "turn-segment"
    assert output_segment["payload"]["text"]["state"] == "present"
    assert output_segment["payload"]["audio"]["state"] == "present"
    assert output_segment["payload"]["motion"]["state"] == "present"


def test_emit_message_chain_uses_record_text_as_canonical_segment_text(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator
    Record = module.Record

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.runtime_state = _runtime_state_stub(mode="split_after_reply")
    coordinator.session_state = type(
        "SessionStateStub",
        (),
        {
            "client_uid": "desktop-client",
            "current_turn_id": "turn-record",
            "last_user_text": "user text",
            "mark_synthesizing": lambda self: None,
            "mark_playing": lambda self: None,
        },
    )()

    class ChatBufferStub:
        def add(self, role: str, text: str) -> None:
            del role
            del text

    class MediaServiceStub:
        def cache_audio_file(self, path: str):
            return path, "/cache/audio.wav"

    coordinator.chat_buffer = ChatBufferStub()
    coordinator.media_service = MediaServiceStub()
    coordinator.speaker_name = "assistant"
    coordinator._mark_turn_timing = lambda *_args, **_kwargs: None

    sent_payloads: list[dict[str, object]] = []
    recorded_events: list[dict[str, object]] = []
    curve_contexts: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json
    coordinator._record_motion_lab_raw_event = lambda **kwargs: recorded_events.append(kwargs)
    coordinator._start_performance_curve_request = lambda **_kwargs: curve_contexts.append(
        dict(coordinator._current_performance_curve_context)
    )

    asyncio.run(
        coordinator.emit_message_chain(
            message_chain=[Record(file="voice.wav", text="字幕文本")],
            platform_extras={"visible_message_id": "visible-audio-1"},
        )
    )
    coordinator._flushed_output_segment_count = 0
    asyncio.run(coordinator._flush_pending_output_segments())

    assert [payload.get("type") for payload in sent_payloads] == ["output.segment"]
    segment_payload = sent_payloads[0]["payload"]
    assert segment_payload["text"] == {
        "state": "present",
        "content": "字幕文本",
    }
    audio_payload = segment_payload["audio"]
    assert audio_payload == {
        "state": "present",
        "url": "/cache/audio.wav",
    }
    assert sent_payloads[0]["message_id"] == "visible-audio-1"
    assert recorded_events[0]["assistant_text"] == "字幕文本"
    assert recorded_events[0]["raw"]["reply_text"] == "字幕文本"
    assert curve_contexts == []


def test_emit_message_chain_rejects_conflicting_canonical_text_sources(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator
    Plain = module.Plain
    Record = module.Record

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = type(
        "SessionStateStub",
        (),
        {"current_turn_id": "turn-conflicting-text"},
    )()
    coordinator._mark_turn_timing = lambda *_args, **_kwargs: None

    with pytest.raises(ValueError, match="output_segment_canonical_text_conflict"):
        asyncio.run(
            coordinator.emit_message_chain(
                message_chain=[
                    Plain("visible text"),
                    Record(file="voice.wav", text="different spoken text"),
                ],
                platform_extras={"visible_message_id": "visible-conflict-1"},
            )
        )


def test_emit_message_chain_dedupes_motion_client_object_for_segmented_output(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator
    Plain = module.Plain

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.runtime_state = _runtime_state_stub(mode="split_after_reply")
    coordinator.session_state = type(
        "SessionStateStub",
        (),
        {
            "client_uid": "desktop-client",
            "current_turn_id": "turn-segmented",
            "last_user_text": "user text",
            "mark_playing": lambda self: None,
        },
    )()

    class ChatBufferStub:
        def add(self, role: str, text: str) -> None:
            del role
            del text

    coordinator.chat_buffer = ChatBufferStub()
    coordinator.speaker_name = "assistant"
    coordinator._mark_turn_timing = lambda *_args, **_kwargs: None

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json
    motion_client_object = {
        "type": "ag99live.motion_payload",
        "motion_payload": _build_valid_motion_intent(),
        "mode": "preview",
        "source": "persona_effect",
    }

    async def emit_segment(message_id: str) -> None:
        await coordinator.emit_message_chain(
            message_chain=[Plain("hello")],
            platform_extras={
                "visible_message_id": message_id,
                "message_kind": "core_reply",
                "semantic_text": "hello",
                "client_objects": [motion_client_object],
            },
        )

    asyncio.run(emit_segment("visible-msg::core_reply::0001"))
    asyncio.run(emit_segment("visible-msg::core_reply::0002"))
    coordinator._flushed_output_segment_count = 0
    asyncio.run(coordinator._flush_pending_output_segments())

    assert [payload.get("type") for payload in sent_payloads] == ["output.segment"]
    assert sent_payloads[0]["message_id"] == "visible-msg::core_reply"
    assert sent_payloads[0]["payload"]["motion"]["state"] == "present"


@pytest.mark.parametrize("first_part", ["motion", "text"])
def test_performance_curve_request_waits_for_text_and_motion_in_any_order(
    install_fake_astrbot,
    monkeypatch,
    first_part: str,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator
    Plain = module.Plain

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.runtime_state = _runtime_state_stub(mode="split_after_reply")
    coordinator.runtime_state.enable_performance_curve = True
    coordinator.session_state = type(
        "SessionStateStub",
        (),
        {"current_turn_id": "turn-curve-order"},
    )()
    coordinator._mark_turn_timing = lambda *_args, **_kwargs: None
    coordinator._motion_lab_chat_context = lambda: []
    contexts: list[dict[str, object]] = []

    def start_curve(**_kwargs) -> bool:
        contexts.append(dict(coordinator._current_performance_curve_context))
        return True

    coordinator._start_performance_curve_request = start_curve
    motion_extras = {
        "visible_message_id": "visible-curve::core_reply::0001",
        "message_kind": "core_reply",
        "client_objects": [
            {
                "type": "ag99live.motion_payload",
                "motion_payload": _build_valid_motion_intent(),
                "mode": "preview",
                "source": "persona_effect",
            }
        ],
    }
    text_extras = {
        "visible_message_id": "visible-curve::core_reply::0002",
        "message_kind": "core_reply",
        "semantic_text": "canonical reply",
    }

    async def emit_parts() -> None:
        if first_part == "motion":
            await coordinator.emit_message_chain(message_chain=[], platform_extras=motion_extras)
            assert contexts == []
            await coordinator.emit_message_chain(
                message_chain=[Plain("canonical reply")],
                platform_extras=text_extras,
            )
        else:
            await coordinator.emit_message_chain(
                message_chain=[Plain("canonical reply")],
                platform_extras=text_extras,
            )
            assert contexts == []
            await coordinator.emit_message_chain(message_chain=[], platform_extras=motion_extras)

    asyncio.run(emit_parts())

    assert len(contexts) == 1
    assert contexts[0]["assistant_text"] == "canonical reply"
    segment = coordinator._get_pending_output_segment(
        "turn-curve-order",
        "visible-curve::core_reply",
    )
    assert segment.curve_request_state == "started"


def test_emit_message_chain_treats_inline_payload_as_visible_text_only_when_persona_effect_available(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator
    Plain = module.Plain

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.runtime_state = _runtime_state_stub(
        mode="split_after_reply",
        persona_effect_available=True,
    )
    coordinator.session_state = type(
        "SessionStateStub",
        (),
        {
            "client_uid": "desktop-client",
            "current_turn_id": "turn-split",
            "last_user_text": "user text",
        },
    )()

    class ChatBufferStub:
        def add(self, role: str, text: str) -> None:
            del role
            del text

    coordinator.chat_buffer = ChatBufferStub()
    coordinator.speaker_name = "assistant"
    coordinator._mark_turn_timing = lambda *_args, **_kwargs: None

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json
    coordinator.schedule_motion_after_reply = lambda **_kwargs: (_ for _ in ()).throw(
        AssertionError("split mode scheduling belongs to on_llm_response")
    )

    inline_broadcast: dict[str, object] = {}

    async def fake_broadcast_motion_payload(**kwargs):
        inline_broadcast.update(kwargs)
        return True

    coordinator.broadcast_motion_payload = fake_broadcast_motion_payload

    async def fake_finish_turn(*, success: bool, reason: str | None):
        del success
        del reason

    coordinator._finish_turn = fake_finish_turn
    tag_payload = json.dumps(
        {"mode": "inline", "intent": _build_valid_motion_intent(include_mode=False)},
        separators=(",", ":"),
    )

    asyncio.run(
        coordinator.emit_message_chain(
            message_chain=[Plain(f"hello <@anim {tag_payload}> world")],
            platform_extras={"logical_message_id": "standard_reply"},
        )
    )
    coordinator._flushed_output_segment_count = 0
    asyncio.run(coordinator._flush_pending_output_segments())

    assert inline_broadcast == {}
    assert [item.get("type") for item in sent_payloads] == ["output.segment"]
    output_text = str(sent_payloads[0]["payload"]["text"]["content"])
    assert "<@anim" not in output_text.lower()
    assert "hello" in output_text.lower()
    assert "world" in output_text.lower()


def test_build_engine_motion_preview_uses_preview_envelope() -> None:
    builder = importlib.import_module("astrbot_plugin_ag99live_adapter.protocol.builder")

    envelope = builder.build_engine_motion_preview(
        motion_payload=_build_valid_motion_intent(),
        motion_type="engine.motion_intent",
        mode="preview",
        source="test.debug",
    )

    assert envelope["type"] == "engine.motion_preview"
    assert envelope["turn_id"] is None
    assert envelope["payload"]["motion_type"] == "engine.motion_intent"
    assert "intent" in envelope["payload"]


def test_handle_engine_motion_payload_preview_rejects_missing_intent_key(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = type("SessionStateStub", (), {"client_uid": "desktop-client"})()

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json

    message = type(
        "InboundMessageStub",
        (),
        {
            "type": "engine.motion_intent",
            "payload": {"mode": "preview", "plan": _build_valid_motion_intent()},
            "turn_id": "turn-preview",
            "session_id": "desktop-client",
        },
    )()

    asyncio.run(coordinator._handle_engine_motion_payload_preview(message))

    assert sent_payloads
    assert sent_payloads[0]["type"] == "control.error"
    assert "missing_intent_object" in str(sent_payloads[0]["payload"]["message"])


def test_handle_msg_accepts_motion_intent_preview_without_turn_id(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    constants = importlib.import_module("astrbot_plugin_ag99live_adapter.protocol.constants")
    TurnCoordinator = module.TurnCoordinator

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = type("SessionStateStub", (), {"client_uid": "desktop-client"})()
    handled_messages = []

    async def fake_handle_preview(message):
        handled_messages.append(message)

    coordinator._handle_frontend_system = _noop_async
    coordinator._handle_engine_motion_payload_preview = fake_handle_preview

    asyncio.run(
        coordinator.handle_msg(
            {
                "type": constants.TYPE_ENGINE_MOTION_INTENT,
                "version": constants.PROTOCOL_VERSION,
                "message_id": "message-preview",
                "turn_id": None,
                "source": constants.SOURCE_FRONTEND,
                "payload": {
                    "mode": "preview",
                    "intent": _build_valid_motion_intent(),
                },
            }
        )
    )

    assert len(handled_messages) == 1
    assert handled_messages[0].turn_id is None


def test_emit_message_chain_raw_reply_text_override_uses_official_inline_anim_compat(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator
    Plain = module.Plain

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.runtime_state = _runtime_state_stub(
        mode="split_after_reply",
        persona_effect_available=False,
    )
    coordinator.session_state = type(
        "SessionStateStub",
        (),
        {
            "client_uid": "desktop-client",
            "current_turn_id": "turn-inline-override",
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

    inline_broadcast: dict[str, object] = {}

    async def fake_broadcast_motion_payload(**kwargs):
        inline_broadcast.update(kwargs)
        return True

    coordinator.broadcast_motion_payload = fake_broadcast_motion_payload

    async def fake_finish_turn(*, success: bool, reason: str | None):
        del success
        del reason

    coordinator._finish_turn = fake_finish_turn
    tag_payload = json.dumps(
        {"mode": "inline", "intent": _build_valid_motion_intent(include_mode=False)},
        separators=(",", ":"),
    )
    raw_reply_text = f"hello <@anim {tag_payload}> world"

    asyncio.run(
        coordinator.emit_message_chain(
            message_chain=[Plain("hello world")],
            raw_reply_text_override=raw_reply_text,
            platform_extras={"logical_message_id": "standard_reply"},
        )
    )
    coordinator._flushed_output_segment_count = 0
    asyncio.run(coordinator._flush_pending_output_segments())

    assert inline_broadcast == {}
    assert [item.get("type") for item in sent_payloads] == ["output.segment"]
    segment_payload = sent_payloads[0]["payload"]
    assert segment_payload["motion"]["source"] == "official_inline_anim_compat"
    assert segment_payload["motion"]["payload"]["schema_version"] == "engine.motion_intent.v3"
    output_text = str(segment_payload["text"]["content"])
    assert "<@anim" not in output_text.lower()
    assert "hello" in output_text.lower()
    assert "world" in output_text.lower()


def test_emit_message_chain_inline_invalid_v3_intent_does_not_broadcast_replacement(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator
    Plain = module.Plain

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.runtime_state = _runtime_state_stub(
        mode="split_after_reply",
        persona_effect_available=False,
    )
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

    async def fake_send_json(*_args, **_kwargs):
        return True

    coordinator._send_json = fake_send_json
    inline_broadcast: dict[str, object] = {}

    async def fake_broadcast_motion_payload(**kwargs):
        inline_broadcast.update(kwargs)
        return True

    coordinator.broadcast_motion_payload = fake_broadcast_motion_payload

    invalid_intent = _build_valid_motion_intent(include_mode=False)
    invalid_intent["intent_tags"] = []
    tag_payload = json.dumps(
        {"mode": "inline", "intent": invalid_intent},
        separators=(",", ":"),
    )
    raw_reply_text = f"hello <@anim {tag_payload}> world"

    with pytest.raises(ValueError, match="official_inline_anim_compat_rejected"):
        asyncio.run(
            coordinator.emit_message_chain(
                message_chain=[Plain("hello world")],
                raw_reply_text_override=raw_reply_text,
                platform_extras={"logical_message_id": "standard_reply"},
            )
        )

    assert inline_broadcast == {}


def test_emit_message_chain_inline_v1_intent_is_rejected(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator
    Plain = module.Plain

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.runtime_state = _runtime_state_stub(
        mode="split_after_reply",
        persona_effect_available=False,
    )
    coordinator.session_state = type(
        "SessionStateStub",
        (),
        {
            "client_uid": "desktop-client",
            "current_turn_id": "turn-inline-partial",
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

    async def fake_send_json(*_args, **_kwargs):
        return True

    coordinator._send_json = fake_send_json
    coordinator.schedule_motion_after_reply = lambda **_kwargs: True

    inline_broadcast: dict[str, object] = {}

    async def fake_broadcast_motion_payload(**kwargs):
        inline_broadcast.update(kwargs)
        return True

    coordinator.broadcast_motion_payload = fake_broadcast_motion_payload

    async def fake_finish_turn(*, success: bool, reason: str | None):
        del success
        del reason

    coordinator._finish_turn = fake_finish_turn

    partial_intent = {
        "schema_version": "engine.motion_intent.v1",
        "mode": "expressive",
        "emotion_label": "curious",
        "duration_hint_ms": 900,
        "key_axes": {
            "head_yaw": {"value": 72},
        },
    }
    raw_reply_text = "hello\n<@anim " + json.dumps(
        {"mode": "inline", "intent": partial_intent},
        separators=(",", ":"),
    ) + ">"

    with pytest.raises(ValueError, match="official_inline_anim_compat_rejected"):
        asyncio.run(
            coordinator.emit_message_chain(
                message_chain=[Plain("hello")],
                raw_reply_text_override=raw_reply_text,
                platform_extras={"logical_message_id": "standard_reply"},
            )
        )

    assert inline_broadcast == {}


def test_handle_msg_emits_control_error_for_unhandled_allowed_message_type(
    install_fake_astrbot,
    monkeypatch,
) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    constants = importlib.import_module("astrbot_plugin_ag99live_adapter.protocol.constants")
    TurnCoordinator = module.TurnCoordinator

    monkeypatch.setattr(
        constants,
        "INBOUND_ALLOWED_TYPES",
        set(constants.INBOUND_ALLOWED_TYPES) | {constants.TYPE_OUTPUT_SEGMENT},
    )
    parser_module = importlib.import_module("astrbot_plugin_ag99live_adapter.protocol.parser")
    monkeypatch.setattr(
        parser_module,
        "INBOUND_ALLOWED_TYPES",
        set(parser_module.INBOUND_ALLOWED_TYPES) | {constants.TYPE_OUTPUT_SEGMENT},
    )

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.session_state = type("SessionStateStub", (), {"client_uid": "desktop-client"})()

    sent_payloads: list[dict[str, object]] = []

    async def fake_send_json(payload):
        sent_payloads.append(payload)
        return True

    coordinator._send_json = fake_send_json
    coordinator._handle_frontend_system = _noop_async
    coordinator.finalize_turn = _noop_async
    coordinator._handle_interrupt_signal = _noop_async
    coordinator._commit_inbound_message = _noop_async
    coordinator._handle_engine_motion_payload_preview = _noop_async
    coordinator.speech_ingress = type(
        "SpeechIngressStub",
        (),
        {
            "handle_audio_stream_start": _noop_async,
            "handle_audio_stream_chunk": _noop_async,
            "handle_audio_stream_end": _noop_async,
            "handle_audio_data": _noop_async,
            "handle_raw_audio_data": _noop_async,
        },
    )()
    coordinator._handle_audio_end = _noop_async
    coordinator._convert_message = lambda raw: raw

    asyncio.run(
        coordinator.handle_msg(
                {
                    "type": constants.TYPE_OUTPUT_SEGMENT,
                    "version": constants.PROTOCOL_VERSION,
                    "message_id": "message-unhandled",
                    "turn_id": "turn-unhandled",
                    "source": constants.SOURCE_FRONTEND,
                    "payload": {},
                }
        )
    )

    assert sent_payloads
    payload = sent_payloads[0]
    assert payload["type"] == constants.TYPE_CONTROL_ERROR
    assert payload["turn_id"] == "turn-unhandled"
    assert "Unhandled message type" in str(payload["payload"]["message"])


def test_handle_binary_msg_commits_vad_message(install_fake_astrbot, monkeypatch) -> None:
    _install_turn_coordinator_astrbot_stubs(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.runtime.turn_coordinator")
    TurnCoordinator = module.TurnCoordinator

    committed: list[tuple[object, str | None]] = []
    message_obj = object()

    class SpeechIngressStub:
        async def handle_audio_stream_binary_chunk(self, frame):
            assert frame.stream_id == "mic:manual"
            return message_obj

    async def commit_inbound_message(message, *, turn_id=None):
        committed.append((message, turn_id))

    coordinator = TurnCoordinator.__new__(TurnCoordinator)
    coordinator.speech_ingress = SpeechIngressStub()
    coordinator._commit_inbound_message = commit_inbound_message

    metadata = {
        "stream_id": "mic:manual",
        "turn_id": "input:manual-binary",
        "seq": 0,
        "encoding": "pcm16le",
        "sample_rate": 16000,
        "channels": 1,
        "capture_mode": "manual",
    }
    metadata_bytes = json.dumps(metadata).encode("utf-8")
    raw_frame = (
        b"AG99"
        + bytes([1, 1, 0, 0])
        + len(metadata_bytes).to_bytes(4, "little")
        + metadata_bytes
        + b"\x00\x00\x01\x00"
    )

    asyncio.run(coordinator.handle_binary_msg(raw_frame))

    assert committed == [(message_obj, "input:manual-binary")]

