from __future__ import annotations

import argparse
import json
import math
import random
from collections import Counter
from pathlib import Path
from typing import Any


FORBIDDEN_INPUT_FIELDS = ("motion_guidance", "neurobrain_state")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as stream:
        for line_no, line in enumerate(stream, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_no}: expected JSON object")
            rows.append(value)
    return rows


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _validate_training_record(record: dict[str, Any], *, source: str, index: int) -> None:
    messages = record.get("messages")
    if not isinstance(messages, list) or len(messages) < 3:
        raise ValueError(f"{source}[{index}] has invalid messages")
    assistant = messages[-1]
    if not isinstance(assistant, dict) or assistant.get("role") != "assistant":
        raise ValueError(f"{source}[{index}] has no assistant target")
    target = json.loads(str(assistant.get("content") or ""))
    if not isinstance(target, dict) or set(target) != {"motion_steps", "duration_hint_ms"}:
        raise ValueError(f"{source}[{index}] assistant target fields are invalid")
    duration = target["duration_hint_ms"]
    if type(duration) is not int or not 320 <= duration <= 15000:
        raise ValueError(f"{source}[{index}] duration_hint_ms is invalid")
    steps = target["motion_steps"]
    if not isinstance(steps, list) or not 1 <= len(steps) <= 4:
        raise ValueError(f"{source}[{index}] motion_steps length is invalid")
    for step in steps:
        if not isinstance(step, dict) or set(step) != {"axis_values", "duration_weight"}:
            raise ValueError(f"{source}[{index}] motion step fields are invalid")
        if type(step["duration_weight"]) is not int or not 1 <= step["duration_weight"] <= 3:
            raise ValueError(f"{source}[{index}] duration_weight is invalid")
        values = step["axis_values"]
        if not isinstance(values, dict) or not values:
            raise ValueError(f"{source}[{index}] axis_values is empty")
        if any(not isinstance(axis_id, str) or not axis_id.strip() for axis_id in values):
            raise ValueError(f"{source}[{index}] axis ID is invalid")
        if any(not _finite(value) or not 0.0 <= float(value) <= 100.0 for value in values.values()):
            raise ValueError(f"{source}[{index}] axis value is invalid")
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {"system", "user", "assistant"}:
            raise ValueError(f"{source}[{index}] message role is invalid")
        content = message.get("content")
        if not isinstance(content, str):
            raise ValueError(f"{source}[{index}] message content is invalid")
        if message.get("role") == "user" and any(field in content for field in FORBIDDEN_INPUT_FIELDS):
            raise ValueError(f"{source}[{index}] forbidden input state leaked into user content")


def _manifest_index(rows: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    result: dict[int, dict[str, Any]] = {}
    for row in rows:
        segment_no = row.get("segment_no")
        if type(segment_no) is not int or segment_no in result:
            raise ValueError(f"VTS manifest has invalid or duplicate segment_no: {segment_no!r}")
        result[segment_no] = row
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Merge historical and VTS AG99live SFT records.")
    parser.add_argument("--historical", type=Path, required=True)
    parser.add_argument("--vts", type=Path, required=True)
    parser.add_argument("--vts-manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--include-vts-review",
        action="store_true",
        help="include VTS rows marked needs_review/low confidence after validation",
    )
    parser.add_argument("--shuffle-seed", type=int, default=99)
    args = parser.parse_args()

    historical = _read_jsonl(args.historical)
    vts = _read_jsonl(args.vts)
    manifest = _manifest_index(_read_jsonl(args.vts_manifest))
    if len(vts) != len(manifest):
        raise ValueError(f"VTS candidate/manifest length mismatch: {len(vts)} != {len(manifest)}")

    combined: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    for index, record in enumerate(historical):
        _validate_training_record(record, source="historical", index=index)
        combined.append(record)
        sources.append({"source": "historical_motion_lab", "source_index": index})

    vts_confidence = Counter(str(row.get("text_confidence", "unknown")) for row in manifest.values())
    vts_review_status = Counter(str(row.get("review_status", "unknown")) for row in manifest.values())
    if not args.include_vts_review:
        accepted = [row for row in manifest.values() if row.get("review_status") == "accepted"]
        if len(accepted) != len(vts):
            raise ValueError(
                "VTS rows are still needs_review; pass --include-vts-review explicitly to merge them."
            )

    for index, record in enumerate(vts):
        _validate_training_record(record, source="vts", index=index)
        segment_no = index
        combined.append(record)
        sources.append(
            {
                "source": "vts_recorder",
                "source_index": index,
                "segment_no": segment_no,
                "text_confidence": manifest[segment_no].get("text_confidence"),
                "review_status": manifest[segment_no].get("review_status"),
            }
        )

    order = list(range(len(combined)))
    random.Random(args.shuffle_seed).shuffle(order)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    dataset_path = args.output_dir / "continuous_sft.jsonl"
    manifest_path = args.output_dir / "continuous_manifest.jsonl"
    info_path = args.output_dir / "dataset_info.json"
    with dataset_path.open("w", encoding="utf-8", newline="\n") as dataset_stream, manifest_path.open(
        "w", encoding="utf-8", newline="\n"
    ) as manifest_stream:
        for dataset_index, original_index in enumerate(order):
            dataset_stream.write(json.dumps(combined[original_index], ensure_ascii=False) + "\n")
            provenance = {
                "dataset_index": dataset_index,
                "original_index": original_index,
                **sources[original_index],
            }
            manifest_stream.write(json.dumps(provenance, ensure_ascii=False) + "\n")

    source_counts = Counter(item["source"] for item in sources)
    info_path.write_text(
        json.dumps(
            {
                "spark_x26_continuous": {
                    "file_name": dataset_path.name,
                    "formatting": "openai",
                    "columns": {"messages": "messages"},
                    "tags": {
                        "role_tag": "role",
                        "content_tag": "content",
                        "user_tag": "user",
                        "assistant_tag": "assistant",
                        "system_tag": "system",
                        "observation_tag": "tool",
                        "function_tag": "function",
                    },
                },
                "merge_report": {
                    "records": len(combined),
                    "source_counts": dict(source_counts),
                    "shuffle_seed": args.shuffle_seed,
                    "included_vts_review": args.include_vts_review,
                    "vts_confidence": dict(vts_confidence),
                    "vts_review_status": dict(vts_review_status),
                    "historical_file": str(args.historical.resolve()),
                    "vts_file": str(args.vts.resolve()),
                    "vts_manifest": str(args.vts_manifest.resolve()),
                },
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "dataset": str(dataset_path.resolve()),
                "records": len(combined),
                "source_counts": dict(source_counts),
                "shuffle_seed": args.shuffle_seed,
                "included_vts_review": args.include_vts_review,
                "vts_confidence": dict(vts_confidence),
                "vts_review_status": dict(vts_review_status),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
