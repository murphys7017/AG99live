from __future__ import annotations

import json

import pytest


def build_frame(
    metadata: dict,
    payload: bytes = b"\x01\x00\xff\xff",
    *,
    flags: int = 0,
) -> bytes:
    metadata_bytes = json.dumps(metadata).encode("utf-8")
    return (
        b"AG99"
        + bytes([1, 1])
        + flags.to_bytes(2, "little")
        + len(metadata_bytes).to_bytes(4, "little")
        + metadata_bytes
        + payload
    )


def test_parse_binary_audio_frame_accepts_pcm16le_chunk(install_fake_astrbot) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.protocol.binary_audio import parse_binary_audio_frame

    frame = parse_binary_audio_frame(
        build_frame(
            {
                "stream_id": "mic:abc",
                "turn_id": "input:abc",
                "seq": 7,
                "encoding": "pcm16le",
                "sample_rate": 16000,
                "channels": 1,
            }
        )
    )

    assert frame.stream_id == "mic:abc"
    assert frame.turn_id == "input:abc"
    assert frame.seq == 7
    assert frame.encoding == "pcm16le"
    assert frame.sample_rate == 16000
    assert frame.channels == 1
    assert frame.payload == b"\x01\x00\xff\xff"


def test_parse_binary_audio_frame_rejects_bad_magic(install_fake_astrbot) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.protocol.binary_audio import (
        BinaryAudioFrameError,
        parse_binary_audio_frame,
    )

    with pytest.raises(BinaryAudioFrameError, match="invalid magic"):
        parse_binary_audio_frame(b"BAD!" + build_frame({})[4:])


def test_parse_binary_audio_frame_rejects_reserved_flags(install_fake_astrbot) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.protocol.binary_audio import (
        BinaryAudioFrameError,
        parse_binary_audio_frame,
    )

    with pytest.raises(BinaryAudioFrameError, match="frame flags: 1"):
        parse_binary_audio_frame(build_frame({}, flags=1))
