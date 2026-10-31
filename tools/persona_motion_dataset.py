from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from collections import Counter, defaultdict
from collections.abc import Mapping
from pathlib import Path
from typing import Any


RAW_EVENT_SCHEMA_VERSION = "3"
SAMPLE_EVENT_TYPE = "motion.persona_sample.v1"
SAMPLE_SCHEMA = "ag99live.persona_motion_sample.v1"
REVIEW_SCHEMA = "ag99live.persona_motion_review.v2"
TRAINING_SCHEMA = "ag99live.persona_motion_training.v1"
SOURCE_ROUTES = ("persona_effect", "independent_motion")
DELIVERY_MODES = (
    "M0_nonstreaming",
    "M1_persona_segment_stream",
    "M2_olv_incremental",
)
TENDENCY_KEYS = (
    "Joy",
    "Trust",
    "Fear",
    "Surprise",
    "Sadness",
    "Disgust",
    "Anger",
    "Anticipation",
)
IDENTITY_FIELDS = (
    "turn_id",
    "core_turn_id",
    "persona_result_id",
    "segment_index",
    "segment_count",
    "segment_message_id",
)
PLAYBACK_EVENT_TYPES = (
    "motion.playback_started",
    "motion.playback_completed",
    "motion.playback_failed",
    "motion.frontend_compiled",
)
COLLECTION_STATUSES = {"open", "closed", "incomplete"}
QUALITY_STATUSES = {"reviewable", "blocked"}
REVIEW_STATUSES = {"pending", "approved", "rejected"}


class DatasetError(RuntimeError):
    pass


def _readonly_connection(db_path: Path) -> sqlite3.Connection:
    absolute_path = db_path.expanduser().resolve()
    connection_uri = f"{absolute_path.as_uri()}?mode=ro"
    try:
        connection = sqlite3.connect(connection_uri, uri=True, timeout=5.0)
    except sqlite3.Error as exc:
        raise DatasetError(f"cannot_open_database_read_only: {exc}") from exc
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    connection.execute("BEGIN")
    try:
        row = connection.execute(
            "SELECT value FROM motion_lab_meta WHERE key = 'schema_version'"
        ).fetchone()
    except sqlite3.Error as exc:
        connection.close()
        raise DatasetError(f"motion_lab_schema_metadata_unavailable: {exc}") from exc
    if row is None or str(row[0]) != RAW_EVENT_SCHEMA_VERSION:
        version = str(row[0]) if row is not None else "missing"
        connection.close()
        raise DatasetError(
            "unsupported_motion_lab_schema_version:"
            f"{version}:expected:{RAW_EVENT_SCHEMA_VERSION}; "
            "the CLI never migrates or initializes the database"
        )
    columns = {
        str(column[1])
        for column in connection.execute(
            "PRAGMA table_info(motion_lab_raw_events)"
        ).fetchall()
    }
    required = {
        "id",
        "created_at",
        "event_type",
        "turn_id",
        "message_id",
        "source_route",
        "phase",
        "raw_json",
        "timeline_outcome_json",
    }
    missing = sorted(required - columns)
    if missing:
        connection.close()
        raise DatasetError("motion_lab_schema_columns_missing:" + ",".join(missing))
    return connection


def _load_events(
    connection: sqlite3.Connection,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, str]]]:
    rows = connection.execute(
        """
        SELECT id, created_at, event_type, turn_id, message_id, source_route,
               phase, raw_json, timeline_outcome_json
        FROM motion_lab_raw_events
        WHERE event_type = ?
           OR event_type IN (?, ?, ?, ?)
        ORDER BY created_at, id
        """,
        (SAMPLE_EVENT_TYPE, *PLAYBACK_EVENT_TYPES),
    ).fetchall()
    samples: list[dict[str, Any]] = []
    playback: list[dict[str, Any]] = []
    malformed: list[dict[str, str]] = []
    for row in rows:
        raw_value: Any = None
        raw_error = ""
        try:
            raw_value = json.loads(row["raw_json"])
        except (TypeError, json.JSONDecodeError):
            raw_error = "raw_json_invalid"
        raw = raw_value if isinstance(raw_value, dict) else {}
        event = {
            "id": str(row["id"] or ""),
            "created_at": str(row["created_at"] or ""),
            "event_type": str(row["event_type"] or ""),
            "turn_id": str(row["turn_id"] or ""),
            "message_id": str(row["message_id"] or ""),
            "source_route": str(row["source_route"] or ""),
            "phase": str(row["phase"] or ""),
            "raw": raw,
            "timeline_outcome": _parse_object(row["timeline_outcome_json"]),
        }
        if event["event_type"] == SAMPLE_EVENT_TYPE:
            reason = raw_error
            if not reason and not isinstance(raw_value, dict):
                reason = "raw_json_not_object"
            elif not reason and raw.get("sample_schema") != SAMPLE_SCHEMA:
                reason = "sample_schema_missing_or_unsupported"
            elif not reason and (
                not isinstance(raw.get("sample_id"), str)
                or not raw["sample_id"].strip()
            ):
                reason = "sample_id_missing_or_invalid"
            if reason:
                malformed.append(
                    {
                        "event_id": event["id"],
                        "event_type": event["event_type"],
                        "reason": reason,
                    }
                )
                continue
            samples.append(event)
        else:
            playback.append(event)
    return samples, playback, malformed


