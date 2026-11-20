"""Export reviewable speech-to-expression pairs from local SQLite snapshots."""

from __future__ import annotations

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory

from vts_recording import (
    DEFAULT_PROFILE,
    MAX_DURATION_MS,
    MAX_MOTION_STEPS,
    profile_axes,
    build_text_segments,
    load_bindings,
    load_transcript,
    iter_segment_frames,
    select_keyframes,
)

PROJECT_ROOT = Path(__file__).resolve().parent
AXES_MARKER = "\n可用轴："
PROMPT = (
    "为桌宠设计跟随当前台词的连续表情。只输出1至8步的JSON数组。"
    "每步ms表示到达目标姿态的正整数毫秒，总计至多15000毫秒。"
    "轴名和ms并列，仅写变化的轴，省略的轴保持，只有ms表示停留。"
    "按短语和重音安排变化，日常说话头部轻动，身体自然微动。"
)


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def validate(points, axes):
    if not isinstance(points, list) or not 1 <= len(points) <= MAX_MOTION_STEPS:
        raise ValueError("timed_array_required")
    ranges = {a["id"]: a["value_range"] for a in axes}
    elapsed = 0
    for point in points:
        if (
            not isinstance(point, dict)
            or type(point.get("ms")) is not int
            or point["ms"] <= 0
        ):
            raise ValueError("invalid_step_ms")
        elapsed += point["ms"]
        for axis, value in point.items():
            if axis == "ms":
                continue
            if (
                axis not in ranges
                or type(value) not in (float, int)
                or not ranges[axis][0] <= value <= ranges[axis][1]
            ):
                raise ValueError("invalid_axis_value")
    if elapsed > MAX_DURATION_MS:
        raise ValueError("duration_exceeds_contract")
    if not any(len(point) > 1 for point in points):
        raise ValueError("no_expression_axes")


class Candidates:
    def __init__(self, records, manifest):
        self.database = ""
        self.records = records
        self.manifest = manifest
        self.sample_ids = set()
        self.counts = Counter()
        self.skipped = Counter()

    def add(self, provenance, user, segment, axes, points):
        validate(points, axes)
        sample_id = provenance["sample_id"]
        if sample_id in self.sample_ids:
            self.skipped["duplicate_sample_id"] += 1
            return
        messages = [
            {"role": "system", "content": PROMPT + AXES_MARKER + compact(axes)},
            {"role": "user", "content": compact({"user": user, "segment": segment})},
            {"role": "assistant", "content": compact(points)},
        ]
        row = compact({"messages": messages})
        manifest_row = compact({
            **provenance,
            "database": self.database,
            "line": len(self.sample_ids) + 1,
            "record_sha256": digest(row),
            "review_status": "needs_review",
            "motion_ms": sum(p["ms"] for p in points),
        })
        self.records.write(row + "\n")
        self.manifest.write(manifest_row + "\n")
        self.sample_ids.add(sample_id)
        self.counts[provenance["source"]] += 1


