from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


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


def _load_luna_rows(paths: list[Path]) -> dict[int, dict[str, Any]]:
    result: dict[int, dict[str, Any]] = {}
    for path in paths:
        for row in _read_jsonl(path):
            raw_id = row.get("segment_no")
            if type(raw_id) is not int or raw_id < 0:
                raise ValueError(f"{path}: invalid segment_no: {raw_id!r}")
            if raw_id in result:
                raise ValueError(f"duplicate Luna segment_no: {raw_id}")
            clean_text = row.get("clean_text")
            if not isinstance(clean_text, str) or not clean_text.strip():
                raise ValueError(f"{path}: empty clean_text for segment {raw_id}")
            confidence = row.get("text_confidence", "low")
            if confidence not in {"high", "medium", "low"}:
                raise ValueError(f"{path}: invalid confidence for segment {raw_id}")
            result[raw_id] = row
    return result


def _replace_speech(record: dict[str, Any], clean_text: str) -> dict[str, Any]:
    messages = record.get("messages")
    if not isinstance(messages, list) or len(messages) < 3:
        raise ValueError("candidate record has invalid messages")
    updated = json.loads(json.dumps(record, ensure_ascii=False))
    user_message = next(
        (message for message in updated["messages"] if isinstance(message, dict) and message.get("role") == "user"),
        None,
    )
    if not isinstance(user_message, dict) or not isinstance(user_message.get("content"), str):
        raise ValueError("candidate record is missing user message")
    payload = json.loads(user_message["content"])
    if not isinstance(payload, dict) or not isinstance(payload.get("segment"), dict):
        raise ValueError("candidate user content is not the compact training prompt")
    payload["segment"]["speech"] = clean_text.strip()
    user_message["content"] = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return updated


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply Luna ASR text cleanup to VTS candidates.")
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--luna-cleaned", type=Path, nargs="+", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    candidates = _read_jsonl(args.candidate)
    manifest = _read_jsonl(args.manifest)
    luna = _load_luna_rows(args.luna_cleaned)
    if len(candidates) != len(manifest):
        raise ValueError(f"candidate/manifest length mismatch: {len(candidates)} != {len(manifest)}")
    manifest_by_id = {}
    for row in manifest:
        segment_no = row.get("segment_no")
        if type(segment_no) is not int or segment_no in manifest_by_id:
            raise ValueError(f"invalid or duplicate manifest segment_no: {segment_no!r}")
        manifest_by_id[segment_no] = row
    candidate_ids = sorted(manifest_by_id)
    if set(candidate_ids) != set(luna):
        missing = sorted(set(candidate_ids) - set(luna))
        extra = sorted(set(luna) - set(candidate_ids))
        raise ValueError(f"Luna coverage mismatch; missing={missing[:10]}, extra={extra[:10]}")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    candidate_path = args.output_dir / "vts_luna_sft.jsonl"
    manifest_path = args.output_dir / "vts_luna_review_manifest.jsonl"
    info_path = args.output_dir / "dataset_info.json"
    updated_candidates: list[dict[str, Any]] = []
    updated_manifest: list[dict[str, Any]] = []
    for candidate, manifest_row in zip(candidates, manifest):
        segment_no = int(manifest_row["segment_no"])
        luna_row = luna[segment_no]
        updated_candidates.append(_replace_speech(candidate, str(luna_row["clean_text"])))
        updated_row = dict(manifest_row)
        updated_row["raw_text"] = manifest_row.get("raw_text", "")
        updated_row["clean_text"] = str(luna_row["clean_text"])
        updated_row["text_status"] = str(luna_row.get("text_status", "luna_conservative"))
        updated_row["text_confidence"] = str(luna_row.get("text_confidence", "low"))
        updated_row["text_processor"] = "luna"
        updated_row["text_reason"] = str(luna_row.get("reason", ""))
        updated_row["training_eligible"] = False
        updated_row["review_status"] = "needs_review"
        updated_manifest.append(updated_row)

    with candidate_path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in updated_candidates:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    with manifest_path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in updated_manifest:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    info_path.write_text(
        json.dumps(
            {
                "dataset": "ag99_vts_speech_motion_luna_candidate",
                "candidate_file": candidate_path.name,
                "manifest_file": manifest_path.name,
                "text_processor": "luna",
                "training_eligible_by_default": False,
                "records": len(updated_candidates),
                "output_fields": ["motion_steps", "duration_hint_ms"],
                "review_policy": "Review the Luna-cleaned text before merging into continuous_sft.jsonl.",
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"candidate": str(candidate_path.resolve()), "records": len(updated_candidates)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
