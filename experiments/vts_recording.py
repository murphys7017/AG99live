"""Read time-aligned VTube Studio speech and semantic parameter frames."""

from __future__ import annotations

import json
import math
import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


DEFAULT_PROFILE = (
    Path(r"C:\Users\Administrator\Downloads\AstrBot\data\plugins")
    / "astrbot_plugin_ag99live_adapter"
    / "live2ds"
    / "Mk6_1.0"
    / "ag99"
    / "semantic_axis_profile.json"
)

FILLER_RE = re.compile(r"([啊嗯呃哦唉哎])\1{2,}")
WHITESPACE_RE = re.compile(r"\s+")
ALLOWED_ROLES = {"primary", "hint"}
MAX_DURATION_MS = 15000
MAX_MOTION_STEPS = 8


@dataclass(frozen=True)
class TranscriptEvent:
    sequence_no: int
    text: str
    audio_start_ns: int
    audio_end_ns: int
    emitted_ns: int
    revision: int


@dataclass
class TextSegment:
    segment_no: int
    start_ns: int
    end_ns: int
    raw_text: str
    clean_text: str
    source_sequences: list[int]
    rewrite_detected: bool = False
    text_status: str = "normalized_only"
    text_confidence: str = "low"
    frame_count: int = 0
    mapping_warnings: list[str] = field(default_factory=list)
    motion_target: dict[str, Any] | None = None


@dataclass(frozen=True)
class AxisBinding:
    axis_id: str
    neutral: float
    value_range: tuple[float, float]
    control_role: str
    parameter_id: str
    input_range: tuple[float, float]
    output_range: tuple[float, float]
    invert: bool


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def load_transcript(connection: sqlite3.Connection, take_id: int) -> list[TranscriptEvent]:
    rows = connection.execute(
        """
        SELECT sequence_no, text, audio_start_offset_ns, audio_end_offset_ns,
               emitted_offset_ns, revision
        FROM recording_transcript_events
        WHERE take_id = ? AND kind IN ('partial', 'final')
        ORDER BY sequence_no
        """,
        (take_id,),
    ).fetchall()
    events: list[TranscriptEvent] = []
    for row in rows:
        text = str(row["text"] or "").strip()
        if not text:
            continue
        events.append(
            TranscriptEvent(
                sequence_no=int(row["sequence_no"]),
                text=text,
                audio_start_ns=max(int(row["audio_start_offset_ns"]), 0),
                audio_end_ns=max(int(row["audio_end_offset_ns"]), 0),
                emitted_ns=max(int(row["emitted_offset_ns"]), 0),
                revision=max(int(row["revision"]), 0),
            )
        )
    return events


def _normalize_text(text: str) -> tuple[str, str, str]:
    normalized = unicodedata.normalize("NFKC", text)
    normalized = WHITESPACE_RE.sub("", normalized).strip()
    normalized = FILLER_RE.sub(r"\1", normalized)
    if not normalized:
        return "", "empty", "low"
    if len(normalized) <= 1:
        return normalized, "fragment", "low"
    if normalized == text:
        return normalized, "normalized_only", "low"
    return normalized, "normalized_only", "low"


def _longest_common_prefix(left: str, right: str) -> int:
    length = 0
    for left_char, right_char in zip(left, right):
        if left_char != right_char:
            break
        length += 1
    return length


