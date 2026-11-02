from __future__ import annotations

from astrbot_plugin_ag99live_adapter.runtime.golden_event_sequences import (
    GOLDEN_EVENT_SEQUENCES,
    GOLDEN_INTERRUPTED,
    GOLDEN_MOTION_FAILURE,
    GOLDEN_SUCCESSFUL_TEXT_TTS,
    GOLDEN_TTS_FAILURE,
    GoldenEvent,
)


def test_golden_sequences_are_named_and_non_empty() -> None:
    assert {sequence.name for sequence in GOLDEN_EVENT_SEQUENCES} == {
        "successful_text_tts",
        "motion_failure_keeps_core_output",
        "tts_failure_keeps_turn_terminal",
        "interrupted_turn",
    }
    assert all(sequence.events for sequence in GOLDEN_EVENT_SEQUENCES)


def test_successful_sequence_places_segment_after_all_provider_material() -> None:
    events = GOLDEN_SUCCESSFUL_TEXT_TTS.events

    assert events.index(GoldenEvent.OUTPUT_SEGMENT) > events.index(
        GoldenEvent.AUDIO_READY
    )
    assert events.index(GoldenEvent.OUTPUT_SEGMENT) > events.index(
        GoldenEvent.MOTION_READY
    )
    assert events[-3:] == (
        GoldenEvent.SYNTH_FINISHED,
        GoldenEvent.PLAYBACK_FINISHED,
        GoldenEvent.TURN_FINISHED,
    )


def test_motion_failure_keeps_core_output_and_terminal_order() -> None:
    events = GOLDEN_MOTION_FAILURE.events

    assert GoldenEvent.MOTION_FAILED in events
    assert GoldenEvent.OUTPUT_SEGMENT in events
    assert events.index(GoldenEvent.MOTION_FAILED) < events.index(
        GoldenEvent.OUTPUT_SEGMENT
    )
    assert events[-3:] == (
        GoldenEvent.SYNTH_FINISHED,
        GoldenEvent.PLAYBACK_FINISHED,
        GoldenEvent.TURN_FINISHED,
    )


def test_interrupted_turn_has_one_terminal_event_without_fake_playback_ack() -> None:
    events = GOLDEN_INTERRUPTED.events

    assert events.count(GoldenEvent.TURN_FINISHED) == 1
    assert GoldenEvent.PLAYBACK_FINISHED not in events
    assert events.index(GoldenEvent.INTERRUPT) < events.index(
        GoldenEvent.TURN_FINISHED
    )


def test_tts_failure_is_explicit_before_segment_and_turn_terminal() -> None:
    events = GOLDEN_TTS_FAILURE.events

    assert events.index(GoldenEvent.AUDIO_FAILED) < events.index(
        GoldenEvent.OUTPUT_SEGMENT
    )
    assert events[-3:] == (
        GoldenEvent.SYNTH_FINISHED,
        GoldenEvent.PLAYBACK_FINISHED,
        GoldenEvent.TURN_FINISHED,
    )
