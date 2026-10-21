from __future__ import annotations

import asyncio
from types import SimpleNamespace

import numpy as np
import pytest

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


async def ignore_vad_speech_started(_capture_turn_id: str) -> None:
    return None


def test_sealed_ptt_transcribes_before_final_image_commit(install_fake_astrbot) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.protocol.binary_audio import BinaryAudioChunkFrame
    from astrbot_plugin_ag99live_adapter.protocol.parser import parse_inbound_message
    from astrbot_plugin_ag99live_adapter.services.speech_service import SpeechIngressService

    async def run():
        started = asyncio.Event()
        release = asyncio.Event()
        sent = []

        class Provider:
            async def get_text(self, _path):
                started.set()
                await release.wait()
                return "看看桌面"

        async def send_json(message):
            sent.append(message)

        service = SpeechIngressService(
            media_service=MediaServiceStub(),
            runtime_state=SimpleNamespace(
                fast_asr_enabled=False,
                resolve_stt_provider=Provider,
            ),
            create_vad_engine=lambda: None,
            send_json=send_json,
            build_message_object=lambda **kwargs: kwargs,
            on_vad_speech_started=ignore_vad_speech_started,
        )

        def message(kind, payload, turn_id="input:sealed"):
            return parse_inbound_message({
                "type": f"input.audio_stream_{kind}", "version": "v2",
                "source": "frontend", "turn_id": turn_id, "payload": payload,
                "message_id": f"boundary:{kind}:{turn_id}",
            })

        await service.handle_audio_stream_start(message("start", {
            "stream_id": "mic:sealed", "source": "web_audio", "encoding": "pcm16le",
            "sample_rate": 16000, "channels": 1, "capture_mode": "ptt",
        }))
        await service.handle_audio_stream_binary_chunk(BinaryAudioChunkFrame(
            stream_id="mic:sealed", turn_id="input:sealed", seq=0,
            encoding="pcm16le", sample_rate=16000, channels=1,
            payload=np.array([8192, -8192], dtype=np.int16).tobytes(),
            metadata={"capture_mode": "ptt"},
        ))
        await service.handle_audio_stream_seal(message("seal", {
            "stream_id": "mic:sealed", "last_seq": 0, "capture_mode": "ptt",
        }))
        await asyncio.wait_for(started.wait(), timeout=1)
        assert sent == []  # The input is not published before its screenshot.
        release.set()
        image = {"source": "screen", "data": "data:image/jpeg;base64,AA=="}
        end = {"stream_id": "mic:sealed", "reason": "ptt_release", "last_seq": 0,
               "capture_mode": "ptt", "images": [image], "desktop_snapshot_requested": True}
        with pytest.raises(ValueError, match="capture_turn_mismatch"):
            await service.handle_audio_stream_end(message("end", end, "input:other"))
        result = await service.handle_audio_stream_end(message("end", end))
        assert result["text"] == "看看桌面"
        assert result["images"] == [image]
        assert result["raw_message"]["payload"]["audio_sample_count"] == 2
        assert [item["type"] for item in sent] == ["output.transcription"]
        with pytest.raises(ValueError, match="without_start"):
            await service.handle_audio_stream_end(message("end", end))

    asyncio.run(run())