def teacher_candidates(db, output, provider_ids):
    # A retried sample has one authoritative final result, even if it failed.
    rows = db.execute("""
        WITH finals AS (
          SELECT id,
                 row_number() OVER (
                   PARTITION BY json_extract(raw_json,'$.sample_id')
                   ORDER BY created_at DESC, id DESC
                 ) AS rank
          FROM motion_lab_raw_events
          WHERE event_type='motion.persona_sample.v1' AND json_valid(raw_json)
            AND json_extract(raw_json,'$.record_stage')='motion_result'
            AND json_extract(raw_json,'$.motion.provider_final')=1
        )
        SELECT e.raw_json, e.created_at, e.source_route, e.profile_hash, e.transform_version
        FROM finals f JOIN motion_lab_raw_events e ON e.id=f.id
        WHERE f.rank=1 ORDER BY e.created_at, e.id
    """)
    for row in rows:
        event = json.loads(row["raw_json"])
        motion = event["motion"]
        provider = motion.get("provider_id") or ""
        if provider not in provider_ids:
            output.skipped["other_provider"] += 1
            continue
        accepted = motion.get("accepted_payload")
        if motion.get("status") != "provider_normalized" or not isinstance(
            accepted, dict
        ):
            output.skipped["generation_failed"] += 1
            continue
        try:
            raw_output = motion.get("raw_output")
            if not isinstance(raw_output, dict):
                raise ValueError("legacy_or_missing_timed_array")
            points = json.loads(raw_output.get("provider_text") or "null")
            if not isinstance(points, list):
                raise ValueError("legacy_or_missing_timed_array")
            request = event["input"]["motion_request"]
            system = request["system_prompt"]
            if AXES_MARKER not in system:
                raise ValueError("missing_recorded_axes")
            axes, _ = json.JSONDecoder().raw_decode(
                system.split(AXES_MARKER, 1)[1].lstrip()
            )
            prompt = json.loads(request["prompt"])
            segment = {
                k: prompt["segment"][k]
                for k in ("speech", "actions", "tendency", "estimated_speech_ms")
                if k in prompt["segment"]
            }
            if (
                not isinstance(segment.get("speech"), str)
                or not segment["speech"].strip()
            ):
                raise ValueError("missing_speech")
            if not event.get("sample_id"):
                raise ValueError("missing_sample_id")
            accepted_steps = accepted.get("motion_steps")
            if not isinstance(accepted_steps, list) or not all(
                isinstance(step, dict)
                and set(step) == {"ms", "axis_values"}
                and isinstance(step["axis_values"], dict)
                for step in accepted_steps
            ):
                raise ValueError("missing_accepted_timing")
            if points != [
                {"ms": step["ms"], **step["axis_values"]} for step in accepted_steps
            ]:
                raise ValueError("accepted_steps_differ")
            output.add(
                {
                    "source": "deepseek",
                    "sample_id": "motion:" + event["sample_id"],
                    "provider": provider,
                    "created_at": row["created_at"],
                    "identity": event["identity"],
                    "source_route": row["source_route"],
                    "prompt_sha256": digest(system),
                    "profile_id": accepted.get("profile_id"),
                    "profile_revision": accepted.get("profile_revision"),
                    "profile_hash": row["profile_hash"],
                    "transform_version": row["transform_version"],
                },
                prompt.get("user", ""),
                segment,
                axes,
                points,
            )
        except (ValueError, TypeError, KeyError) as exc:
            reason = str(exc) if type(exc) is ValueError else "malformed_teacher_record"
            output.skipped[reason] += 1


def timed_curve(segment, frames, bindings, hz):
    duration = round((segment.end_ns - segment.start_ns) / 1_000_000)
    if not 1 <= duration <= MAX_DURATION_MS or len(frames) < 2:
        raise ValueError("missing_frames_or_invalid_window")
    # Do not interpolate a tracker dropout into the label.
    times = [segment.start_ns, *(t for t, _ in frames), segment.end_ns]
    gaps = [b - a for a, b in zip(times, times[1:])]
    if min(gaps) < 0 or max(gaps) > 3 * 1_000_000_000 / hz:
        raise ValueError("incomplete_frame_coverage")
    ranges = {b.axis_id: b.value_range[1] - b.value_range[0] for b in bindings}
    previous = {b.axis_id: b.neutral for b in bindings}
    # Merge timestamps that quantize to one millisecond. Zero is represented by
    # the earliest executable target (1 ms). Preserve any measured tail as a hold.
    poses = {}
    for timestamp, pose in frames:
        at = max(1, round((timestamp - segment.start_ns) / 1_000_000))
        poses[at] = pose
    timeline = list(poses.items())
    tail = duration - timeline[-1][0]
    chosen = select_keyframes(timeline, ranges, MAX_MOTION_STEPS - int(tail > 0))
    points = []
    last = 0
    for i in chosen:
        at, pose = timeline[i]
        changes = {
            axis: value
            for axis, value in pose.items()
            if abs(value - previous[axis]) >= 0.01 * ranges[axis]
        }
        if not changes and points and len(points[-1]) == 1:
            points[-1]["ms"] += at - last
        else:
            points.append({"ms": at - last, **changes})
        last = at
        previous.update(changes)
    if tail:
        if len(points[-1]) == 1:
            points[-1]["ms"] += tail
        else:
            points.append({"ms": tail})
    return points


