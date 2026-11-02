from __future__ import annotations

import asyncio

import pytest

from astrbot_plugin_ag99live_adapter.adapters.astrbot.provider_bridge import (
    AstrBotAvatarOutputPort,
    AstrBotConversationProvider,
    AstrBotMotionProvider,
    AstrBotSttProvider,
    AstrBotTtsProvider,
    AstrBotProviderBridge,
    ProviderBridgeCallbacks,
    ProviderBridgeError,
)
from astrbot_plugin_ag99live_adapter.adapters.astrbot.capabilities import (
    AstrBotCapabilityBinding,
)
from astrbot_plugin_ag99live_adapter.providers.contracts import (
    AudioArtifact,
    ConversationEvent,
    ConversationEventKind,
    ConversationInput,
    MotionOrigin,
    MotionResult,
    MotionRequest,
    MotionEventKind,
    OutputSegmentEnvelope,
    SegmentBoundary,
    SttResult,
    TtsRequest,
    TtsResult,
    TtsEventKind,
)


def test_conversation_bridge_forwards_requests_and_publishes_events() -> None:
    submitted: list[ConversationInput] = []
    interrupted: list[str | None] = []
    received: list[ConversationEvent] = []

    async def submit(request: ConversationInput) -> None:
        submitted.append(request)

    async def interrupt(turn_id: str | None) -> None:
        interrupted.append(turn_id)

    async def close() -> None:
        return None

    async def run() -> None:
        provider = AstrBotConversationProvider(
            submit_message=submit,
            interrupt=interrupt,
            close=close,
        )
        unsubscribe = provider.subscribe(received.append)
        request = ConversationInput(turn_id="turn-1", text="hello")
        await provider.send_message(request)
        await provider.publish_event(
            ConversationEvent(
                kind=ConversationEventKind.SEGMENT_BOUNDARY,
                turn_id="turn-1",
                provider_event_id="event-1",
                boundary=SegmentBoundary("provider-segment-1"),
            )
        )
        await provider.interrupt("turn-1")
        unsubscribe()
        await provider.close()

    asyncio.run(run())

    assert submitted == [ConversationInput(turn_id="turn-1", text="hello")]
    assert interrupted == ["turn-1"]
    assert [event.provider_event_id for event in received] == ["event-1"]


def test_stt_bridge_keeps_streams_separate_and_notifies_final_listener() -> None:
    recognized: list[tuple[str, bytes]] = []
    finals: list[SttResult] = []

    async def recognize(stream_id, payload, _options):
        recognized.append((stream_id, payload))
        return SttResult(stream_id=stream_id, text=f"text:{stream_id}")

    async def run() -> None:
        provider = AstrBotSttProvider(recognize_audio=recognize)
        provider.on_final(finals.append)
        await provider.start_session("stream-a")
        await provider.start_session("stream-b")
        await provider.push_audio("stream-a", b"a")
        await provider.push_audio("stream-b", b"b")
        assert (await provider.finish_session("stream-b")).text == "text:stream-b"
        assert (await provider.finish_session("stream-a")).text == "text:stream-a"

    asyncio.run(run())

    assert recognized == [("stream-b", b"b"), ("stream-a", b"a")]
    assert [result.stream_id for result in finals] == ["stream-b", "stream-a"]


def test_stt_bridge_rejects_audio_over_its_bound() -> None:
    async def recognize(_stream_id, _payload, _options):
        return "unused"

    async def run() -> None:
        provider = AstrBotSttProvider(
            recognize_audio=recognize,
            max_buffer_bytes=2,
        )
        await provider.start_session("stream-1")
        with pytest.raises(ProviderBridgeError) as error:
            await provider.push_audio("stream-1", b"123")
        assert error.value.failure.code == "stt_buffer_limit_exceeded"

    asyncio.run(run())


def test_tts_and_motion_bridges_normalize_callback_results() -> None:
    async def synthesize(_request):
        return AudioArtifact(
            artifact_id="audio-1",
            uri="/cache/audio/audio-1.wav",
            format="audio/wav",
        )

    async def cancel_tts(_request_id):
        return None

    async def generate(request):
        return {"intent_tags": [request.origin.value]}

    async def cancel_motion(_request_id):
        return None

    async def run() -> tuple[str, MotionOrigin]:
        tts = AstrBotTtsProvider(synthesize=synthesize, cancel=cancel_tts)
        motion = AstrBotMotionProvider(
            generate=generate,
            cancel=cancel_motion,
        )
        tts_result = await tts.synthesize(
            TtsRequest(
                request_id="tts-1",
                turn_id="turn-1",
                message_id="message-1",
                text="hello",
            )
        )
        motion_result = await motion.generate(
            MotionRequest(
                request_id="motion-1",
                origin=MotionOrigin.TURN,
                turn_id="turn-1",
                message_id="message-1",
                text="hello",
            )
        )
        assert tts_result.artifact is not None
        return tts_result.artifact.artifact_id, motion_result.origin

    assert asyncio.run(run()) == ("audio-1", MotionOrigin.TURN)