@pytest.mark.parametrize(
    ("capture_mode", "seal"),
    [("ptt", False), ("ptt", True), ("manual", False)],
)
def test_fast_asr_streams_partial_text_and_flushes_audio_tail(
    install_fake_astrbot,
    monkeypatch,
    capture_mode: str,
    seal: bool,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.protocol.binary_audio import BinaryAudioChunkFrame
    from astrbot_plugin_ag99live_adapter.services import speech_service

    class FakeStreamingSession:
        model_path = "test-model"
        provider = "cpu"

        def __init__(self) -> None:
            self.sample_count = 0

        def accept(self, samples, _sample_rate: int) -> str:
            self.sample_count += len(samples)
            return "live partial"

        def finish(self) -> str:
            expected_sample_count = 400 if capture_mode == "ptt" else 600
            return "complete final" if self.sample_count == expected_sample_count else "tail was lost"

        def reset(self) -> None:
            self.sample_count = 0

    class FakeStreamingASR:
        model_path = "test-model"
        provider = "cpu"

        def __init__(self, **_kwargs) -> None:
            pass

        def new_session(self):
            return FakeStreamingSession()

    monkeypatch.setattr(speech_service, "StreamingASR", FakeStreamingASR)

    async def run():
        sent_messages: list[dict] = []

        async def send_json(message: dict) -> None:
            sent_messages.append(message)

        vad_pcm = np.zeros(600, dtype=np.int16).tobytes()
        vad_engine = VadEngineStub([[b"<|PAUSE|>", vad_pcm]])
        service = speech_service.SpeechIngressService(
            media_service=MediaServiceStub(),
            runtime_state=SimpleNamespace(
                fast_asr_enabled=True,
                fast_asr_model_dir="test-model",
                fast_asr_provider="cpu",
                fast_asr_num_threads=1,
            ),
            create_vad_engine=lambda: vad_engine,
            send_json=send_json,
            build_message_object=lambda *, text, raw_message, images=None: {
                "text": text,
                "raw_message": raw_message,
                "images": images,
            },
            on_vad_speech_started=ignore_vad_speech_started,
        )
        await service.handle_audio_stream_start(MessageStub(
            turn_id="input:streaming",
            payload={
                "stream_id": "mic:streaming",
                "encoding": "pcm16le",
                "sample_rate": 16000,
                "channels": 1,
                "capture_mode": capture_mode,
            },
        ))

        if capture_mode == "ptt":
            for seq, sample_count in enumerate((160, 160, 80)):
                await service.handle_audio_stream_binary_chunk(BinaryAudioChunkFrame(
                    stream_id="mic:streaming",
                    turn_id="input:streaming",
                    seq=seq,
                    encoding="pcm16le",
                    sample_rate=16000,
                    channels=1,
                    payload=np.zeros(sample_count, dtype=np.int16).tobytes(),
                    metadata={"capture_mode": capture_mode},
                ))
                if seq == 0:
                    assert sent_messages == []
                elif seq == 1:
                    assert sent_messages[-1]["payload"] == {
                        "text": "live partial",
                        "stage": "streaming",
                    }

            if seal:
                await service.handle_audio_stream_seal(MessageStub(
                    turn_id="input:streaming",
                    payload={
                        "stream_id": "mic:streaming",
                        "capture_mode": capture_mode,
                        "last_seq": 2,
                    },
                ))

            result = await service.handle_audio_stream_end(MessageStub(
                turn_id="input:streaming",
                dropped=False,
                payload={
                    "stream_id": "mic:streaming",
                    "reason": "ptt_release",
                    "capture_mode": capture_mode,
                    "last_seq": 2,
                },
            ))
        else:
            result = await service.handle_audio_stream_binary_chunk(BinaryAudioChunkFrame(
                stream_id="mic:streaming",
                turn_id="input:streaming",
                seq=0,
                encoding="pcm16le",
                sample_rate=16000,
                channels=1,
                payload=np.zeros(2, dtype=np.int16).tobytes(),
                metadata={"capture_mode": capture_mode},
            ))

        assert result["text"] == "complete final"
        assert sent_messages[0]["payload"] == {
            "text": "live partial",
            "stage": "streaming",
        }
        assert sent_messages[-1]["payload"] == {
            "text": "complete final",
            "stage": "final",
        }

    asyncio.run(run())


def test_interrupted_sealed_ptt_cannot_commit(install_fake_astrbot) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.protocol.binary_audio import BinaryAudioChunkFrame
    from astrbot_plugin_ag99live_adapter.services.speech_service import SpeechIngressService

    async def run():
        started = asyncio.Event()
        cancelled = asyncio.Event()
        sent = []

        class Provider:
            async def get_text(self, _path):
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()

        async def send_json(message):
            sent.append(message)

        service = SpeechIngressService(
            media_service=MediaServiceStub(),
            runtime_state=SimpleNamespace(
                fast_asr_enabled=False,
                resolve_stt_provider=Provider,
            ),
            create_vad_engine=lambda: None, send_json=send_json,
            build_message_object=lambda **kwargs: kwargs,
            on_vad_speech_started=ignore_vad_speech_started,
        )
        await service.handle_audio_stream_start(MessageStub(payload={
            "stream_id": "mic:cancel", "encoding": "pcm16le", "sample_rate": 16000,
            "channels": 1, "capture_mode": "ptt",
        }))
        await service.handle_audio_stream_binary_chunk(BinaryAudioChunkFrame(
            stream_id="mic:cancel", turn_id="input:segment-1", seq=0,
            encoding="pcm16le", sample_rate=16000, channels=1,
            payload=np.array([8192], dtype=np.int16).tobytes(), metadata={},
        ))
        await service.handle_audio_stream_seal(MessageStub(payload={
            "stream_id": "mic:cancel", "last_seq": 0, "capture_mode": "ptt",
        }))
        await asyncio.wait_for(started.wait(), timeout=1)
        await service.handle_audio_stream_interrupt(turn_id="input:segment-1")
        assert cancelled.is_set()
        with pytest.raises(ValueError, match="without_start"):
            await service.handle_audio_stream_end(MessageStub(payload={
                "stream_id": "mic:cancel", "reason": "ptt_release",
            }))
        assert sent == []

    asyncio.run(run())


def start_audio_stream(
    service,
    *,
    turn_id: str,
    stream_id: str,
    capture_mode: str,
) -> None:
    asyncio.run(
        service.handle_audio_stream_start(
            MessageStub(
                turn_id=turn_id,
                payload={
                    "stream_id": stream_id,
                    "source": "web_audio",
                    "encoding": "pcm16le",
                    "sample_rate": 16000,
                    "channels": 1,
                    "capture_mode": capture_mode,
                },
            )
        )
    )


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
        runtime_state=SimpleNamespace(
            fast_asr_enabled=False,
            resolve_stt_provider=lambda: SttProviderStub(),
        ),
        create_vad_engine=lambda: None,
        send_json=send_json,
        build_message_object=lambda *, text, raw_message, images=None: {
            "text": text,
            "raw_message": raw_message,
            "images": images,
        },
        on_vad_speech_started=ignore_vad_speech_started,
    )

    start_audio_stream(
        service,
        turn_id="input:binary",
        stream_id="mic:test",
        capture_mode="ptt",
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
                payload={
                    "stream_id": "mic:test",
                    "reason": "ptt_release",
                    "capture_mode": "ptt",
                    "images": [{"source": "screen", "data": "data:image/jpeg;base64,AA=="}],
                    "desktop_snapshot_requested": True,
                },
            )
        )
    )

    assert result["text"] == "hello from stt"
    assert result["raw_message"]["payload"]["stream_id"] == "mic:test"
    assert result["raw_message"]["payload"]["audio_sample_rate"] == 16000
    assert result["images"] == [
        {"source": "screen", "data": "data:image/jpeg;base64,AA=="}
    ]
    assert sent_messages[0]["type"] == "output.transcription"
    assert sent_messages[0]["turn_id"] == "input:binary"

