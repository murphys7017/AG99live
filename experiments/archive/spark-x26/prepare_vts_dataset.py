from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import sqlite3
import sys
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT.parents[2]))

from experiments.vts_recording import (  # noqa: E402
    DEFAULT_PROFILE, MAX_DURATION_MS, MAX_MOTION_STEPS, AxisBinding, TextSegment,
    build_text_segments, iter_segment_frames, load_bindings, load_transcript,
    profile_axes, select_keyframes,
)

MIN_DURATION_MS = 320
TRAINING_SYSTEM_PROMPT = """You generate one AG99live training action JSON object from the supplied dialogue context. Return only JSON, with no markdown or explanation. The output must contain exactly two fields: motion_steps and duration_hint_ms. motion_steps must contain 1 to 8 steps in playback order, including one step even for a single stable pose. Use 2 to 4 steps for ordinary actions and 5 to 8 only when the segment has a longer, clearly staged action. Every step must contain exactly axis_values and duration_weight. axis_values maps semantic axis IDs to concrete numeric values inside each axis value_range; do not use discrete levels or axis_levels. duration_weight is an integer from 1 to 3. duration_hint_ms is an integer from 320 to 15000 and is required. Keep steps sparse: write only axes that start or change in that step. Do not output motion_guidance, neurobrain_state, intent_tags, resource IDs, schema metadata, or any other field."""

def _read_only_connection(path: Path) -> sqlite3.Connection:
    uri = f"file:{path.resolve().as_posix()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    return connection


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
    usable = [(t, values) for t, values in frames if values]
    if not usable:
        return None, ["no_parameter_frames"]
    ranges = {b.axis_id: max(1e-6, b.value_range[1] - b.value_range[0]) for b in bindings}
    selected = select_keyframes(usable, ranges, MAX_MOTION_STEPS)

    steps: list[dict[str, Any]] = []
    times: list[int] = []
    previous: dict[str, float] = {}
    for index in selected:
        timestamp, pose = usable[index]
        changed = {
            axis: value for axis, value in pose.items()
            if axis not in previous or abs(value - previous[axis]) >= 0.01 * ranges.get(axis, 100.0)
        }
        if changed:
            steps.append({"axis_values": changed, "duration_weight": 1})
            times.append(timestamp)
            previous.update(changed)
    durations = [max(1, stop - start) for start, stop in zip(times, times[1:] + [end_ns])]
    for step, duration in zip(steps, durations):
        step["duration_weight"] = max(1, min(3, round(3 * duration / max(durations))))
    if not steps:
        return None, ["all_frames_neutral"]
    return {"motion_steps": steps, "duration_hint_ms": int(duration_ms)}, sorted(warnings)


def _load_motion_frames(
    connection: sqlite3.Connection,
    take_id: int,
    source: str,
    segments: list[TextSegment],
    bindings: list[AxisBinding],
    offset_column: str,
) -> None:
    for segment, frames in iter_segment_frames(
        connection, take_id, source, segments, bindings, offset_column
    ):
        segment.motion_target, warnings = _make_motion_target(
            frames, bindings, segment.start_ns, segment.end_ns
        )
        segment.mapping_warnings.extend(warnings)


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

    profile, bindings, profile_warnings = load_bindings(args.profile)
    capability = {
        "axis_value_format": "axis_values",
        "motion_plan_limits": {"min_motion_steps": 1, "max_motion_steps": MAX_MOTION_STEPS},
        "axes": profile_axes(profile, bindings),
    }
    connection = _read_only_connection(args.db)
    try:
        events = load_transcript(connection, args.take_id)
        segments = build_text_segments(
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
