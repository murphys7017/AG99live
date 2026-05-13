from __future__ import annotations

import asyncio

class MediaServiceStub:
    def __init__(self) -> None:
        self.clear_calls = 0

    async def clear_audio_buffer(self) -> None:
        self.clear_calls += 1

    async def drain_audio_buffer(self):
        raise AssertionError("drain_audio_buffer should not be called for dropped audio")


class MessageStub:
    def __init__(self) -> None:
        self.payload = {"dropped": True}
        self.session_id = "session-1"
        self.turn_id = "turn-1"
        self.orchestration_id = "input:segment-1"
        self.raw = {
            "orchestration_id": self.orchestration_id,
            "payload": dict(self.payload),
        }


def test_handle_audio_end_dropped_segment_clears_buffer_and_reports_error(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.services.speech_service import SpeechIngressService

    sent_messages: list[dict] = []
    build_calls: list[tuple[str, dict]] = []

    async def send_json(message: dict) -> None:
        sent_messages.append(message)

    service = SpeechIngressService(
        media_service=MediaServiceStub(),
        runtime_state=object(),
        ensure_vad_engine=lambda: None,
        send_json=send_json,
        build_message_object=lambda *, text, raw_message: build_calls.append((text, raw_message)),
    )

    result = asyncio.run(service.handle_audio_end(MessageStub()))

    assert result is None
    assert service.media_service.clear_calls == 1
    assert build_calls == []
    assert len(sent_messages) == 1
    assert sent_messages[0]["type"] == "control.error"
    assert sent_messages[0]["payload"]["message"] == "Microphone audio segment dropped before transcription."
    assert sent_messages[0]["orchestration_id"] == "input:segment-1"