def test_handle_manual_binary_audio_stream_chunk_uses_vad_segments(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.protocol.binary_audio import BinaryAudioChunkFrame
    from astrbot_plugin_ag99live_adapter.services.speech_service import SpeechIngressService

    sent_messages: list[dict] = []
    vad_started_turn_ids: list[str] = []
    pcm = (
        np.tile(np.array([0.2, -0.2, 0.3], dtype=np.float32), 256) * 32767
    ).astype(np.int16).tobytes()
    vad_engine = VadEngineStub([[b"<|PAUSE|>", pcm]])

    async def send_json(message: dict) -> None:
        sent_messages.append(message)

    async def on_vad_speech_started(capture_turn_id: str) -> None:
        vad_started_turn_ids.append(capture_turn_id)

    service = SpeechIngressService(
        media_service=MediaServiceStub(),
        runtime_state=SimpleNamespace(
            fast_asr_enabled=False,
            resolve_stt_provider=lambda: SttProviderStub(),
        ),
        create_vad_engine=lambda: vad_engine,
        send_json=send_json,
        build_message_object=lambda *, text, raw_message, images=None: {
            "text": text,
            "raw_message": raw_message,
            "images": images,
        },
        on_vad_speech_started=on_vad_speech_started,
    )

    start_audio_stream(
        service,
        turn_id="input:manual-binary",
        stream_id="mic:manual",
        capture_mode="manual",
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
    assert vad_started_turn_ids == ["input:manual-binary"]
    assert sent_messages[0]["type"] == "output.transcription"
    assert sent_messages[0]["turn_id"] == "input:manual-binary:vad:1"


def test_vad_speech_end_callback_runs_when_transcription_has_no_message(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.protocol.binary_audio import BinaryAudioChunkFrame
    from astrbot_plugin_ag99live_adapter.services.speech_service import SpeechIngressService

    started: list[str] = []
    ended: list[str] = []
    pcm = (np.tile(np.array([0.2, -0.2, 0.3], dtype=np.float32), 256) * 32767).astype(
        np.int16
    ).tobytes()
    vad_engine = VadEngineStub([[b"<|PAUSE|>", pcm]])

    async def on_vad_speech_started(capture_turn_id: str) -> None:
        started.append(capture_turn_id)

    async def on_vad_speech_ended(capture_turn_id: str) -> None:
        ended.append(capture_turn_id)

    service = SpeechIngressService(
        media_service=MediaServiceStub(),
        runtime_state=SimpleNamespace(
            fast_asr_enabled=False,
            resolve_stt_provider=lambda: SttProviderStub(),
        ),
        create_vad_engine=lambda: vad_engine,
        send_json=lambda _message: asyncio.sleep(0),
        build_message_object=lambda **_kwargs: None,
        on_vad_speech_started=on_vad_speech_started,
        on_vad_speech_ended=on_vad_speech_ended,
    )
    start_audio_stream(
        service,
        turn_id="capture:no-message",
        stream_id="mic:no-message",
        capture_mode="manual",
    )

    result = asyncio.run(
        service.handle_audio_stream_binary_chunk(
            BinaryAudioChunkFrame(
                stream_id="mic:no-message",
                turn_id="capture:no-message",
                seq=0,
                encoding="pcm16le",
                sample_rate=16000,
                channels=1,
                payload=np.array([8192, -8192], dtype=np.int16).tobytes(),
                metadata={"capture_mode": "manual"},
            )
        )
    )

    assert result is None
    assert started == ["capture:no-message"]
    assert ended == ["capture:no-message"]

def test_handle_binary_audio_stream_end_dropped_reports_input_error(
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
        runtime_state=SimpleNamespace(
            fast_asr_enabled=False,
            resolve_stt_provider=lambda: SttProviderStub(),
        ),
        create_vad_engine=lambda: None,
        send_json=send_json,
        build_message_object=lambda *, text, raw_message, images=None: build_calls.append(
            (text, raw_message)
        ),
        on_vad_speech_started=ignore_vad_speech_started,
    )

    start_audio_stream(
        service,
        turn_id="input:binary-dropped",
        stream_id="mic:dropped",
        capture_mode="ptt",
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
    assert len(sent_messages) == 1
    assert sent_messages[0]["type"] == "control.error"
    assert sent_messages[0]["payload"]["message"] == "Microphone audio segment dropped before transcription."
    assert sent_messages[0]["turn_id"] == "input:binary-dropped"
