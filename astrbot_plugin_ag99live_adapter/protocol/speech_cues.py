from __future__ import annotations

from typing import Any


SPEECH_CUE_KINDS = frozenset(
    {
        "breath",
        "sigh",
        "laugh",
        "chuckle",
        "hesitate",
        "emphasis",
    }
)
SPEECH_CUE_POSITIONS = frozenset({"before", "after"})
MAX_SPEECH_CUES = 8


def normalize_speech_cues(value: object) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list | tuple):
        raise ValueError("output_segment_speech_cues_invalid")
    if len(value) > MAX_SPEECH_CUES:
        raise ValueError("output_segment_speech_cues_limit_exceeded")

    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if isinstance(item, dict):
            kind_value = item.get("kind")
            phrase_index = item.get("phrase_index")
            position_value = item.get("position")
        else:
            kind_value = getattr(item, "kind", None)
            phrase_index = getattr(item, "phrase_index", None)
            position_value = getattr(item, "position", None)

        kind = str(kind_value or "").strip().lower()
        position = str(position_value or "").strip().lower()
        if kind not in SPEECH_CUE_KINDS:
            raise ValueError(f"output_segment_speech_cue_kind_invalid:{index}")
        if (
            isinstance(phrase_index, bool)
            or not isinstance(phrase_index, int)
            or phrase_index < 0
        ):
            raise ValueError(f"output_segment_speech_cue_phrase_index_invalid:{index}")
        if position not in SPEECH_CUE_POSITIONS:
            raise ValueError(f"output_segment_speech_cue_position_invalid:{index}")
        normalized.append(
            {
                "kind": kind,
                "phrase_index": phrase_index,
                "position": position,
            }
        )
    return normalized


__all__ = [
    "MAX_SPEECH_CUES",
    "SPEECH_CUE_KINDS",
    "SPEECH_CUE_POSITIONS",
    "normalize_speech_cues",
]
