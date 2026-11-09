from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import sys
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


PROJECT_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = PROJECT_ROOT.parents[1]

DEFAULT_PROFILE = (
    Path(r"C:\Users\Administrator\Downloads\AstrBot\data\plugins")
    / "astrbot_plugin_ag99live_adapter"
    / "live2ds"
    / "Mk6_1.0"
    / "ag99"
    / "semantic_axis_profile.json"
)

TRAINING_SYSTEM_PROMPT = """You generate one AG99live training action JSON object from the supplied dialogue context. Return only JSON, with no markdown or explanation. The output must contain exactly two fields: motion_steps and duration_hint_ms. motion_steps must contain 1 to 4 steps in playback order, including one step even for a single stable pose. Every step must contain exactly axis_values and duration_weight. axis_values maps semantic axis IDs to concrete numeric values inside each axis value_range; do not use discrete levels or axis_levels. duration_weight is an integer from 1 to 3. duration_hint_ms is an integer from 320 to 15000 and is required. Keep steps sparse: write only axes that start or change in that step. Do not output motion_guidance, neurobrain_state, intent_tags, resource IDs, schema metadata, or any other field."""

FILLER_RE = re.compile(r"([啊嗯呃哦唉哎])\1{2,}")
WHITESPACE_RE = re.compile(r"\s+")
ALLOWED_ROLES = {"primary", "hint"}
MIN_DURATION_MS = 320
MAX_DURATION_MS = 15000


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


def _read_only_connection(path: Path) -> sqlite3.Connection:
    uri = f"file:{path.resolve().as_posix()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    return connection


def _load_transcript(connection: sqlite3.Connection, take_id: int) -> list[TranscriptEvent]:
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


