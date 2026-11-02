"""Golden lifecycle event order for Phase 0 comparison.

These sequences describe required ordering facts, not every optional diagnostic
event. A future runtime trace can contain additional events between adjacent
entries, but it must not reorder the listed lifecycle facts.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Final


class GoldenEvent(str, Enum):
    INPUT_TEXT = "input.text"
    TURN_STARTED = "turn_started"
    TEXT_DELTA = "text_delta"
    TEXT_COMPLETED = "text_completed"
    SEGMENT_BOUNDARY = "segment_boundary"
    TTS_STARTED = "tts_started"
    AUDIO_READY = "audio_ready"
    AUDIO_FAILED = "audio_failed"
    MOTION_READY = "motion_ready"
    MOTION_FAILED = "motion_failed"
    OUTPUT_SEGMENT = "output.segment.v6"
    SYNTH_FINISHED = "control.synth_finished"
    PLAYBACK_FINISHED = "control.playback_finished"
    INTERRUPT = "control.interrupt"
    TURN_FINISHED = "control.turn_finished"


@dataclass(frozen=True)
class GoldenEventSequence:
    name: str
    events: tuple[GoldenEvent, ...]
    description: str

    @property
    def values(self) -> tuple[str, ...]:
        return tuple(event.value for event in self.events)


GOLDEN_SUCCESSFUL_TEXT_TTS: Final = GoldenEventSequence(
    name="successful_text_tts",
    events=(
        GoldenEvent.INPUT_TEXT,
        GoldenEvent.TURN_STARTED,
        GoldenEvent.TEXT_DELTA,
        GoldenEvent.TEXT_COMPLETED,
        GoldenEvent.SEGMENT_BOUNDARY,
        GoldenEvent.TTS_STARTED,
        GoldenEvent.AUDIO_READY,
        GoldenEvent.MOTION_READY,
        GoldenEvent.OUTPUT_SEGMENT,
        GoldenEvent.SYNTH_FINISHED,
        GoldenEvent.PLAYBACK_FINISHED,
        GoldenEvent.TURN_FINISHED,
    ),
    description="文本、TTS 和动作都成功的一轮完整播放。",
)

GOLDEN_MOTION_FAILURE: Final = GoldenEventSequence(
    name="motion_failure_keeps_core_output",
    events=(
        GoldenEvent.INPUT_TEXT,
        GoldenEvent.TURN_STARTED,
        GoldenEvent.TEXT_DELTA,
        GoldenEvent.TEXT_COMPLETED,
        GoldenEvent.SEGMENT_BOUNDARY,
        GoldenEvent.TTS_STARTED,
        GoldenEvent.AUDIO_READY,
        GoldenEvent.MOTION_FAILED,
        GoldenEvent.OUTPUT_SEGMENT,
        GoldenEvent.SYNTH_FINISHED,
        GoldenEvent.PLAYBACK_FINISHED,
        GoldenEvent.TURN_FINISHED,
    ),
    description="Motion 失败时，文本和音频仍然可以正常收口。",
)

GOLDEN_TTS_FAILURE: Final = GoldenEventSequence(
    name="tts_failure_keeps_turn_terminal",
    events=(
        GoldenEvent.INPUT_TEXT,
        GoldenEvent.TURN_STARTED,
        GoldenEvent.TEXT_DELTA,
        GoldenEvent.TEXT_COMPLETED,
        GoldenEvent.SEGMENT_BOUNDARY,
        GoldenEvent.TTS_STARTED,
        GoldenEvent.AUDIO_FAILED,
        GoldenEvent.MOTION_FAILED,
        GoldenEvent.OUTPUT_SEGMENT,
        GoldenEvent.SYNTH_FINISHED,
        GoldenEvent.PLAYBACK_FINISHED,
        GoldenEvent.TURN_FINISHED,
    ),
    description="TTS 失败时，音频和动作都明确失败，但 Turn 仍然正常收口。",
)

GOLDEN_INTERRUPTED: Final = GoldenEventSequence(
    name="interrupted_turn",
    events=(
        GoldenEvent.INPUT_TEXT,
        GoldenEvent.TURN_STARTED,
        GoldenEvent.TEXT_DELTA,
        GoldenEvent.INTERRUPT,
        GoldenEvent.TURN_FINISHED,
    ),
    description="输入被打断后，旧 Turn 只能发布一次失败终态。",
)

GOLDEN_EVENT_SEQUENCES: Final = (
    GOLDEN_SUCCESSFUL_TEXT_TTS,
    GOLDEN_MOTION_FAILURE,
    GOLDEN_TTS_FAILURE,
    GOLDEN_INTERRUPTED,
)


__all__ = [
    "GOLDEN_EVENT_SEQUENCES",
    "GOLDEN_INTERRUPTED",
    "GOLDEN_MOTION_FAILURE",
    "GOLDEN_SUCCESSFUL_TEXT_TTS",
    "GOLDEN_TTS_FAILURE",
    "GoldenEvent",
    "GoldenEventSequence",
]