def build_text_segments(
    events: Iterable[TranscriptEvent],
    *,
    pause_ms: int,
    max_segment_ms: int,
    min_text_chars: int,
) -> list[TextSegment]:
    ordered = list(events)
    if not ordered:
        return []
    pause_ns = max(pause_ms, 100) * 1_000_000
    max_segment_ns = max(max_segment_ms, pause_ms) * 1_000_000
    segments: list[TextSegment] = []
    current_raw: list[str] = []
    current_sequences: list[int] = []
    current_start: int | None = None
    current_end: int | None = None
    current_rewrite = False
    previous: TranscriptEvent | None = None

    def flush() -> None:
        nonlocal current_raw, current_sequences, current_start, current_end, current_rewrite
        if current_start is None or current_end is None or not current_raw:
            current_raw = []
            current_sequences = []
            current_start = None
            current_end = None
            current_rewrite = False
            return
        raw_text = "".join(current_raw)
        clean_text, status, confidence = _normalize_text(raw_text)
        if len(clean_text) >= min_text_chars:
            segments.append(
                TextSegment(
                    segment_no=len(segments),
                    start_ns=current_start,
                    end_ns=max(current_end, current_start + 1),
                    raw_text=raw_text,
                    clean_text=clean_text,
                    source_sequences=list(current_sequences),
                    rewrite_detected=current_rewrite,
                    text_status=status,
                    text_confidence=confidence,
                )
            )
        current_raw = []
        current_sequences = []
        current_start = None
        current_end = None
        current_rewrite = False

    # ASR partials can replace any suffix of the current utterance, including
    # text that would otherwise have crossed a training segment boundary.
    chunks: list[tuple[TranscriptEvent, str, int, bool]] = []
    utterance_start = 0
    for event in ordered:
        rewrite = False
        delta_start = event.audio_start_ns
        prefix = 0
        if previous is not None and event.audio_start_ns < previous.audio_end_ns:
            prefix = _longest_common_prefix(previous.text, event.text)
            remove = len(previous.text) - prefix
            rewrite = remove > 0
            delta_start = previous.audio_end_ns
            while remove and len(chunks) > utterance_start:
                source, text, start, changed = chunks.pop()
                delta_start = start
                if len(text) > remove:
                    chunks.append((source, text[:-remove], start, changed or rewrite))
                    remove = 0
                else:
                    remove -= len(text)
        else:
            utterance_start = len(chunks)
        delta = event.text[prefix:]
        if delta:
            chunks.append((event, delta, delta_start, rewrite))
        previous = event

    for event, delta, start, rewrite in chunks:
        if current_end is not None and (
            (start >= current_end and event.audio_end_ns - current_end >= pause_ns)
            or event.audio_end_ns - current_start >= max_segment_ns
        ):
            flush()
        if current_start is None:
            current_start = max(start, 0)
        current_end = max(event.audio_end_ns, current_start + 1)
        current_raw.append(delta)
        current_sequences.append(event.sequence_no)
        current_rewrite |= rewrite
    flush()
    return segments


def load_bindings(profile_path: Path) -> tuple[dict[str, Any], list[AxisBinding], list[str]]:
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    warnings: list[str] = []
    bindings: list[AxisBinding] = []
    for axis in profile.get("axes") or []:
        if not isinstance(axis, dict) or axis.get("control_role") not in ALLOWED_ROLES:
            continue
        axis_id = str(axis.get("id") or "").strip()
        raw_range = axis.get("value_range")
        neutral = _finite(axis.get("neutral"))
        if (
            not axis_id
            or not isinstance(raw_range, list)
            or len(raw_range) != 2
            or _finite(raw_range[0]) is None
            or _finite(raw_range[1]) is None
            or raw_range[0] >= raw_range[1]
            or neutral is None
        ):
            warnings.append(f"invalid_axis:{axis_id or '<missing>'}")
            continue
        value_range = (float(raw_range[0]), float(raw_range[1]))
        for binding in axis.get("parameter_bindings") or []:
            if not isinstance(binding, dict):
                continue
            parameter_id = str(binding.get("parameter_id") or "").strip()
            input_range = binding.get("input_range")
            output_range = binding.get("output_range")
            if (
                not parameter_id
                or not isinstance(input_range, list)
                or len(input_range) != 2
                or not isinstance(output_range, list)
                or len(output_range) != 2
                or any(_finite(value) is None for value in (*input_range, *output_range))
            ):
                warnings.append(f"invalid_binding:{axis_id}")
                continue
            bindings.append(
                AxisBinding(
                    axis_id=axis_id,
                    neutral=min(value_range[1], max(value_range[0], float(neutral))),
                    value_range=value_range,
                    control_role=str(axis.get("control_role")),
                    parameter_id=parameter_id,
                    input_range=(float(input_range[0]), float(input_range[1])),
                    output_range=(float(output_range[0]), float(output_range[1])),
                    invert=bool(binding.get("invert", False)),
                )
            )
    if not bindings:
        raise ValueError(f"No primary/hint semantic bindings found in {profile_path}")
    return profile, bindings, warnings


