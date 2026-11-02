from __future__ import annotations

import importlib
import types

import pytest


def test_provider_contracts_import_without_astrbot() -> None:
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.providers.contracts"
    )

    imported_modules = {
        value.__name__
        for value in module.__dict__.values()
        if isinstance(value, types.ModuleType) and value is not module
    }
    assert not any(name.startswith("astrbot") for name in imported_modules)


def test_conversation_boundary_is_not_a_final_segment() -> None:
    from astrbot_plugin_ag99live_adapter.providers.contracts import (
        ConversationEvent,
        ConversationEventKind,
        SegmentBoundary,
    )

    event = ConversationEvent(
        kind=ConversationEventKind.SEGMENT_BOUNDARY,
        turn_id="turn-1",
        provider_event_id="evt-1",
        boundary=SegmentBoundary("provider-segment-1"),
    )

    assert event.boundary is not None
    assert not hasattr(event, "message_id")
    assert ConversationEventKind.SEGMENT_BOUNDARY.value == "segment_boundary"


def test_turn_motion_requires_orchestrator_assigned_identity() -> None:
    from astrbot_plugin_ag99live_adapter.providers.contracts import (
        MotionOrigin,
        MotionRequest,
    )

    with pytest.raises(ValueError, match="turn_motion_identity_required"):
        MotionRequest(
            request_id="motion-1",
            origin=MotionOrigin.TURN,
            text="hello",
        )

    passive = MotionRequest(
        request_id="motion-2",
        origin=MotionOrigin.PASSIVE,
        text="idle",
    )
    assert passive.turn_id is None
    assert passive.message_id is None


def test_tts_result_exposes_one_canonical_audio_artifact() -> None:
    from astrbot_plugin_ag99live_adapter.providers.contracts import (
        AudioArtifact,
        TtsResult,
    )

    result = TtsResult(
        request_id="tts-1",
        artifact=AudioArtifact(
            artifact_id="audio-1",
            uri="/cache/audio/audio-1.wav",
            format="audio/wav",
            duration_ms=120,
            sample_rate=16_000,
        ),
    )

    assert result.artifact is not None
    assert result.artifact.uri.endswith("audio-1.wav")
