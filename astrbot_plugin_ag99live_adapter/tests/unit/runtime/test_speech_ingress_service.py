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

class VadEngineStub:
    def __init__(self, results) -> None:
        self.results = list(results)

    def detect_speech(self, _audio_data):
        if not self.results:
            return []
        return self.results.pop(0)

class MessageStub:
    def __init__(
        self,
        *,
        dropped: bool = True,
        turn_id: str = "input:segment-1",
        payload: dict | None = None,
    ) -> None:
        self.payload = dict(payload) if payload is not None else {"dropped": dropped}
        self.turn_id = turn_id
        self.raw = {
            "turn_id": self.turn_id,
            "payload": dict(self.payload),
        }

def test_handle_binary_audio_stream_chunk_transcribes_on_stream_end(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.protocol.binary_audio import BinaryAudioChunkFrame
    from astrbot_plugin_ag99live_adapter.services.speech_service import SpeechIngressService

    sent_messages: list[dict] = []

    async def send_json(message: dict) -> None:
        sent_messages.append(message)

    service = SpeechIngressService(
        media_service=MediaServiceStub(),
        runtime_state=SimpleNamespace(selected_stt_provider=SttProviderStub()),
        ensure_vad_engine=lambda: None,
        send_json=send_json,
        build_message_object=lambda *, text, raw_message: {
            "text": text,
            "raw_message": raw_message,
        },
    )

    asyncio.run(
        service.handle_audio_stream_binary_chunk(
            BinaryAudioChunkFrame(
                stream_id="mic:test",
                turn_id="input:binary",
                seq=0,
                encoding="pcm16le",
                sample_rate=16000,
                channels=1,
                payload=np.array([8192, -8192], dtype=np.int16).tobytes(),
                metadata={"capture_mode": "ptt"},
            )
        )
    )
    result = asyncio.run(
        service.handle_audio_stream_end(
            MessageStub(
                dropped=False,
                turn_id="input:binary",
                payload={"stream_id": "mic:test", "reason": "ptt_release", "capture_mode": "ptt"},
            )
        )
    )

    assert result["text"] == "hello from stt"
    assert result["raw_message"]["payload"]["stream_id"] == "mic:test"
    assert result["raw_message"]["payload"]["audio_sample_rate"] == 16000
    assert sent_messages[0]["type"] == "output.transcription"
    assert sent_messages[0]["turn_id"] == "input:binary"

def test_handle_manual_binary_audio_stream_chunk_uses_vad_segments(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.protocol.binary_audio import BinaryAudioChunkFrame
    from astrbot_plugin_ag99live_adapter.services.speech_service import SpeechIngressService

    sent_messages: list[dict] = []
    pcm = (
        np.tile(np.array([0.2, -0.2, 0.3], dtype=np.float32), 256) * 32767
    ).astype(np.int16).tobytes()
    vad_engine = VadEngineStub([[pcm]])

    async def send_json(message: dict) -> None:
        sent_messages.append(message)

    service = SpeechIngressService(
        media_service=MediaServiceStub(),
        runtime_state=SimpleNamespace(selected_stt_provider=SttProviderStub()),
        ensure_vad_engine=lambda: vad_engine,
        send_json=send_json,
        build_message_object=lambda *, text, raw_message: {
            "text": text,
            "raw_message": raw_message,
        },
    )

    result = asyncio.run(
        service.handle_audio_stream_binary_chunk(
            BinaryAudioChunkFrame(
                stream_id="mic:manual",
                turn_id="input:manual-binary",
                seq=0,
                encoding="pcm16le",
                sample_rate=16000,
                channels=1,
                payload=np.array([8192, -8192], dtype=np.int16).tobytes(),
                metadata={"capture_mode": "manual"},
            )
        )
    )

    assert result["text"] == "hello from stt"
    assert result["raw_message"]["turn_id"] == "input:manual-binary:vad:1"
    assert result["raw_message"]["payload"]["stream_id"] == "mic:manual"
    assert sent_messages[0]["type"] == "output.transcription"
    assert sent_messages[0]["turn_id"] == "input:manual-binary:vad:1"

def test_handle_binary_audio_stream_end_dropped_reports_terminal_signal(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.protocol.binary_audio import BinaryAudioChunkFrame
    from astrbot_plugin_ag99live_adapter.services.speech_service import SpeechIngressService

    sent_messages: list[dict] = []
    build_calls: list[tuple[str, dict]] = []

    async def send_json(message: dict) -> None:
        sent_messages.append(message)

    service = SpeechIngressService(
        media_service=MediaServiceStub(),
        runtime_state=SimpleNamespace(selected_stt_provider=SttProviderStub()),
        ensure_vad_engine=lambda: None,
        send_json=send_json,
        build_message_object=lambda *, text, raw_message: build_calls.append((text, raw_message)),
    )

    asyncio.run(
        service.handle_audio_stream_binary_chunk(
            BinaryAudioChunkFrame(
                stream_id="mic:dropped",
                turn_id="input:binary-dropped",
                seq=0,
                encoding="pcm16le",
                sample_rate=16000,
                channels=1,
                payload=np.array([8192, -8192], dtype=np.int16).tobytes(),
                metadata={},
            )
        )
    )
    result = asyncio.run(
        service.handle_audio_stream_end(
            MessageStub(
                turn_id="input:binary-dropped",
                payload={"stream_id": "mic:dropped", "reason": "manual_stop", "dropped": True},
            )
        )
    )

    assert result is None
    assert build_calls == []
    assert len(sent_messages) == 2
    assert sent_messages[0]["type"] == "control.error"
    assert sent_messages[0]["payload"]["message"] == "Microphone audio segment dropped before transcription."
    assert sent_messages[0]["turn_id"] == "input:binary-dropped"
    assert sent_messages[1]["type"] == "control.turn_finished"
    assert sent_messages[1]["turn_id"] == "input:binary-dropped"