def profile_axes(profile: dict[str, Any], bindings: list[AxisBinding]) -> list[dict[str, Any]]:
    axis_ids = {binding.axis_id for binding in bindings}
    axes: list[dict[str, Any]] = []
    for axis in profile.get("axes") or []:
        if not isinstance(axis, dict) or str(axis.get("id") or "").strip() not in axis_ids:
            continue
        item: dict[str, Any] = {
            "id": str(axis["id"]),
            "label": str(axis.get("label") or axis["id"]),
            "value_range": [float(axis["value_range"][0]), float(axis["value_range"][1])],
            "neutral": float(axis.get("neutral", 50.0)),
        }
        for key in ("negative_semantics", "positive_semantics", "usage_notes"):
            if axis.get(key) not in (None, "", []):
                item[key] = axis[key]
        axes.append(item)
    return axes


def _inverse_binding(
    raw_value: Any,
    binding: AxisBinding,
    warnings: set[str],
) -> float | None:
    value = _finite(raw_value)
    if value is None:
        return None
    output_min, output_max = binding.output_range
    input_min, input_max = binding.input_range
    output_span = output_max - output_min
    if output_span == 0 or input_max == input_min:
        warnings.add(f"zero_binding_span:{binding.axis_id}:{binding.parameter_id}")
        return None
    ratio = (value - output_min) / output_span
    if ratio < 0.0 or ratio > 1.0:
        warnings.add(f"raw_out_of_range:{binding.axis_id}:{binding.parameter_id}")
    ratio = min(1.0, max(0.0, ratio))
    if binding.invert:
        ratio = 1.0 - ratio
    mapped = input_min + (input_max - input_min) * ratio
    low, high = binding.value_range
    return round(min(high, max(low, mapped)), 3)


def _frame_axes(
    raw_values: dict[str, Any],
    bindings: list[AxisBinding],
    warnings: set[str],
) -> dict[str, float]:
    values: dict[str, list[float]] = {}
    for binding in bindings:
        mapped = _inverse_binding(raw_values.get(binding.parameter_id), binding, warnings)
        if mapped is not None:
            values.setdefault(binding.axis_id, []).append(mapped)
    return {
        axis_id: round(sum(axis_values) / len(axis_values), 3)
        for axis_id, axis_values in values.items()
        if axis_values
    }


def select_keyframes(
    usable: list[tuple[int, dict[str, float]]], ranges: dict[str, float], limit: int
) -> list[int]:
    # Preserve the largest departures from linear motion in timestamp order.
    # This retains an out-and-back gesture even when its window median is neutral.
    selected = [0]
    if len(usable) > 1:
        selected.append(len(usable) - 1)
    while len(selected) < limit:
        best_error, best_index = 0.03, None
        for left, right in zip(selected, selected[1:]):
            t0, first = usable[left]
            t1, last = usable[right]
            for index in range(left + 1, right):
                t, values = usable[index]
                fraction = (t - t0) / max(1, t1 - t0)
                for axis, value in values.items():
                    initial = first.get(axis, value)
                    expected = initial + (last.get(axis, initial) - initial) * fraction
                    error = abs(value - expected) / ranges.get(axis, 100.0)
                    if error > best_error:
                        best_error, best_index = error, index
        if best_index is None:
            break
        selected.append(best_index)
        selected.sort()

    return selected


def iter_segment_frames(
    connection: sqlite3.Connection,
    take_id: int,
    source: str,
    segments: list[TextSegment],
    bindings: list[AxisBinding],
    offset_column: str,
) -> Iterable[tuple[TextSegment, list[tuple[int, dict[str, float]]]]]:
    if offset_column not in {"scheduled_offset_ns", "sent_offset_ns", "received_offset_ns"}:
        raise ValueError(f"Unsupported frame offset column: {offset_column}")
    rows = iter(connection.execute(
        f"SELECT {offset_column}, values_json FROM parameter_frames "
        "WHERE take_id = ? AND source = ? ORDER BY sequence_no", (take_id, source)
    ))
    row = next(rows, None)
    for segment in segments:
        frames = []
        warnings: set[str] = set()
        while row is not None and row[0] <= segment.end_ns:
            if row[0] >= segment.start_ns:
                try:
                    raw = json.loads(row[1])
                except (ValueError, TypeError):
                    raw = None
                if isinstance(raw, dict):
                    mapped = _frame_axes(raw, bindings, warnings)
                    if mapped:
                        frames.append((row[0], mapped))
                else:
                    warnings.add("frame_values_not_object")
            row = next(rows, None)
        segment.mapping_warnings.extend(sorted(warnings))
        segment.frame_count = len(frames)
        yield segment, frames