def _build_text_segments(
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

    for event in ordered:
        if previous is None:
            delta = event.text
            delta_start = event.audio_start_ns
        elif event.text.startswith(previous.text):
            delta = event.text[len(previous.text) :]
            delta_start = previous.audio_end_ns
        else:
            common = _longest_common_prefix(previous.text, event.text)
            delta = event.text[common:]
            delta_start = previous.audio_end_ns
            current_rewrite = True
        if not delta:
            previous = event
            continue

        pause_boundary = (
            previous is not None
            and event.audio_end_ns - previous.audio_end_ns >= pause_ns
        )
        duration_boundary = (
            current_start is not None
            and event.audio_end_ns - current_start >= max_segment_ns
        )
        if pause_boundary or duration_boundary:
            flush()

        if current_start is None:
            current_start = max(delta_start, 0)
        current_end = max(event.audio_end_ns, current_start + 1)
        current_raw.append(delta)
        current_sequences.append(event.sequence_no)
        previous = event
    flush()
    return segments


def _load_bindings(profile_path: Path) -> tuple[dict[str, Any], list[AxisBinding], list[str]]:
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


def _axis_capability(profile: dict[str, Any], bindings: list[AxisBinding]) -> dict[str, Any]:
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
    return {
        "axis_value_format": "axis_values",
        "motion_plan_limits": {"min_motion_steps": 1, "max_motion_steps": 4},
        "axes": axes,
    }


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


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def _make_motion_target(
    frames: list[tuple[int, dict[str, float]]],
    bindings: list[AxisBinding],
    start_ns: int,
    end_ns: int,
) -> tuple[dict[str, Any] | None, list[str]]:
    warnings: set[str] = set()
    if not frames:
        return None, ["no_parameter_frames"]
    duration_ms = max(MIN_DURATION_MS, min(MAX_DURATION_MS, round((end_ns - start_ns) / 1_000_000)))
    step_count = max(1, min(4, math.ceil(duration_ms / 1800)))
    span = max(1, end_ns - start_ns)
    windows: list[list[tuple[int, dict[str, float]]]] = [[] for _ in range(step_count)]
    for timestamp_ns, values in frames:
        index = int(((timestamp_ns - start_ns) * step_count) / span)
        windows[min(step_count - 1, max(0, index))].append((timestamp_ns, values))
    neutral_by_axis = {binding.axis_id: binding.neutral for binding in bindings}
    steps: list[dict[str, Any]] = []
    previous_values: dict[str, float] = {}
    for window in windows:
        axis_samples: dict[str, list[float]] = {}
        for _, values in window:
            for axis_id, value in values.items():
                axis_samples.setdefault(axis_id, []).append(value)
        medians = {axis_id: round(_median(values), 3) for axis_id, values in axis_samples.items()}
        sparse: dict[str, float] = {}
        for axis_id, value in medians.items():
            neutral = neutral_by_axis.get(axis_id, 50.0)
            change = abs(value - previous_values.get(axis_id, neutral))
            if abs(value - neutral) >= 3.0 or change >= 3.0:
                sparse[axis_id] = value
        if not sparse and medians:
            axis_id, value = max(
                medians.items(),
                key=lambda item: abs(item[1] - neutral_by_axis.get(item[0], 50.0)),
            )
            sparse[axis_id] = value
        if sparse:
            steps.append({"axis_values": sparse, "duration_weight": 1})
            previous_values.update(sparse)
    if not steps:
        return None, ["all_frames_neutral"]
    return {"motion_steps": steps[:4], "duration_hint_ms": int(duration_ms)}, sorted(warnings)


def _load_motion_frames(
    connection: sqlite3.Connection,
    take_id: int,
    source: str,
    segments: list[TextSegment],
    bindings: list[AxisBinding],
    offset_column: str,
) -> None:
    if offset_column not in {"scheduled_offset_ns", "sent_offset_ns", "received_offset_ns"}:
        raise ValueError(f"Unsupported frame offset column: {offset_column}")
    segment_index = 0
    segment_frames: list[tuple[int, dict[str, float]]] = []

    def finalize_until(timestamp_ns: int) -> None:
        nonlocal segment_index, segment_frames
        while segment_index < len(segments) and timestamp_ns > segments[segment_index].end_ns:
            segment = segments[segment_index]
            target, warnings = _make_motion_target(
                segment_frames, bindings, segment.start_ns, segment.end_ns
            )
            segment.motion_target = target
            segment.frame_count = len(segment_frames)
            segment.mapping_warnings.extend(warnings)
            segment_index += 1
            segment_frames = []
        if segment_index >= len(segments):
            return
        segment = segments[segment_index]
        if timestamp_ns < segment.start_ns:
            return

    query = (
        "SELECT "
        + offset_column
        + ", values_json FROM parameter_frames "
        "WHERE take_id = ? AND source = ? ORDER BY sequence_no"
    )
    for row in connection.execute(query, (take_id, source)):
        timestamp_ns = max(int(row[0]), 0)
        finalize_until(timestamp_ns)
        if segment_index >= len(segments):
            break
        segment = segments[segment_index]
        if timestamp_ns < segment.start_ns or timestamp_ns > segment.end_ns:
            continue
        raw_values = json.loads(row[1])
        if not isinstance(raw_values, dict):
            segment.mapping_warnings.append("frame_values_not_object")
            continue
        warnings: set[str] = set()
        mapped = _frame_axes(raw_values, bindings, warnings)
        segment.mapping_warnings.extend(sorted(warnings))
        if mapped:
            segment_frames.append((timestamp_ns, mapped))
    while segment_index < len(segments):
        segment = segments[segment_index]
        target, warnings = _make_motion_target(
            segment_frames, bindings, segment.start_ns, segment.end_ns
        )
        segment.motion_target = target
        segment.frame_count = len(segment_frames)
        segment.mapping_warnings.extend(warnings)
        segment_index += 1
        segment_frames = []


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _training_record(
    segment: TextSegment,
    capability: dict[str, Any],
) -> dict[str, Any] | None:
    if not segment.clean_text or not segment.motion_target:
        return None
    user_payload = {
        "user": "",
        "segment": {
            "speech": segment.clean_text,
            "actions": [],
            "tendency": {},
        },
    }
    return {
        "messages": [
            {
                "role": "system",
                "content": TRAINING_SYSTEM_PROMPT
                + "\n\nLive2D 能力：\n"
                + _stable_json(capability),
            },
            {"role": "user", "content": _stable_json(user_payload)},
            {"role": "assistant", "content": _stable_json(segment.motion_target)},
        ]
    }


def _manifest_row(segment: TextSegment) -> dict[str, Any]:
    return {
        "segment_no": segment.segment_no,
        "raw_text": segment.raw_text,
        "clean_text": segment.clean_text,
        "text_status": segment.text_status,
        "text_confidence": segment.text_confidence,
        "rewrite_detected": segment.rewrite_detected,
        "source_sequences": segment.source_sequences,
        "audio_start_offset_ns": segment.start_ns,
        "audio_end_offset_ns": segment.end_ns,
        "duration_ms": round((segment.end_ns - segment.start_ns) / 1_000_000),
        "frame_count": segment.frame_count,
        "mapping_warnings": sorted(set(segment.mapping_warnings)),
        "motion_target": segment.motion_target,
        "training_eligible": False,
        "review_status": "needs_review",
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build reviewable VTS speech-to-motion candidates in AG99live training format."
    )
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--take-id", type=int, default=1)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=PROJECT_ROOT / "data" / "vts_candidate",
    )
    parser.add_argument("--pause-ms", type=int, default=1500)
    parser.add_argument("--max-segment-ms", type=int, default=12000)
    parser.add_argument("--min-text-chars", type=int, default=2)
    parser.add_argument(
        "--frame-offset",
        choices=("scheduled_offset_ns", "sent_offset_ns", "received_offset_ns"),
        default="received_offset_ns",
    )
    parser.add_argument("--frame-source", default="live2d_parameter")
    args = parser.parse_args()

    if not args.db.is_file():
        raise SystemExit(f"VTS database not found: {args.db}")
    if not args.profile.is_file():
        raise SystemExit(f"Semantic axis profile not found: {args.profile}")

    profile, bindings, profile_warnings = _load_bindings(args.profile)
    capability = _axis_capability(profile, bindings)
    connection = _read_only_connection(args.db)
    try:
        events = _load_transcript(connection, args.take_id)
        segments = _build_text_segments(
            events,
            pause_ms=args.pause_ms,
            max_segment_ms=args.max_segment_ms,
            min_text_chars=args.min_text_chars,
        )
        _load_motion_frames(
            connection,
            args.take_id,
            args.frame_source,
            segments,
            bindings,
            args.frame_offset,
        )
    finally:
        connection.close()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    candidate_path = args.output_dir / "vts_candidate_sft.jsonl"
    manifest_path = args.output_dir / "vts_review_manifest.jsonl"
    info_path = args.output_dir / "dataset_info.json"
    records: list[dict[str, Any]] = []
    with candidate_path.open("w", encoding="utf-8", newline="\n") as candidate_stream, manifest_path.open(
        "w", encoding="utf-8", newline="\n"
    ) as manifest_stream:
        for segment in segments:
            record = _training_record(segment, capability)
            if record is not None:
                records.append(record)
                candidate_stream.write(json.dumps(record, ensure_ascii=False) + "\n")
            manifest_stream.write(
                json.dumps(_manifest_row(segment), ensure_ascii=False) + "\n"
            )

    stats = Counter()
    step_counts = Counter()
    warning_counts = Counter()
    for segment in segments:
        stats["segments"] += 1
        if segment.motion_target:
            stats["with_motion_target"] += 1
            step_counts[len(segment.motion_target["motion_steps"])] += 1
        else:
            stats["without_motion_target"] += 1
        for warning in set(segment.mapping_warnings):
            warning_counts[warning] += 1
    info = {
        "dataset": "ag99_vts_speech_motion_candidate",
        "candidate_file": candidate_path.name,
        "manifest_file": manifest_path.name,
        "format": "openai_messages",
        "training_eligible_by_default": False,
        "source": {
            "database": str(args.db.resolve()),
            "take_id": args.take_id,
            "profile": str(args.profile.resolve()),
            "frame_source": args.frame_source,
            "frame_offset": args.frame_offset,
        },
        "text": {
            "source": "stored_streaming_partial_events",
            "pause_ms": args.pause_ms,
            "max_segment_ms": args.max_segment_ms,
            "min_text_chars": args.min_text_chars,
            "profile_warnings": profile_warnings,
        },
        "stats": {
            **dict(stats),
            "candidate_records": len(records),
            "motion_step_counts": dict(sorted(step_counts.items())),
            "mapping_warning_counts": dict(warning_counts),
        },
        "output_fields": ["motion_steps", "duration_hint_ms"],
        "review_policy": "Review vts_review_manifest.jsonl before merging any candidate into continuous_sft.jsonl.",
    }
    info_path.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"candidate": str(candidate_path.resolve()), **info["stats"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