def test_avatar_output_port_preserves_output_segment_v6_envelope() -> None:
    sent: list[dict] = []

    async def send_json(payload: dict) -> bool:
        sent.append(payload)
        return True

    async def run() -> None:
        port = AstrBotAvatarOutputPort(send_json=send_json)
        await port.publish_segment(
            OutputSegmentEnvelope(
                turn_id="turn-1",
                message_id="message-1",
                sequence=0,
                payload={
                    "text": {"state": "present", "content": "hello"},
                    "audio": {"state": "absent"},
                    "motion": {"state": "absent"},
                    "speech": {"state": "absent"},
                    "images": [],
                    "speaker_name": "AstrBot",
                    "avatar": "",
                },
            )
        )

    asyncio.run(run())

    assert sent == [
        {
            "type": "output.segment",
            "version": "v2",
            "message_id": "message-1",
            "timestamp": sent[0]["timestamp"],
            "turn_id": "turn-1",
            "source": "adapter",
            "payload": {
                "schema_version": "output.segment.v6",
                "sequence": 0,
                "text": {"state": "present", "content": "hello"},
                "audio": {"state": "absent"},
                "motion": {"state": "absent"},
                "speech": {"state": "absent"},
                "images": [],
                "speaker_name": "AstrBot",
                "avatar": "",
            },
        }
    ]


def test_provider_bridge_reuses_the_composition_root_output_port() -> None:
    async def noop_submit(_request):
        return None

    async def noop_interrupt(_turn_id):
        return None

    async def noop_close():
        return None

    async def recognize(_stream_id, _payload, _options):
        return ""

    async def synthesize(_request):
        raise AssertionError("not called")

    async def cancel(_request_id):
        return None

    async def motion(_request):
        raise AssertionError("not called")

    async def send_json(_payload):
        return True

    avatar_output = AstrBotAvatarOutputPort(send_json=send_json)
    bridge = AstrBotProviderBridge.from_callbacks(
        ProviderBridgeCallbacks(
            submit_conversation=noop_submit,
            interrupt_conversation=noop_interrupt,
            close_conversation=noop_close,
            recognize_audio=recognize,
            synthesize_tts=synthesize,
            cancel_tts=cancel,
            generate_motion=motion,
            cancel_motion=cancel,
            send_json=send_json,
        ),
        avatar_output=avatar_output,
    )

    assert bridge.avatar_output is avatar_output


def test_tts_and_motion_bridges_publish_lifecycle_events() -> None:
    tts_events = []
    motion_events = []

    async def synthesize(_request):
        return AudioArtifact(
            artifact_id="audio-1",
            uri="/cache/audio/audio-1.wav",
            format="audio/wav",
        )

    async def generate(_request):
        return {"intent_tags": ["calm"]}

    async def noop(_request_id):
        return None

    async def run() -> None:
        tts = AstrBotTtsProvider(synthesize=synthesize, cancel=noop)
        motion = AstrBotMotionProvider(generate=generate, cancel=noop)
        tts.subscribe(tts_events.append)
        motion.subscribe(motion_events.append)
        await tts.synthesize(
            TtsRequest(
                request_id="tts-1",
                turn_id="turn-1",
                message_id="message-1",
                text="hello",
            )
        )
        await motion.generate(
            MotionRequest(
                request_id="motion-1",
                origin=MotionOrigin.TURN,
                turn_id="turn-1",
                message_id="message-1",
                text="hello",
            )
        )

    asyncio.run(run())

    assert [event.kind for event in tts_events] == [
        TtsEventKind.REQUESTED,
        TtsEventKind.READY,
    ]
    assert [event.kind for event in motion_events] == [
        MotionEventKind.REQUESTED,
        MotionEventKind.READY,
    ]


def test_astrbot_capability_binding_uses_selected_tts_provider() -> None:
    class Tts:
        async def get_audio(self, text: str) -> str:
            assert text == "hello"
            return "C:/cache/hello.wav"

    class Context:
        def get_using_tts_provider(self, *, umo):
            assert umo == "olv_pet_adapter|desktop"
            return Tts()

    class Event:
        unified_msg_origin = "olv_pet_adapter|desktop"

    async def run():
        binding = AstrBotCapabilityBinding(
            plugin_context=Context(),
            recognize_audio=lambda *_args: None,
        )
        return await binding.synthesize_tts(
            TtsRequest(
                request_id="tts-active-1",
                turn_id="turn-1",
                message_id="message-1",
                text="hello",
                metadata={"event": Event()},
            )
        )

    result = asyncio.run(run())
    assert result.uri == "C:/cache/hello.wav"
    assert result.format == "audio/wav"


def test_provider_bridges_reject_cross_request_result_identity() -> None:
    async def run() -> None:
        async def recognize(_stream_id, _payload, _options):
            return SttResult(stream_id="other-stream", text="wrong")

        stt = AstrBotSttProvider(recognize_audio=recognize)
        await stt.start_session("stream-1")
        with pytest.raises(ProviderBridgeError) as stt_error:
            await stt.finish_session("stream-1")
        assert stt_error.value.failure.code == "stt_stream_identity_conflict"

        async def synthesize_wrong(_request):
            return TtsResult(request_id="other-request")

        tts = AstrBotTtsProvider(
            synthesize=synthesize_wrong,
            cancel=lambda _request_id: None,
        )
        with pytest.raises(ValueError, match="request_id_conflict"):
            await tts.synthesize(
                TtsRequest(
                    request_id="tts-1",
                    turn_id="turn-1",
                    message_id="message-1",
                    text="hello",
                )
            )

        async def generate_wrong(_request):
            return MotionResult(
                request_id="other-request",
                origin=MotionOrigin.TURN,
                payload={},
            )

        motion = AstrBotMotionProvider(
            generate=generate_wrong,
            cancel=lambda _request_id: None,
        )
        with pytest.raises(ValueError, match="request_id_conflict"):
            await motion.generate(
                MotionRequest(
                    request_id="motion-1",
                    origin=MotionOrigin.TURN,
                    turn_id="turn-1",
                    message_id="message-1",
                )
            )

    asyncio.run(run())
