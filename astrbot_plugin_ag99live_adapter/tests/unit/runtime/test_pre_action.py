from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from astrbot_plugin_ag99live_adapter.runtime.pre_action import PreActionRuntime


def make_runtime(provider, sent):
    persona = {
        "prompt": "身份与关系\n- 与某人的关系。\n核心人格\n- 理性、好奇、克制。\n互动反应\n- 被关心时短暂害羞。"
    }

    class Event:
        unified_msg_origin = "aki:FriendMessage:test"

        def __init__(self):
            self.extras = {}

        def get_platform_name(self):
            return "aki"

        def get_extra(self, key, default=None):
            return self.extras.get(key, default)

        def set_extra(self, key, value):
            self.extras[key] = value

    async def current_id(_umo):
        return None

    async def selected(**_kwargs):
        return "test-persona", persona, None, False

    context = SimpleNamespace(
        astrbot_config_mgr=SimpleNamespace(
            resolve_configuration_selection=lambda _umo: SimpleNamespace(
                runtime_config={}
            )
        ),
        conversation_manager=SimpleNamespace(get_curr_conversation_id=current_id),
        persona_manager=SimpleNamespace(
            resolve_selected_persona=selected, get_persona_v3_by_id=lambda _id: persona
        ),
        get_registered_star=lambda _id: None,
    )
    profile = {
        "schema_version": "ag99.semantic_axis_profile.v3",
        "profile_id": "p",
        "model_id": "m",
        "revision": 1,
        "status": "generated",
        "axes": [
            {
                "id": "head_yaw",
                "control_role": "primary",
                "neutral": 0,
                "level_anchors": {"-1": -8, "0": 0, "1": 8},
                "negative_semantics": ["看向一侧"],
                "positive_semantics": ["看向另一侧"],
            }
        ],
    }
    state = SimpleNamespace(
        plugin_context=context,
        plugin_config={},
        independent_motion_enabled=True,
        selected_independent_motion_provider=provider,
        model_info={
            "selected_model": "m",
            "models": [
                {
                    "name": "m",
                    "semantic_axis_profile": profile,
                    "constraints": {"expressions": [], "motions": []},
                }
            ],
        },
    )

    async def send(message):
        await sent.put(message)
        return True

    return PreActionRuntime(runtime_state=state, send_json=send, build_event=Event)


def test_pre_action_emits_before_provider_eof_without_prompt_history():
    async def run():
        sent = asyncio.Queue()
        closed = asyncio.Event()

        class Provider:
            async def text_chat_stream(self, **request):
                payload = json.loads(request["prompt"])
                assert len(payload["user_text"]) == 100
                assert "关系" not in payload["character_core"]
                assert "理性" in payload["character_core"]
                assert "contexts" in request and request["contexts"] is None
                assert set(payload) == {"user_text", "character_core", "available_axes"}
                assert request["max_tokens"] == 128
                try:
                    yield SimpleNamespace(
                        role="assistant",
                        is_chunk=True,
                        completion_text='{"intent_tags":["好奇"],"axis_levels":{"head_yaw":1}}',
                    )
                    await asyncio.Event().wait()
                finally:
                    closed.set()

        runtime = make_runtime(Provider(), sent)
        await runtime.begin("input:test")
        runtime.trigger("用户原话" * 40, "input:test")
        message = await asyncio.wait_for(sent.get(), timeout=2)
        assert message["type"] == "output.pre_action"
        assert message["turn_id"] == "input:test"
        assert message["payload"]["action"] == "ready"
        assert message["payload"]["motion"]["axis_levels"] == {"head_yaw": 1}
        await asyncio.wait_for(closed.wait(), timeout=1)
        await runtime.cancel()

    asyncio.run(run())