def _parse_object(value: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _is_present(value: Any) -> bool:
    return value is not None and value != "" and value != [] and value != {}


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _contains_neurobrain_state(value: Any) -> bool:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key == "neurobrain_state" and _is_present(item):
                return True
            if _contains_neurobrain_state(item):
                return True
    elif isinstance(value, (list, tuple)):
        return any(_contains_neurobrain_state(item) for item in value)
    return False


def _collection_status(
    source_route: str,
    snapshots: list[dict[str, Any]],
) -> tuple[str, str | None]:
    result_snapshots = [
        item for item in snapshots if item["stage"] == "motion_result"
    ]
    if source_route == "independent_motion":
        terminal = [
            item["motion"]
            for item in result_snapshots
            if item["motion"].get("provider_final") is True
        ]
        successful_status = "provider_normalized"
        failed_statuses = {
            "provider_failed",
            "failed",
            "cancelled",
            "canceled",
            "motion_timeout",
        }
    elif source_route == "persona_effect":
        terminal = [item["motion"] for item in result_snapshots]
        successful_status = "accepted"
        failed_statuses = {"failed", "cancelled", "canceled"}
    else:
        terminal = []
        successful_status = ""
        failed_statuses = set()

    if not terminal:
        return "open", "no_terminal_motion_result"
    statuses = {str(item.get("status") or "").strip() for item in terminal}
    if len(statuses) != 1:
        return "incomplete", "sample_collection_terminal_conflict"
    status = next(iter(statuses))
    if status == successful_status:
        return "closed", None
    if status in failed_statuses:
        reasons = {
            str(item.get("reason") or "").strip().lower()
            for item in terminal
            if str(item.get("reason") or "").strip()
        }
        if any("motion_timeout" in reason for reason in reasons):
            return "incomplete", "motion_timeout"
        if status in {"cancelled", "canceled"} or any(
            "cancelled" in reason or "canceled" in reason for reason in reasons
        ):
            return "incomplete", "motion_cancelled"
        return "incomplete", "motion_result_failed"
    return "incomplete", "sample_collection_terminal_status_invalid"


def _merge_snapshots(events: list[dict[str, Any]]) -> dict[str, Any]:
    snapshots: list[dict[str, Any]] = []
    for event in events:
        raw = event["raw"]
        if raw.get("sample_schema") != SAMPLE_SCHEMA:
            continue
        snapshots.append(
            {
                "event": event,
                "raw": raw,
                "stage": str(raw.get("record_stage") or event["phase"] or "unknown"),
                "identity": raw.get("identity") if isinstance(raw.get("identity"), dict) else {},
                "delivery": raw.get("delivery") if isinstance(raw.get("delivery"), dict) else {},
                "input": raw.get("input") if isinstance(raw.get("input"), dict) else {},
                "persona_segment": (
                    raw.get("persona_segment")
                    if isinstance(raw.get("persona_segment"), dict)
                    else {}
                ),
                "motion": raw.get("motion") if isinstance(raw.get("motion"), dict) else {},
            }
        )

    blockers: list[str] = []
    conflicts: list[dict[str, Any]] = []

    def record_conflict(field: str, event_values: list[tuple[str, Any]]) -> None:
        values: dict[str, dict[str, Any]] = {}
        for event_id, value in event_values:
            encoded = _stable_json(value)
            entry = values.setdefault(encoded, {"value": value, "event_ids": []})
            entry["event_ids"].append(event_id)
        if len(values) > 1:
            conflicts.append(
                {
                    "field": field,
                    "values": [
                        {
                            "value": entry["value"],
                            "event_ids": sorted(set(entry["event_ids"])),
                        }
                        for _, entry in sorted(values.items())
                    ],
                }
            )

    identity: dict[str, Any] = {}
    for field in IDENTITY_FIELDS:
        record_conflict(
            f"identity.{field}",
            [
                (snapshot["event"]["id"], snapshot["identity"][field])
                for snapshot in snapshots
                if _is_present(snapshot["identity"].get(field))
            ],
        )
        values = {
            _stable_json(snapshot["identity"].get(field))
            for snapshot in snapshots
            if _is_present(snapshot["identity"].get(field))
        }
        if len(values) > 1:
            blockers.append(f"identity_conflict:{field}")
        if values:
            selected = sorted(values)[0]
            identity[field] = json.loads(selected)
        else:
            identity[field] = None

    route_values = [
        (snapshot["event"]["id"], snapshot["event"]["source_route"])
        for snapshot in snapshots
        if snapshot["event"]["source_route"]
    ]
    record_conflict("source_route", route_values)
    routes = {value for _, value in route_values}
    mode_values = [
        (snapshot["event"]["id"], str(snapshot["delivery"].get("mode") or "").strip())
        for snapshot in snapshots
        if str(snapshot["delivery"].get("mode") or "").strip()
    ]
    record_conflict("delivery_mode", mode_values)
    modes = {value for _, value in mode_values}
    if len(routes) > 1:
        blockers.append("source_route_conflict")
    if len(modes) > 1:
        blockers.append("delivery_mode_conflict")
    source_route = sorted(routes)[0] if routes else ""
    delivery_mode = sorted(modes)[0] if modes else ""

    stage_priority = {
        "motion_request": 100,
        "motion_result": 90,
        "persona_segment_ready": 80,
        "segment_identity": 70,
    }
    ordered = sorted(
        snapshots,
        key=lambda item: (
            -stage_priority.get(item["stage"], 0),
            0
            if (
                isinstance(item["input"].get("motion_request"), dict)
                and item["input"]["motion_request"].get("candidate_role")
                == "primary"
            )
            else 1,
            item["event"]["created_at"],
        ),
    )
    merged_input: dict[str, Any] = {}
    merged_segment: dict[str, Any] = {}
    for snapshot in ordered:
        for key, value in snapshot["input"].items():
            if value is not None and key not in merged_input:
                merged_input[key] = value

    segment_priority = {
        "persona_segment_ready": 100,
        "motion_result": 90,
        "segment_identity": 80,
        "motion_request": 70,
    }
    segment_ordered = sorted(
        snapshots,
        key=lambda item: (
            -segment_priority.get(item["stage"], 0),
            item["event"]["created_at"],
        ),
    )
    for snapshot in segment_ordered:
        for key, value in snapshot["persona_segment"].items():
            if key == "speech":
                if isinstance(value, str) and value.strip():
                    if not isinstance(merged_segment.get(key), str) or not merged_segment[key].strip():
                        merged_segment[key] = value
                elif key not in merged_segment and isinstance(value, str):
                    merged_segment[key] = value
                continue
            if key == "speech_state":
                state_priority = {"ready": 3, "not_yet_ready": 2, "identity_only": 1}
                current = merged_segment.get(key)
                if state_priority.get(str(value), 0) > state_priority.get(str(current), 0):
                    merged_segment[key] = value
                continue
            if key == "actions":
                if isinstance(value, list) and key not in merged_segment:
                    merged_segment[key] = value
                continue
            if key == "tendency":
                if isinstance(value, dict) and value and key not in merged_segment:
                    merged_segment[key] = value
                continue
            if value is not None and key not in merged_segment:
                merged_segment[key] = value

    action_values = [
        (snapshot["event"]["id"], snapshot["persona_segment"].get("actions"))
        for snapshot in snapshots
        if isinstance(snapshot["persona_segment"].get("actions"), list)
    ]
    tendency_values = [
        (snapshot["event"]["id"], snapshot["persona_segment"].get("tendency"))
        for snapshot in snapshots
        if isinstance(snapshot["persona_segment"].get("tendency"), dict)
        and snapshot["persona_segment"].get("tendency")
    ]
    record_conflict("persona_segment.actions", action_values)
    record_conflict("persona_segment.tendency", tendency_values)
    if len({_stable_json(value) for _, value in action_values}) > 1:
        blockers.append("persona_actions_conflict")
    if len({_stable_json(value) for _, value in tendency_values}) > 1:
        blockers.append("persona_tendency_conflict")

    if "speech_state" not in merged_segment and merged_segment.get("speech"):
        merged_segment["speech_state"] = "ready"

    result_snapshots = [
        item for item in snapshots if item["stage"] == "motion_result"
    ]
    terminal_status_values = [
        (item["event"]["id"], item["motion"].get("status"))
        for item in result_snapshots
        if _is_present(item["motion"].get("status"))
    ]
    record_conflict("motion_result.status", terminal_status_values)
    if len({_stable_json(value) for _, value in terminal_status_values}) > 1:
        blockers.append("motion_terminal_status_conflict")
    provider_final_values = [
        (item["event"]["id"], item["motion"].get("provider_final"))
        for item in result_snapshots
        if _is_present(item["motion"].get("provider_final"))
    ]
    record_conflict("motion_result.provider_final", provider_final_values)
    if len({_stable_json(value) for _, value in provider_final_values}) > 1:
        blockers.append("motion_provider_final_conflict")
    reason_values = [
        (item["event"]["id"], item["motion"].get("reason"))
        for item in result_snapshots
        if _is_present(item["motion"].get("reason"))
    ]
    record_conflict("motion_result.reason", reason_values)
    if len({_stable_json(value) for _, value in reason_values}) > 1:
        blockers.append("motion_result_reason_conflict")
    final_payloads = [
        item["motion"].get("accepted_payload")
        for item in result_snapshots
        if isinstance(item["motion"].get("accepted_payload"), dict)
    ]
    distinct_payloads = {_stable_json(payload) for payload in final_payloads}
    record_conflict(
        "motion_result.accepted_payload",
        [
            (item["event"]["id"], item["motion"].get("accepted_payload"))
            for item in result_snapshots
            if isinstance(item["motion"].get("accepted_payload"), dict)
        ],
    )
    if len(distinct_payloads) > 1:
        blockers.append("final_motion_payload_conflict")
    final_payload = json.loads(sorted(distinct_payloads)[-1]) if distinct_payloads else None
    final_motion_candidates = result_snapshots
    if source_route == "independent_motion":
        provider_terminals = [
            item
            for item in result_snapshots
            if item["motion"].get("provider_final") is True
        ]
        if provider_terminals:
            final_motion_candidates = provider_terminals
    final_motion = (
        min(final_motion_candidates, key=lambda item: _stable_json(item["motion"]))[
            "motion"
        ]
        if final_motion_candidates
        else {}
    )
    collection_status, collection_reason = _collection_status(source_route, snapshots)
    candidates = []
    for snapshot in snapshots:
        if snapshot["stage"] != "motion_candidate":
            continue
        candidates.append(
            {
                "provider_update_index": snapshot["motion"].get("provider_update_index"),
                "provider_id": snapshot["motion"].get("provider_id"),
                "candidate_role": snapshot["motion"].get("candidate_role"),
                "status": snapshot["motion"].get("status"),
                "accepted_payload": snapshot["motion"].get("accepted_payload"),
                "raw_output": snapshot["motion"].get("raw_output"),
                "generation_elapsed_ms": snapshot["motion"].get("generation_elapsed_ms"),
                "provider_elapsed_ms": snapshot["motion"].get("provider_elapsed_ms"),
                "provider_started_at_epoch_ms": snapshot["motion"].get(
                    "provider_started_at_epoch_ms"
                ),
                "reason": snapshot["motion"].get("reason"),
                "provider_final": snapshot["motion"].get("provider_final"),
            }
        )
    candidates.sort(
        key=lambda item: (
            item["provider_update_index"]
            if isinstance(item["provider_update_index"], int)
            else -1
        )
    )

    return {
        "snapshots": snapshots,
        "identity": identity,
        "source_route": source_route,
        "delivery_mode": delivery_mode,
        "collection_status": collection_status,
        "collection_reason": collection_reason,
        "input": merged_input,
        "persona_segment": merged_segment,
        "final_payload": final_payload,
        "final_motion": final_motion,
        "provider_candidates": candidates,
        "blockers": blockers,
        "conflicts": conflicts,
    }


def _playback_evidence(
    sample: dict[str, Any], playback_events: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    turn_id = str(sample["identity"].get("turn_id") or "")
    message_id = str(sample["identity"].get("segment_message_id") or "")
    if not message_id:
        return []
    evidence = []
    for event in playback_events:
        if event["message_id"] != message_id:
            continue
        if turn_id and event["turn_id"] and event["turn_id"] != turn_id:
            continue
        raw = event["raw"]
        payload = raw.get("frontend_payload") if isinstance(raw.get("frontend_payload"), dict) else raw
        detail = payload.get("raw") if isinstance(payload.get("raw"), dict) else {}
        origin = detail.get("playbackOrigin")
        if origin == "manual_preview":
            continue
        evidence.append(
            {
                "event_id": event["id"],
                "event_type": event["event_type"],
                "created_at": event["created_at"],
                "status": detail.get("status") or event["event_type"].rsplit("_", 1)[-1],
                "playback_origin": origin,
                "payload_kind": payload.get("payload_kind"),
                "run_id": detail.get("runId"),
                "intent": detail.get("intent"),
                "plan": detail.get("plan"),
                "motion": detail.get("motion"),
                "timeline_outcome": event["timeline_outcome"],
            }
        )
    return evidence


def _make_review_sample(
    sample_id: str,
    events: list[dict[str, Any]],
    playback_events: list[dict[str, Any]],
) -> dict[str, Any]:
    reduced = _merge_snapshots(events)
    blockers = list(reduced["blockers"])
    identity = reduced["identity"]
    persona_segment = reduced["persona_segment"]
    input_context = reduced["input"]
    final_motion = reduced["final_motion"]
    collection_status = reduced["collection_status"]
    collection_reason = reduced["collection_reason"]
    neurobrain_present = any(
        _contains_neurobrain_state(snapshot["input"])
        for snapshot in reduced["snapshots"]
    )
    if not identity.get("turn_id") or not identity.get("persona_result_id"):
        blockers.append("sample_identity_incomplete")
    if type(identity.get("segment_index")) is not int:
        blockers.append("segment_index_missing")
    if not identity.get("segment_message_id"):
        blockers.append("segment_message_id_missing")
    user_text = input_context.get("user_text")
    if not isinstance(user_text, str) or not user_text.strip():
        blockers.append("user_text_missing")
    if not isinstance(persona_segment.get("speech"), str) or not persona_segment["speech"].strip():
        blockers.append("persona_speech_missing")
    actions = persona_segment.get("actions")
    if not isinstance(actions, list) or any(
        not isinstance(action, str) or not action.strip() for action in actions
    ):
        blockers.append("persona_actions_missing")
    if persona_segment.get("speech_state") != "ready":
        blockers.append("persona_speech_not_ready")
    tendency = persona_segment.get("tendency")
    if not isinstance(tendency, dict) or any(
        key not in tendency
        or type(tendency.get(key)) is not int
        or not 0 <= tendency[key] <= 10
        for key in TENDENCY_KEYS
    ):
        blockers.append("persona_tendency_incomplete")
    if reduced["final_payload"] is None:
        blockers.append("final_motion_payload_missing")
    if final_motion.get("status") in {"failed", "provider_failed", "cancelled", "canceled"}:
        blockers.append("final_motion_failed")
    expected_status = {
        "persona_effect": "accepted",
        "independent_motion": "provider_normalized",
    }.get(reduced["source_route"])
    if expected_status and final_motion.get("status") != expected_status:
        blockers.append("final_motion_status_invalid")
    if (
        reduced["source_route"] == "independent_motion"
        and final_motion.get("provider_final") is not True
    ):
        blockers.append("provider_result_not_final")
    if reduced["source_route"] not in SOURCE_ROUTES:
        blockers.append("source_route_unknown")
    if reduced["delivery_mode"] not in DELIVERY_MODES:
        blockers.append("delivery_mode_unknown")
    if neurobrain_present:
        blockers.append("neurobrain_state_present")

    playback = _playback_evidence(reduced, playback_events)
    terminal_playback = [
        item
        for item in playback
        if item["event_type"] in {"motion.playback_completed", "motion.playback_failed"}
    ]
    terminal_playback_types = {item["event_type"] for item in terminal_playback}
    if len(terminal_playback_types) > 1:
        playback_status = "conflict"
        blockers.append("playback_terminal_conflict")
        reduced["conflicts"].append(
            {
                "field": "delivery_evidence.playback_status",
                "values": [
                    {
                        "value": event_type,
                        "event_ids": sorted(
                            item["event_id"]
                            for item in terminal_playback
                            if item["event_type"] == event_type
                        ),
                    }
                    for event_type in sorted(terminal_playback_types)
                ],
            }
        )
    elif terminal_playback:
        playback_status = (
            "completed"
            if terminal_playback[-1]["event_type"] == "motion.playback_completed"
            else "failed"
        )
    elif any(item["event_type"] == "motion.playback_started" for item in playback):
        playback_status = "started"
    else:
        playback_status = "unobserved"

    sample = {
        "record_type": "sample",
        "review_schema": REVIEW_SCHEMA,
        "sample_id": sample_id,
        "collection_status": collection_status,
        "collection_reason": collection_reason,
        "identity": identity,
        "source_route": reduced["source_route"],
        "delivery_mode": reduced["delivery_mode"],
        "input": input_context,
        "persona_segment": persona_segment,
        "motion": {
            "target_origin": (
                "persona_effect_result"
                if reduced["source_route"] == "persona_effect"
                else "independent_provider_final"
            ),
            "target_payload": reduced["final_payload"],
            "final_status": final_motion.get("status"),
            "provider_final": final_motion.get("provider_final"),
            "reason": final_motion.get("reason"),
            "provider_candidates": reduced["provider_candidates"],
        },
        "delivery_evidence": {
            "playback_status": playback_status,
            "playback_events": playback,
            "human_feedback": "not_recorded",
        },
        "snapshot_trace": [
            {
                "event_id": item["event"]["id"],
                "record_stage": item["stage"],
                "created_at": item["event"]["created_at"],
            }
            for item in reduced["snapshots"]
        ],
        "quality": {
            "status": "reviewable" if not blockers else "blocked",
            "blockers": sorted(set(blockers)),
            "conflicts": reduced["conflicts"],
            "neurobrain_state_present": neurobrain_present,
        },
        "review": {"status": "pending", "reviewer": "", "notes": ""},
    }
    sample["review_digest"] = _review_digest(sample)
    return sample


def _review_digest(sample: dict[str, Any]) -> str:
    immutable = {key: value for key, value in sample.items() if key not in {"review", "review_digest"}}
    return hashlib.sha256(_stable_json(immutable).encode("utf-8")).hexdigest()


def _reduce_database(
    db_path: Path,
) -> tuple[list[dict[str, Any]], dict[str, int], list[dict[str, str]]]:
    connection = _readonly_connection(db_path)
    try:
        snapshot_events, playback_events, malformed = _load_events(connection)
        counts = Counter(
            event["event_type"] for event in snapshot_events + playback_events
        )
        counts.update(item["event_type"] for item in malformed)
    finally:
        connection.close()
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in snapshot_events:
        sample_id = str(event["raw"].get("sample_id") or "").strip()
        grouped[sample_id].append(event)
    samples = [
        _make_review_sample(sample_id, events, playback_events)
        for sample_id, events in sorted(grouped.items())
    ]
    counts["unique_samples"] = len(samples)
    counts["malformed_sample_events"] = len(malformed)
    return samples, dict(counts), malformed


def _write_jsonl(path: Path, records: list[dict[str, Any]], *, overwrite: bool) -> None:
    output = path.expanduser()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and not overwrite:
        raise DatasetError(f"output_exists_use_overwrite: {output}")
    serialized = "".join(_stable_json(record) + "\n" for record in records)
    try:
        with output.open("w", encoding="utf-8", newline="\n") as stream:
            stream.write(serialized)
    except OSError as exc:
        raise DatasetError(f"cannot_write_output: {exc}") from exc


def _require_distinct_paths(output_path: Path, protected_paths: tuple[Path, ...]) -> None:
    output = output_path.expanduser().resolve()
    if any(output == protected.expanduser().resolve() for protected in protected_paths):
        raise DatasetError(f"output_must_not_replace_input: {output}")


def _filter_samples(
    samples: list[dict[str, Any]], source_route: str, delivery_mode: str
) -> list[dict[str, Any]]:
    return [
        sample
        for sample in samples
        if sample["source_route"] == source_route
        and sample["delivery_mode"] == delivery_mode
    ]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only reducer and review/export CLI for Persona motion samples."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    summary = subparsers.add_parser("summary", help="summarize the v3 Motion Lab database")
    summary.add_argument("--db", required=True, type=Path)

    manifest = subparsers.add_parser("manifest", help="write a pending-review JSONL manifest")
    manifest.add_argument("--db", required=True, type=Path)
    manifest.add_argument("--source-route", required=True, choices=SOURCE_ROUTES)
    manifest.add_argument("--delivery-mode", required=True, choices=DELIVERY_MODES)
    manifest.add_argument("--output", required=True, type=Path)
    manifest.add_argument("--overwrite", action="store_true")

    export = subparsers.add_parser("export", help="export only manually approved samples")
    export.add_argument("--manifest", required=True, type=Path)
    export.add_argument("--source-route", required=True, choices=SOURCE_ROUTES)
    export.add_argument("--delivery-mode", required=True, choices=DELIVERY_MODES)
    export.add_argument("--output", required=True, type=Path)
    export.add_argument("--overwrite", action="store_true")
    return parser


def _command_summary(db_path: Path) -> int:
    samples, event_counts, malformed = _reduce_database(db_path)
    routes = Counter(sample["source_route"] for sample in samples)
    modes = Counter(sample["delivery_mode"] for sample in samples)
    collection = Counter(sample["collection_status"] for sample in samples)
    quality = Counter(sample["quality"]["status"] for sample in samples)
    neurobrain = sum(
        sample["quality"]["neurobrain_state_present"] for sample in samples
    )
    print(
        json.dumps(
            {
                "database": str(db_path.resolve()),
                "schema_version": RAW_EVENT_SCHEMA_VERSION,
                "event_counts": event_counts,
                "samples_by_source_route": dict(routes),
                "samples_by_delivery_mode": dict(modes),
                "collection_status": dict(collection),
                "quality_status": dict(quality),
                "excluded_neurobrain_samples": neurobrain,
                "malformed_sample_events": malformed,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def _command_manifest(args: argparse.Namespace) -> int:
    _require_distinct_paths(args.output, (args.db,))
    samples, event_counts, malformed = _reduce_database(args.db)
    matched = _filter_samples(samples, args.source_route, args.delivery_mode)
    collection = Counter(sample["collection_status"] for sample in matched)
    neurobrain_count = sum(
        sample["quality"]["neurobrain_state_present"] for sample in matched
    )
    selected = [
        sample for sample in matched if not sample["quality"]["neurobrain_state_present"]
    ]
    header = {
        "record_type": "manifest",
        "review_schema": REVIEW_SCHEMA,
        "database_schema_version": RAW_EVENT_SCHEMA_VERSION,
        "filters": {
            "source_route": args.source_route,
            "delivery_mode": args.delivery_mode,
        },
        "event_counts": event_counts,
        "sample_count": len(selected),
        "excluded_neurobrain_samples": neurobrain_count,
        "collection_status_counts": dict(collection),
        "malformed_sample_events": malformed,
        "instruction": "Edit each sample review.status/reviewer/notes; leave all other fields unchanged.",
    }
    _write_jsonl(args.output, [header, *selected], overwrite=args.overwrite)
    print(
        json.dumps(
            {
                "manifest": str(args.output.resolve()),
                "samples": len(selected),
                "reviewable": sum(sample["quality"]["status"] == "reviewable" for sample in selected),
                "blocked": sum(sample["quality"]["status"] == "blocked" for sample in selected),
                "collection_status": dict(collection),
                "excluded_neurobrain": neurobrain_count,
                "malformed_sample_events": len(malformed),
            },
            ensure_ascii=False,
        )
    )
    return 0


def _load_manifest(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        lines = path.expanduser().read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise DatasetError(f"cannot_read_manifest: {exc}") from exc
    records = []
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise DatasetError(f"invalid_manifest_json_line:{line_number}:{exc}") from exc
        if not isinstance(value, dict):
            raise DatasetError(f"manifest_line_not_object:{line_number}")
        records.append(value)
    if not records or records[0].get("record_type") != "manifest":
        raise DatasetError("manifest_header_missing")
    header = records[0]
    if header.get("review_schema") != REVIEW_SCHEMA:
        raise DatasetError("unsupported_review_manifest_schema")
    if str(header.get("database_schema_version")) != RAW_EVENT_SCHEMA_VERSION:
        raise DatasetError("unsupported_manifest_database_schema_version")
    filters = header.get("filters")
    if not isinstance(filters, dict) or filters.get("source_route") not in SOURCE_ROUTES or filters.get(
        "delivery_mode"
    ) not in DELIVERY_MODES:
        raise DatasetError("invalid_manifest_filters")
    if any(record.get("record_type") != "sample" for record in records[1:]):
        raise DatasetError("unsupported_manifest_record_type")
    if header.get("sample_count") != len(records) - 1:
        raise DatasetError("manifest_sample_count_mismatch")

    event_counts = header.get("event_counts")
    if not isinstance(event_counts, dict) or any(
        not isinstance(key, str) or type(value) is not int or value < 0
        for key, value in event_counts.items()
    ):
        raise DatasetError("invalid_manifest_event_counts")
    malformed = header.get("malformed_sample_events")
    malformed_count = event_counts.get("malformed_sample_events")
    if not isinstance(malformed, list) or malformed_count != len(malformed):
        raise DatasetError("invalid_manifest_malformed_event_diagnostics")
    for event in malformed:
        if (
            not isinstance(event, dict)
            or not isinstance(event.get("event_id"), str)
            or event.get("event_type") != SAMPLE_EVENT_TYPE
            or not isinstance(event.get("reason"), str)
            or not event["reason"].strip()
        ):
            raise DatasetError("invalid_manifest_malformed_event_diagnostic")

    collection_counts = header.get("collection_status_counts")
    if not isinstance(collection_counts, dict) or any(
        key not in COLLECTION_STATUSES or type(value) is not int or value < 0
        for key, value in collection_counts.items()
    ):
        raise DatasetError("invalid_manifest_collection_status_counts")
    excluded_neurobrain = header.get("excluded_neurobrain_samples")
    if (
        type(excluded_neurobrain) is not int
        or excluded_neurobrain < 0
        or sum(collection_counts.values())
        != header["sample_count"] + excluded_neurobrain
    ):
        raise DatasetError("manifest_collection_status_count_mismatch")

    seen_sample_ids: set[str] = set()
    for sample in records[1:]:
        sample_id = sample.get("sample_id")
        if not isinstance(sample_id, str) or not sample_id or sample_id in seen_sample_ids:
            raise DatasetError("manifest_sample_id_missing_or_duplicated")
        seen_sample_ids.add(sample_id)
        if sample.get("review_schema") != REVIEW_SCHEMA:
            raise DatasetError(f"unsupported_review_sample_schema:{sample_id}")
        if (
            sample.get("source_route") != filters["source_route"]
            or sample.get("delivery_mode") != filters["delivery_mode"]
        ):
            raise DatasetError(f"manifest_sample_filter_mismatch:{sample_id}")
        collection_status = sample.get("collection_status")
        if not isinstance(collection_status, str) or collection_status not in COLLECTION_STATUSES:
            raise DatasetError(f"invalid_sample_collection_status:{sample_id}")
        collection_reason = sample.get("collection_reason")
        if collection_reason is not None and (
            not isinstance(collection_reason, str) or not collection_reason
        ):
            raise DatasetError(f"invalid_sample_collection_reason:{sample_id}")
        required_objects = (
            "identity",
            "input",
            "persona_segment",
            "motion",
            "delivery_evidence",
        )
        if any(not isinstance(sample.get(key), dict) for key in required_objects):
            raise DatasetError(f"invalid_sample_payload_shape:{sample_id}")
        motion = sample["motion"]
        if (
            not isinstance(motion.get("target_origin"), str)
            or not isinstance(motion.get("provider_candidates"), list)
            or motion.get("target_payload") is not None
            and not isinstance(motion.get("target_payload"), dict)
        ):
            raise DatasetError(f"invalid_sample_motion:{sample_id}")
        delivery = sample["delivery_evidence"]
        if (
            not isinstance(delivery.get("playback_status"), str)
            or not isinstance(delivery.get("human_feedback"), str)
            or not isinstance(sample.get("snapshot_trace"), list)
        ):
            raise DatasetError(f"invalid_sample_delivery_evidence:{sample_id}")
        quality = sample.get("quality")
        if not isinstance(quality, dict):
            raise DatasetError(f"invalid_sample_quality:{sample_id}")
        blockers = quality.get("blockers")
        conflicts = quality.get("conflicts")
        quality_status = quality.get("status")
        if (
            not isinstance(quality_status, str)
            or quality_status not in QUALITY_STATUSES
            or not isinstance(blockers, list)
            or any(not isinstance(item, str) for item in blockers)
            or not isinstance(conflicts, list)
            or any(not isinstance(item, dict) for item in conflicts)
            or quality_status != ("blocked" if blockers else "reviewable")
            or type(quality.get("neurobrain_state_present")) is not bool
        ):
            raise DatasetError(f"invalid_sample_quality_status:{sample_id}")
        review = sample.get("review")
        review_status = review.get("status") if isinstance(review, dict) else None
        if (
            not isinstance(review, dict)
            or not isinstance(review_status, str)
            or review_status not in REVIEW_STATUSES
            or not isinstance(review.get("reviewer"), str)
            or not isinstance(review.get("notes"), str)
        ):
            raise DatasetError(f"invalid_sample_review:{sample_id}")
        if sample.get("review_digest") != _review_digest(sample):
            raise DatasetError(f"review_sample_changed_outside_review_fields:{sample_id}")
    return header, records[1:]


def _training_record(sample: dict[str, Any]) -> dict[str, Any]:
    return {
        "training_schema": TRAINING_SCHEMA,
        "sample_id": sample["sample_id"],
        "identity": sample["identity"],
        "source_route": sample["source_route"],
        "delivery_mode": sample["delivery_mode"],
        "input": sample["input"],
        "persona_segment": sample["persona_segment"],
        "target": {
            "motion_payload": sample["motion"]["target_payload"],
            "origin": sample["motion"]["target_origin"],
        },
        "evidence": {
            "final_status": sample["motion"]["final_status"],
            "provider_final": sample["motion"]["provider_final"],
            "playback_status": sample["delivery_evidence"]["playback_status"],
            "human_feedback": sample["delivery_evidence"]["human_feedback"],
        },
        "review": {
            "reviewer": sample["review"]["reviewer"].strip(),
            "notes": sample["review"]["notes"].strip(),
        },
    }


def _command_export(args: argparse.Namespace) -> int:
    _require_distinct_paths(args.output, (args.manifest,))
    header, samples = _load_manifest(args.manifest)
    expected_filters = {
        "source_route": args.source_route,
        "delivery_mode": args.delivery_mode,
    }
    if header.get("filters") != expected_filters:
        raise DatasetError("manifest_filter_does_not_match_explicit_export_selection")
    exported = []
    seen_sample_ids: set[str] = set()
    skipped_pending = 0
    skipped_blocked = 0
    for sample in samples:
        sample_id = str(sample.get("sample_id") or "")
        if not sample_id or sample_id in seen_sample_ids:
            raise DatasetError(f"manifest_sample_id_missing_or_duplicated:{sample_id or '<empty>'}")
        seen_sample_ids.add(sample_id)
        review = sample.get("review")
        if not isinstance(review, dict) or review.get("status") != "approved":
            skipped_pending += 1
            continue
        if sample.get("collection_status") != "closed":
            raise DatasetError(
                f"approved_sample_collection_not_closed:{sample_id}:"
                f"{sample.get('collection_status')}"
            )
        if sample.get("quality", {}).get("blockers"):
            skipped_blocked += 1
            continue
        reviewer = review.get("reviewer")
        if not isinstance(reviewer, str) or not reviewer.strip():
            raise DatasetError(f"approved_sample_missing_reviewer:{sample_id}")
        notes = review.get("notes", "")
        if not isinstance(notes, str):
            raise DatasetError(f"approved_sample_notes_must_be_text:{sample_id}")
        if sample.get("source_route") != args.source_route or sample.get("delivery_mode") != args.delivery_mode:
            raise DatasetError(f"sample_filter_mismatch:{sample_id}")
        if sample.get("quality", {}).get("neurobrain_state_present"):
            raise DatasetError(f"neurobrain_sample_cannot_be_exported:{sample_id}")
        payload = sample.get("motion", {}).get("target_payload")
        if not isinstance(payload, dict):
            raise DatasetError(f"approved_sample_missing_motion_target:{sample_id}")
        exported.append(_training_record(sample))
    _write_jsonl(args.output, exported, overwrite=args.overwrite)
    print(
        json.dumps(
            {
                "output": str(args.output.resolve()),
                "exported": len(exported),
                "skipped_pending_or_rejected": skipped_pending,
                "skipped_quality_blocked": skipped_blocked,
                "source_route": args.source_route,
                "delivery_mode": args.delivery_mode,
            },
            ensure_ascii=False,
        )
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "summary":
            return _command_summary(args.db)
        if args.command == "manifest":
            return _command_manifest(args)
        if args.command == "export":
            return _command_export(args)
    except DatasetError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
