from __future__ import annotations

import asyncio
from types import SimpleNamespace

import numpy as np

class MediaServiceStub:
    def __init__(self) -> None:
        self.clear_calls = 0
        self.clear_segment_ids: list[str | None] = []
        self.append_calls: list[tuple[str | None, np.ndarray]] = []
        self.drain_calls: list[str | None] = []
        self.drain_result = np.array([0.1, -0.2, 0.3], dtype=np.float32)

    async def append_audio_chunk(self, chunk, segment_id: str | None = None) -> None:
        self.append_calls.append((segment_id, chunk))

    async def clear_audio_buffer(self, segment_id: str | None = None) -> None:
        self.clear_calls += 1
        self.clear_segment_ids.append(segment_id)

    async def drain_audio_buffer(self, segment_id: str | None = None):
        self.drain_calls.append(segment_id)
        return self.drain_result

    def save_audio_buffer_to_temp_wav(self, audio_buffer, *, sample_rate: int = 16000) -> str:
        assert sample_rate == 16000
        assert isinstance(audio_buffer, np.ndarray)
        return __file__


class SttProviderStub:
    async def get_text(self, _temp_path: str) -> str:
        return "hello from stt"


class MessageStub:
    def __init__(self, *, dropped: bool = True, turn_id: str = "input:segment-1") -> None:
        self.payload = {"dropped": dropped}
        self.turn_id = turn_id
        self.raw = {
            "turn_id": self.turn_id,
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
    assert service.media_service.clear_segment_ids == ["input:segment-1"]
    assert build_calls == []
    assert len(sent_messages) == 2
    assert sent_messages[0]["type"] == "control.error"
    assert sent_messages[0]["payload"]["message"] == "Microphone audio segment dropped before transcription."
    assert sent_messages[0]["turn_id"] == "input:segment-1"
    assert sent_messages[1]["type"] == "control.turn_finished"
    assert sent_messages[1]["turn_id"] == "input:segment-1"


def test_handle_audio_data_appends_to_matching_segment_buffer(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.services.speech_service import SpeechIngressService

    media_service = MediaServiceStub()

    async def send_json(_message: dict) -> None:
        return None

    service = SpeechIngressService(
        media_service=media_service,
        runtime_state=SimpleNamespace(selected_stt_provider=SttProviderStub()),
        ensure_vad_engine=lambda: None,
        send_json=send_json,
        build_message_object=lambda *, text, raw_message: {
            "text": text,
            "raw_message": raw_message,
        },
    )

    message = SimpleNamespace(
        payload={"audio": [0.1, -0.2, 0.3]},
        turn_id="input:segment-append",
    )

    asyncio.run(service.handle_audio_data(message))

    assert len(media_service.append_calls) == 1
    segment_id, chunk = media_service.append_calls[0]
    assert segment_id == "input:segment-append"
    assert chunk.dtype == np.float32
    assert np.allclose(chunk, np.array([0.1, -0.2, 0.3], dtype=np.float32))


def test_handle_audio_end_drains_matching_segment_buffer(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.services.speech_service import SpeechIngressService

    sent_messages: list[dict] = []

    async def send_json(message: dict) -> None:
        sent_messages.append(message)

    media_service = MediaServiceStub()
    service = SpeechIngressService(
        media_service=media_service,
        runtime_state=SimpleNamespace(selected_stt_provider=SttProviderStub()),
        ensure_vad_engine=lambda: None,
        send_json=send_json,
        build_message_object=lambda *, text, raw_message: {
            "text": text,
            "raw_message": raw_message,
        },
    )

    result = asyncio.run(service.handle_audio_end(MessageStub(dropped=False, turn_id="input:segment-drain")))

    assert media_service.drain_calls == ["input:segment-drain"]
    assert result["text"] == "hello from stt"
    assert result["raw_message"]["turn_id"] == "input:segment-drain"
    assert result["raw_message"]["payload"]["transcription"] == "hello from stt"
    assert sent_messages[0]["type"] == "output.transcription"
    assert sent_messages[0]["turn_id"] == "input:segment-drain"