def test_new_capture_keeps_ownership_when_old_asr_returns(tmp_path):
    import numpy as np

    from astrbot_plugin_ag99live_adapter.protocol.binary_audio import (
        BinaryAudioChunkFrame,
    )
    from astrbot_plugin_ag99live_adapter.protocol.parser import parse_inbound_message
    from astrbot_plugin_ag99live_adapter.runtime.chat_buffer import ChatBuffer
    from astrbot_plugin_ag99live_adapter.runtime.session_state import SessionState
    from astrbot_plugin_ag99live_adapter.runtime.turn_coordinator import TurnCoordinator
    from astrbot_plugin_ag99live_adapter.runtime.turn_identity_map import (
        TurnIdentityMap,
    )

    async def run():
        sent = asyncio.Queue()
        old_started, release_old = asyncio.Event(), asyncio.Event()

        class Provider:
            async def text_chat_stream(self, **_request):
                yield SimpleNamespace(
                    role="assistant",
                    is_chunk=True,
                    completion_text='{"intent_tags":["好奇"],"axis_levels":{"head_yaw":1}}',
                )

            async def get_text(self, path):
                if path.endswith("1.wav"):
                    old_started.set()
                    await release_old.wait()
                return "看看这里"

        class Media:
            count = 0

            def save_audio_buffer_to_temp_wav(self, _audio, **_kwargs):
                self.count += 1
                path = tmp_path / f"{self.count}.wav"
                path.write_bytes(b"")
                return str(path)

        runtime = make_runtime(Provider(), sent)
        runtime.state.performance_curve_runtime = None
        runtime.state.enable_performance_curve = False
        runtime.state.resolve_stt_provider = lambda: Provider()

        async def noop(*_args):
            pass

        coordinator = TurnCoordinator(
            session_state=SessionState(),
            turn_identity_map=TurnIdentityMap(),
            runtime_state=runtime.state,
            media_service=Media(),
            chat_buffer=ChatBuffer(),
            speaker_name="test",
            convert_message=lambda raw: raw,
            build_message_object=lambda **kwargs: SimpleNamespace(**kwargs),
            handle_frontend_system=noop,
            refresh_runtime_settings=lambda: None,
            send_current_model_and_conf=noop,
            send_json=runtime.send_json,
            build_platform_event=lambda _message: runtime.build_event(),
            commit_event=lambda _event: None,
            create_vad_engine=lambda: None,
        )

        def envelope(kind, turn, payload):
            return {
                "type": kind,
                "version": "v2",
                "source": "frontend",
                "message_id": f"test:{kind}:{turn}",
                "turn_id": turn,
                "payload": payload,
            }

        async def start(turn):
            await coordinator.handle_msg(
                envelope(
                    "input.audio_stream_start",
                    turn,
                    {
                        "stream_id": turn,
                        "source": "web_audio",
                        "encoding": "pcm16le",
                        "sample_rate": 16000,
                        "channels": 1,
                        "capture_mode": "ptt",
                    },
                )
            )
            await coordinator.speech_ingress.handle_audio_stream_binary_chunk(
                BinaryAudioChunkFrame(
                    stream_id=turn,
                    turn_id=turn,
                    seq=0,
                    encoding="pcm16le",
                    sample_rate=16000,
                    channels=1,
                    payload=np.array([8192, -8192], dtype=np.int16).tobytes(),
                    metadata={"capture_mode": "ptt"},
                )
            )

        async def finish_transcription(turn):
            return await coordinator.speech_ingress.handle_audio_stream_end(
                parse_inbound_message(
                    envelope(
                        "input.audio_stream_end",
                        turn,
                        {
                            "stream_id": turn,
                            "last_seq": 0,
                            "capture_mode": "ptt",
                            "reason": "ptt_release",
                        },
                    )
                )
            )

        try:
            await start("input:old")
            await coordinator.handle_msg(
                envelope(
                    "input.audio_stream_seal",
                    "input:old",
                    {
                        "stream_id": "input:old",
                        "last_seq": 0,
                        "capture_mode": "ptt",
                    },
                )
            )
            await asyncio.wait_for(old_started.wait(), timeout=1)
            await start("input:new")
            release_old.set()
            await finish_transcription("input:old")
            await finish_transcription("input:new")
            messages = []
            while True:
                message = await asyncio.wait_for(sent.get(), timeout=2)
                messages.append(message)
                if message.get("payload", {}).get("action") == "ready":
                    break
            assert message["turn_id"] == "input:new"
            assert not any(
                m["turn_id"] == "input:new" and m["payload"].get("action") == "cancel"
                for m in messages
            )
            await coordinator.handle_msg(envelope("control.interrupt", "input:old", {}))
            assert (
                sent.empty()
            )  # No terminal notification for a never-created Core turn.
        finally:
            await coordinator.speech_ingress.handle_audio_stream_interrupt()
            coordinator.reset_turn_tracking()

    asyncio.run(run())


def test_cancelled_input_only_emits_cancel():
    async def run():
        sent = asyncio.Queue()
        started, closed = asyncio.Event(), asyncio.Event()

        class Provider:
            async def text_chat_stream(self, **_request):
                started.set()
                try:
                    await asyncio.Event().wait()
                    yield
                finally:
                    closed.set()

        runtime = make_runtime(Provider(), sent)
        await runtime.begin("input:cancel")
        runtime.trigger("看看这里", "input:cancel")
        await asyncio.wait_for(started.wait(), timeout=2)
        await runtime.cancel("input:cancel")
        await asyncio.wait_for(closed.wait(), timeout=1)
        message = await asyncio.wait_for(sent.get(), timeout=1)
        assert message["payload"]["action"] == "cancel"
        assert sent.empty()

    asyncio.run(run())