def vts_candidates(
    db, output, profile, bindings, axes, profile_hash, model_name, include_open
):
    takes = db.execute("""
        SELECT t.id, t.status, t.started_at_utc, s.initial_model_name, s.initial_model_id, s.requested_hz
        FROM recording_takes t JOIN recording_sessions s ON s.id=t.session_id ORDER BY t.id
    """)
    for take in takes:
        if take["status"] == "recording" and not include_open:
            output.skipped["open_take"] += 1
            continue
        if take["initial_model_name"] != model_name:
            output.skipped["different_vts_model"] += 1
            continue
        take_id = take["id"]
        models = {
            r[0]
            for r in db.execute(
                "SELECT DISTINCT model_id FROM parameter_frames WHERE take_id=? AND source='live2d_parameter'",
                (take_id,),
            )
        }
        if (
            models != {take["initial_model_id"]}
            or not models
            or not take["initial_model_id"]
        ):
            output.skipped["missing_or_mixed_model_frames"] += 1
            continue
        hz = take["requested_hz"]
        if type(hz) not in (int, float) or not math.isfinite(hz) or hz <= 0:
            output.skipped["invalid_recorded_sampling_rate"] += 1
            continue
        segments = build_text_segments(
            load_transcript(db, take_id),
            pause_ms=1500,
            max_segment_ms=12000,
            min_text_chars=2,
        )
        if not segments:
            output.skipped["take_without_speech_segments"] += 1
        for segment, frames in iter_segment_frames(
            db, take_id, "live2d_parameter", segments, bindings, "received_offset_ns"
        ):
            try:
                if segment.mapping_warnings:
                    raise ValueError("vts_mapping_warning")
                points = timed_curve(segment, frames, bindings, hz)
                recording = f"{take['started_at_utc']}:{take_id}"
                output.add(
                    {
                        "source": "vts",
                        "sample_id": f"vts:{recording}:{segment.start_ns}:{segment.end_ns}",
                        "recording": recording,
                        "take_status": take["status"],
                        "vts_model_id": take["initial_model_id"],
                        "profile_id": profile["profile_id"],
                        "profile_revision": profile["revision"],
                        "profile_hash": profile_hash,
                        "segment_no": segment.segment_no,
                        "frame_count": len(frames),
                        "audio_start_ns": segment.start_ns,
                        "audio_end_ns": segment.end_ns,
                        "asr_sequences": segment.source_sequences,
                        "asr_rewritten": segment.rewrite_detected,
                    },
                    "",
                    {"speech": segment.clean_text, "actions": [], "tendency": {}},
                    axes,
                    points,
                )
            except ValueError as exc:
                output.skipped[str(exc)] += 1


def snapshot(path):
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("BEGIN")
    return db


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--motion-db", type=Path)
    parser.add_argument(
        "--provider-id", action="append", help="Exact teacher provider ID (repeatable)"
    )
    parser.add_argument("--vts-db", action="append", type=Path, default=[])
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument(
        "--vts-model-name",
        default="Mk6",
        help="Recorded VTS name corresponding to --profile",
    )
    parser.add_argument(
        "--include-open-takes",
        action="store_true",
        help="Salvage complete windows from open takes",
    )
    parser.add_argument("--output-dir", type=Path, help="New snapshot directory")
    args = parser.parse_args()
    if not (args.motion_db or args.vts_db):
        parser.error("supply --motion-db or --vts-db")
    destination = args.output_dir or PROJECT_ROOT / "data" / "timed" / datetime.now(
        timezone.utc
    ).strftime("%Y%m%dT%H%M%S%fZ")
    if destination.exists():
        parser.error(f"snapshot already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    providers = args.provider_id or [
        "deepseek-nothink/deepseek-flash",
        "deepseek-nothink/deepseek-v4-flash",
    ]
    with TemporaryDirectory(dir=destination.parent) as temporary:
        folder = Path(temporary) / "snapshot"
        folder.mkdir()
        sources = []
        with (
            (folder / "candidates.jsonl").open(
                "w", encoding="utf-8", newline="\n"
            ) as records,
            (folder / "manifest.jsonl").open(
                "w", encoding="utf-8", newline="\n"
            ) as manifest,
        ):
            output = Candidates(records, manifest)
            if args.motion_db:
                output.database = str(args.motion_db.resolve())
                with closing(snapshot(args.motion_db)) as db:
                    teacher_candidates(db, output, providers)
                sources.append(str(args.motion_db.resolve()))
            if args.vts_db:
                profile, bindings, warnings = load_bindings(args.profile)
                if warnings:
                    raise ValueError(f"incomplete axis bindings: {warnings}")
                axes = profile_axes(profile, bindings)
                profile_hash = hashlib.sha256(args.profile.read_bytes()).hexdigest()
                for path in args.vts_db:
                    output.database = str(path.resolve())
                    with closing(snapshot(path)) as db:
                        vts_candidates(
                            db,
                            output,
                            profile,
                            bindings,
                            axes,
                            profile_hash,
                            args.vts_model_name,
                            args.include_open_takes,
                        )
                    sources.append(str(path.resolve()))
        report = {
            "schema": "timed_expression_candidates.v1",
            "sources": sources,
            "candidates": output.counts,
            "skipped": output.skipped,
        }
        (folder / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        folder.rename(destination)
    print(destination.resolve())
    print(compact(report))


if __name__ == "__main__":
    main()
