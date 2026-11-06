from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, TYPE_CHECKING

from . import __version__
from .discovery import DiscoveryResult
from .metrics import ProbeSample

if TYPE_CHECKING:
    from .sampler import SamplingEvent


SCHEMA_VERSION = 1


class RecorderStoreError(RuntimeError):
    """Raised when the independent recording database cannot preserve capture facts."""


def default_database_path() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    root = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return root / "AG99live" / "vts-data-recorder" / "recordings.sqlite3"


class RecorderStore:
    """SQLite storage owned exclusively by the VTube Studio recorder."""

    def __init__(self, database_path: Path) -> None:
        self.path = database_path.expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(self.path)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._connection.execute("PRAGMA journal_mode = WAL")
        self._connection.execute("PRAGMA busy_timeout = 5000")
        self._connection.execute("PRAGMA synchronous = NORMAL")
        self._initialize_schema()

    def __enter__(self) -> "RecorderStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self._connection.close()

    def create_session(
        self,
        *,
        endpoint: str,
        requested_hz: float,
        vts_version: str | None,
        model_id: str | None,
        model_name: str | None,
        target_contract: Mapping[str, Any],
    ) -> int:
        with self._connection:
            cursor = self._connection.execute(
                """
                INSERT INTO recording_sessions (
                    started_at_utc,
                    recorder_version,
                    vts_endpoint,
                    requested_hz,
                    vts_version,
                    initial_model_id,
                    initial_model_name,
                    target_contract_json,
                    status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recording')
                """,
                (
                    _utc_now(),
                    __version__,
                    endpoint,
                    requested_hz,
                    vts_version,
                    model_id,
                    model_name,
                    _json(target_contract),
                ),
            )
        return _last_row_id(cursor)

    def finish_session(self, session_id: int, *, status: str) -> None:
        with self._connection:
            cursor = self._connection.execute(
                """
                UPDATE recording_sessions
                SET ended_at_utc = ?, status = ?
                WHERE id = ?
                """,
                (_utc_now(), status, session_id),
            )
        _require_row(cursor, "recording session", session_id)

    def save_parameter_catalog(self, session_id: int, discovery: DiscoveryResult) -> None:
        rows: list[tuple[object, ...]] = []
        for source, parameters in (
            ("tracking_default", discovery.default_tracking_parameters),
            ("tracking_custom", discovery.custom_tracking_parameters),
            ("live2d_parameter", discovery.live2d_parameters),
        ):
            for parameter in parameters:
                name = _required_parameter_name(parameter, source)
                rows.append(
                    (
                        session_id,
                        _utc_now(),
                        source,
                        name,
                        _number(parameter.get("min")),
                        _number(parameter.get("max")),
                        _number(parameter.get("defaultValue")),
                        _json(parameter),
                    )
                )
        with self._connection:
            self._connection.executemany(
                """
                INSERT INTO parameter_catalog_snapshots (
                    session_id,
                    captured_at_utc,
                    source,
                    parameter_name,
                    min_value,
                    max_value,
                    default_value,
                    definition_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )

    def create_take(
        self,
        session_id: int,
        *,
        start_monotonic_ns: int,
        operator_label: str | None,
    ) -> int:
        label = operator_label.strip() if operator_label else None
        with self._connection:
            cursor = self._connection.execute(
                """
                INSERT INTO recording_takes (
                    session_id,
                    started_at_utc,
                    start_monotonic_ns,
                    operator_label,
                    status
                ) VALUES (?, ?, ?, ?, 'recording')
                """,
                (session_id, _utc_now(), start_monotonic_ns, label or None),
            )
        return _last_row_id(cursor)

    def append_capture_batch(
        self,
        take_id: int,
        *,
        take_start_monotonic_ns: int,
        samples: Iterable[ProbeSample],
        events: Iterable[SamplingEvent],
    ) -> None:
        sample_rows = list(samples)
        event_rows = list(events)
        if not sample_rows and not event_rows:
            return

        with self._connection:
            sequence_numbers = self._next_sequence_numbers(take_id, sample_rows)
            frame_values: list[tuple[object, ...]] = []
            for sample in sample_rows:
                sequence_number = sequence_numbers[sample.source]
                sequence_numbers[sample.source] += 1
                frame_values.append(
                    (
                        take_id,
                        sample.source,
                        sequence_number,
                        _relative_ns(sample.scheduled_monotonic_ns, take_start_monotonic_ns),
                        _relative_ns(sample.sent_monotonic_ns, take_start_monotonic_ns),
                        _relative_ns(sample.received_monotonic_ns, take_start_monotonic_ns),
                        sample.vts_timestamp_ms,
                        sample.model_id,
                        _json(sample.values),
                    )
                )
            if frame_values:
                self._connection.executemany(
                    """
                    INSERT INTO parameter_frames (
                        take_id,
                        source,
                        sequence_no,
                        scheduled_offset_ns,
                        sent_offset_ns,
                        received_offset_ns,
                        vts_timestamp_ms,
                        model_id,
                        values_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    frame_values,
                )
            if event_rows:
                self._connection.executemany(
                    """
                    INSERT INTO recording_events (
                        take_id,
                        relative_monotonic_ns,
                        event_kind,
                        event_type,
                        vts_timestamp_ms,
                        data_json
                    ) VALUES (?, ?, 'vts_event', ?, ?, ?)
                    """,
                    [
                        (
                            take_id,
                            event.relative_monotonic_ns,
                            event.message_type,
                            event.vts_timestamp_ms,
                            _json(event.raw),
                        )
                        for event in event_rows
                    ],
                )

    def append_recorder_messages(
        self,
        take_id: int,
        *,
        relative_monotonic_ns: int,
        event_type: str,
        messages: Iterable[str],
    ) -> None:
        rows = [
            (
                take_id,
                max(relative_monotonic_ns, 0),
                "recorder",
                event_type,
                _json({"message": message}),
            )
            for message in messages
        ]
        if not rows:
            return
        with self._connection:
            self._connection.executemany(
                """
                INSERT INTO recording_events (
                    take_id,
                    relative_monotonic_ns,
                    event_kind,
                    event_type,
                    data_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                rows,
            )

    def finish_take(
        self,
        take_id: int,
        *,
        status: str,
        termination_reason: str,
        environment_stable: bool,
        duration_ms: int,
        sampling_report: Mapping[str, Any],
    ) -> None:
        with self._connection:
            cursor = self._connection.execute(
                """
                UPDATE recording_takes
                SET ended_at_utc = ?,
                    status = ?,
                    termination_reason = ?,
                    environment_stable = ?,
                    duration_ms = ?,
                    sampling_report_json = ?
                WHERE id = ?
                """,
                (
                    _utc_now(),
                    status,
                    termination_reason,
                    int(environment_stable),
                    max(duration_ms, 0),
                    _json(sampling_report),
                    take_id,
                ),
            )
        _require_row(cursor, "recording take", take_id)

    def fail_take(self, take_id: int, *, message: str) -> None:
        self.append_recorder_messages(
            take_id,
            relative_monotonic_ns=0,
            event_type="capture_failed",
            messages=[message],
        )
        with self._connection:
            cursor = self._connection.execute(
                """
                UPDATE recording_takes
                SET ended_at_utc = ?, status = 'failed', failure_message = ?
                WHERE id = ?
                """,
                (_utc_now(), message, take_id),
            )
        _require_row(cursor, "recording take", take_id)

    def list_takes(self) -> list[dict[str, Any]]:
        rows = self._connection.execute(
            """
            SELECT
                takes.id,
                takes.session_id,
                takes.started_at_utc,
                takes.status,
                takes.termination_reason,
                takes.environment_stable,
                takes.duration_ms,
                takes.operator_label,
                (
                    SELECT COUNT(*) FROM parameter_frames
                    WHERE take_id = takes.id AND source = 'tracking_input'
                ) AS tracking_frame_count,
                (
                    SELECT COUNT(*) FROM parameter_frames
                    WHERE take_id = takes.id AND source = 'live2d_parameter'
                ) AS live2d_frame_count,
                (
                    SELECT COUNT(*) FROM recording_events
                    WHERE take_id = takes.id
                ) AS event_count
            FROM recording_takes AS takes
            ORDER BY takes.id DESC
            """
        ).fetchall()
        return [
            {
                "take_id": int(row["id"]),
                "session_id": int(row["session_id"]),
                "started_at_utc": row["started_at_utc"],
                "status": row["status"],
                "termination_reason": row["termination_reason"],
                "environment_stable": _optional_bool(row["environment_stable"]),
                "duration_ms": row["duration_ms"],
                "operator_label": row["operator_label"],
                "tracking_frame_count": int(row["tracking_frame_count"] or 0),
                "live2d_frame_count": int(row["live2d_frame_count"] or 0),
                "event_count": int(row["event_count"] or 0),
            }
            for row in rows
        ]

    def inspect_take(self, take_id: int) -> dict[str, Any] | None:
        row = self._connection.execute(
            """
            SELECT
                takes.*,
                sessions.vts_endpoint,
                sessions.requested_hz,
                sessions.vts_version,
                sessions.initial_model_id,
                sessions.initial_model_name,
                sessions.target_contract_json
            FROM recording_takes AS takes
            JOIN recording_sessions AS sessions ON sessions.id = takes.session_id
            WHERE takes.id = ?
            """,
            (take_id,),
        ).fetchone()
        if row is None:
            return None

        frame_counts = self._connection.execute(
            """
            SELECT source, COUNT(*) AS frame_count
            FROM parameter_frames
            WHERE take_id = ?
            GROUP BY source
            ORDER BY source
            """,
            (take_id,),
        ).fetchall()
        event_rows = self._connection.execute(
            """
            SELECT relative_monotonic_ns, event_kind, event_type, vts_timestamp_ms, data_json
            FROM recording_events
            WHERE take_id = ?
            ORDER BY id
            """,
            (take_id,),
        ).fetchall()
        return {
            "take_id": int(row["id"]),
            "session_id": int(row["session_id"]),
            "status": row["status"],
            "termination_reason": row["termination_reason"],
            "environment_stable": _optional_bool(row["environment_stable"]),
            "duration_ms": row["duration_ms"],
            "operator_label": row["operator_label"],
            "failure_message": row["failure_message"],
            "started_at_utc": row["started_at_utc"],
            "ended_at_utc": row["ended_at_utc"],
            "session": {
                "endpoint": row["vts_endpoint"],
                "requested_hz": row["requested_hz"],
                "vts_version": row["vts_version"],
                "model_id": row["initial_model_id"],
                "model_name": row["initial_model_name"],
                "target_contract": _decode_json(row["target_contract_json"]),
            },
            "frame_counts": {row["source"]: int(row["frame_count"]) for row in frame_counts},
            "events": [
                {
                    "relative_monotonic_ns": int(event["relative_monotonic_ns"]),
                    "kind": event["event_kind"],
                    "type": event["event_type"],
                    "vts_timestamp_ms": event["vts_timestamp_ms"],
                    "data": _decode_json(event["data_json"]),
                }
                for event in event_rows
            ],
            "sampling_report": _decode_json(row["sampling_report_json"]),
            "annotation": self.get_annotation(take_id),
        }

    def get_annotation(self, take_id: int) -> dict[str, Any] | None:
        row = self._connection.execute(
            """
            SELECT review_status, context_json, target_json, derivation_version,
                   reviewed_at_utc, reviewer_note
            FROM take_annotations WHERE take_id = ?
            """,
            (take_id,),
        ).fetchone()
        if row is None:
            return None
        return {
            "review_status": row["review_status"],
            "context": _decode_json(row["context_json"]),
            "target": _decode_json(row["target_json"]),
            "derivation_version": row["derivation_version"],
            "reviewed_at_utc": row["reviewed_at_utc"],
            "reviewer_note": row["reviewer_note"],
        }

    def save_annotation(
        self,
        take_id: int,
        *,
        review_status: str,
        context: Mapping[str, Any] | None,
        target: Mapping[str, Any] | None,
        reviewer_note: str | None,
        derivation_version: str = "manual.v1",
    ) -> None:
        allowed = {"draft", "accepted", "rejected", "needs_review"}
        if review_status not in allowed:
            raise ValueError(f"review_status must be one of: {', '.join(sorted(allowed))}")
        with self._connection:
            cursor = self._connection.execute(
                """
                INSERT INTO take_annotations (
                    take_id, review_status, context_json, target_json,
                    derivation_version, reviewed_at_utc, reviewer_note
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(take_id) DO UPDATE SET
                    review_status = excluded.review_status,
                    context_json = excluded.context_json,
                    target_json = excluded.target_json,
                    derivation_version = excluded.derivation_version,
                    reviewed_at_utc = excluded.reviewed_at_utc,
                    reviewer_note = excluded.reviewer_note
                """,
                (
                    take_id,
                    review_status,
                    _json(context) if context is not None else None,
                    _json(target) if target is not None else None,
                    derivation_version,
                    _utc_now(),
                    reviewer_note.strip() if reviewer_note else None,
                ),
            )
        _require_row(cursor, "recording take", take_id)

    def save_audio_source(
        self,
        take_id: int,
        *,
        path: str,
        sample_rate: int,
        channels: int,
        encoding: str = "pcm_s16le",
    ) -> None:
        with self._connection:
            cursor = self._connection.execute(
                """
                INSERT INTO recording_audio_sources (
                    take_id, path, sample_rate, channels, encoding
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(take_id) DO UPDATE SET
                    path = excluded.path,
                    sample_rate = excluded.sample_rate,
                    channels = excluded.channels,
                    encoding = excluded.encoding
                """,
                (take_id, path, sample_rate, channels, encoding),
            )
        _require_row(cursor, "recording take", take_id)

    def update_audio_start_offset(self, take_id: int, *, start_offset_ns: int) -> None:
        with self._connection:
            cursor = self._connection.execute(
                "UPDATE recording_audio_sources SET start_offset_ns = ? WHERE take_id = ?",
                (max(start_offset_ns, 0), take_id),
            )
        _require_row(cursor, "recording take audio source", take_id)

    def append_transcript_event(
        self,
        take_id: int,
        *,
        kind: str,
        text: str,
        audio_start_offset_ns: int,
        audio_end_offset_ns: int,
        emitted_offset_ns: int,
        revision: int,
        model: str,
        metadata: Mapping[str, Any] | None = None,
    ) -> int:
        if kind not in {"partial", "final", "error"}:
            raise ValueError("transcript event kind must be partial, final, or error")
        with self._connection:
            cursor = self._connection.execute(
                """
                INSERT INTO recording_transcript_events (
                    take_id, sequence_no, kind, text,
                    audio_start_offset_ns, audio_end_offset_ns,
                    emitted_offset_ns, revision, model, metadata_json
                )
                SELECT ?, COALESCE(MAX(sequence_no), -1) + 1, ?, ?, ?, ?, ?, ?, ?, ?
                FROM recording_transcript_events WHERE take_id = ?
                """,
                (
                    take_id,
                    kind,
                    text,
                    max(audio_start_offset_ns, 0),
                    max(audio_end_offset_ns, 0),
                    max(emitted_offset_ns, 0),
                    max(revision, 0),
                    model,
                    _json(metadata) if metadata is not None else None,
                    take_id,
                ),
            )
        return _last_row_id(cursor)

    def export_take(self, take_id: int) -> dict[str, Any] | None:
        take = self.inspect_take(take_id)
        if take is None:
            return None
        catalog_rows = self._connection.execute(
            """
            SELECT source, parameter_name, min_value, max_value, default_value,
                   captured_at_utc, definition_json
            FROM parameter_catalog_snapshots
            WHERE session_id = ?
            ORDER BY source, parameter_name
            """,
            (take["session_id"],),
        ).fetchall()
        take["parameter_catalog"] = [
            {
                "source": row["source"],
                "name": row["parameter_name"],
                "min": row["min_value"],
                "max": row["max_value"],
                "default": row["default_value"],
                "captured_at_utc": row["captured_at_utc"],
                "definition": _decode_json(row["definition_json"]),
            }
            for row in catalog_rows
        ]
        rows = self._connection.execute(
            """
            SELECT source, sequence_no, scheduled_offset_ns, sent_offset_ns,
                   received_offset_ns, vts_timestamp_ms, model_id, values_json
            FROM parameter_frames WHERE take_id = ? ORDER BY source, sequence_no
            """,
            (take_id,),
        ).fetchall()
        take["frames"] = [
            {
                "source": row["source"],
                "sequence_no": int(row["sequence_no"]),
                "scheduled_offset_ns": int(row["scheduled_offset_ns"]),
                "sent_offset_ns": int(row["sent_offset_ns"]),
                "received_offset_ns": int(row["received_offset_ns"]),
                "vts_timestamp_ms": row["vts_timestamp_ms"],
                "model_id": row["model_id"],
                "values": _decode_json(row["values_json"]),
            }
            for row in rows
        ]
        audio_row = self._connection.execute(
            """
            SELECT path, sample_rate, channels, encoding, start_offset_ns
            FROM recording_audio_sources WHERE take_id = ?
            """,
            (take_id,),
        ).fetchone()
        take["audio"] = (
            {
                "path": audio_row["path"],
                "sample_rate": int(audio_row["sample_rate"]),
                "channels": int(audio_row["channels"]),
                "encoding": audio_row["encoding"],
                "start_offset_ns": int(audio_row["start_offset_ns"]),
            }
            if audio_row is not None
            else None
        )
        transcript_rows = self._connection.execute(
            """
            SELECT sequence_no, kind, text, audio_start_offset_ns,
                   audio_end_offset_ns, emitted_offset_ns, revision, model,
                   metadata_json
            FROM recording_transcript_events
            WHERE take_id = ? ORDER BY sequence_no
            """,
            (take_id,),
        ).fetchall()
        take["transcript_events"] = [
            {
                "sequence_no": int(row["sequence_no"]),
                "kind": row["kind"],
                "text": row["text"],
                "audio_start_offset_ns": int(row["audio_start_offset_ns"]),
                "audio_end_offset_ns": int(row["audio_end_offset_ns"]),
                "emitted_offset_ns": int(row["emitted_offset_ns"]),
                "revision": int(row["revision"]),
                "model": row["model"],
                "metadata": _decode_json(row["metadata_json"]),
            }
            for row in transcript_rows
        ]
        return take

    def delete_take(self, take_id: int) -> bool:
        with self._connection:
            cursor = self._connection.execute(
                "DELETE FROM recording_takes WHERE id = ?",
                (take_id,),
            )
        return cursor.rowcount > 0

    def _next_sequence_numbers(
        self,
        take_id: int,
        samples: Iterable[ProbeSample],
    ) -> dict[str, int]:
        sources = sorted({sample.source for sample in samples})
        if not sources:
            return {}
        placeholders = ", ".join("?" for _ in sources)
        rows = self._connection.execute(
            f"""
            SELECT source, MAX(sequence_no) AS maximum_sequence_no
            FROM parameter_frames
            WHERE take_id = ? AND source IN ({placeholders})
            GROUP BY source
            """,
            (take_id, *sources),
        ).fetchall()
        result = {source: 0 for source in sources}
        for row in rows:
            result[str(row["source"])] = int(row["maximum_sequence_no"]) + 1
        return result

    def _initialize_schema(self) -> None:
        with self._connection:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS recorder_schema_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS recording_sessions (
                    id INTEGER PRIMARY KEY,
                    started_at_utc TEXT NOT NULL,
                    ended_at_utc TEXT,
                    recorder_version TEXT NOT NULL,
                    vts_endpoint TEXT NOT NULL,
                    requested_hz REAL NOT NULL,
                    vts_version TEXT,
                    initial_model_id TEXT,
                    initial_model_name TEXT,
                    target_contract_json TEXT NOT NULL,
                    status TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS parameter_catalog_snapshots (
                    id INTEGER PRIMARY KEY,
                    session_id INTEGER NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
                    captured_at_utc TEXT NOT NULL,
                    source TEXT NOT NULL,
                    parameter_name TEXT NOT NULL,
                    min_value REAL,
                    max_value REAL,
                    default_value REAL,
                    definition_json TEXT NOT NULL,
                    UNIQUE(session_id, source, parameter_name)
                );

                CREATE TABLE IF NOT EXISTS recording_takes (
                    id INTEGER PRIMARY KEY,
                    session_id INTEGER NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
                    started_at_utc TEXT NOT NULL,
                    ended_at_utc TEXT,
                    start_monotonic_ns INTEGER NOT NULL,
                    duration_ms INTEGER,
                    operator_label TEXT,
                    status TEXT NOT NULL,
                    termination_reason TEXT,
                    environment_stable INTEGER,
                    sampling_report_json TEXT,
                    failure_message TEXT
                );

                CREATE TABLE IF NOT EXISTS parameter_frames (
                    take_id INTEGER NOT NULL REFERENCES recording_takes(id) ON DELETE CASCADE,
                    source TEXT NOT NULL,
                    sequence_no INTEGER NOT NULL,
                    scheduled_offset_ns INTEGER NOT NULL,
                    sent_offset_ns INTEGER NOT NULL,
                    received_offset_ns INTEGER NOT NULL,
                    vts_timestamp_ms INTEGER,
                    model_id TEXT,
                    values_json TEXT NOT NULL,
                    PRIMARY KEY (take_id, source, sequence_no)
                );

                CREATE TABLE IF NOT EXISTS recording_events (
                    id INTEGER PRIMARY KEY,
                    take_id INTEGER NOT NULL REFERENCES recording_takes(id) ON DELETE CASCADE,
                    relative_monotonic_ns INTEGER NOT NULL,
                    event_kind TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    vts_timestamp_ms INTEGER,
                    data_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS recording_audio_sources (
                    take_id INTEGER PRIMARY KEY REFERENCES recording_takes(id) ON DELETE CASCADE,
                    path TEXT NOT NULL,
                    sample_rate INTEGER NOT NULL,
                    channels INTEGER NOT NULL,
                    encoding TEXT NOT NULL,
                    start_offset_ns INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS recording_transcript_events (
                    id INTEGER PRIMARY KEY,
                    take_id INTEGER NOT NULL REFERENCES recording_takes(id) ON DELETE CASCADE,
                    sequence_no INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    text TEXT NOT NULL,
                    audio_start_offset_ns INTEGER NOT NULL,
                    audio_end_offset_ns INTEGER NOT NULL,
                    emitted_offset_ns INTEGER NOT NULL,
                    revision INTEGER NOT NULL,
                    model TEXT NOT NULL,
                    metadata_json TEXT,
                    UNIQUE(take_id, sequence_no)
                );

                CREATE TABLE IF NOT EXISTS take_annotations (
                    take_id INTEGER PRIMARY KEY REFERENCES recording_takes(id) ON DELETE CASCADE,
                    review_status TEXT NOT NULL DEFAULT 'draft',
                    context_json TEXT,
                    target_json TEXT,
                    derivation_version TEXT,
                    reviewed_at_utc TEXT,
                    reviewer_note TEXT
                );

                CREATE INDEX IF NOT EXISTS parameter_frames_take_source_sequence_idx
                    ON parameter_frames(take_id, source, sequence_no);
                CREATE INDEX IF NOT EXISTS recording_events_take_idx
                    ON recording_events(take_id, id);
                CREATE INDEX IF NOT EXISTS recording_transcript_events_take_idx
                    ON recording_transcript_events(take_id, sequence_no);
                """
            )
            audio_columns = {
                str(column["name"])
                for column in self._connection.execute(
                    "PRAGMA table_info(recording_audio_sources)"
                ).fetchall()
            }
            if "start_offset_ns" not in audio_columns:
                self._connection.execute(
                    "ALTER TABLE recording_audio_sources "
                    "ADD COLUMN start_offset_ns INTEGER NOT NULL DEFAULT 0"
                )
            row = self._connection.execute(
                "SELECT value FROM recorder_schema_metadata WHERE key = 'schema_version'"
            ).fetchone()
            if row is None:
                self._connection.execute(
                    "INSERT INTO recorder_schema_metadata (key, value) VALUES ('schema_version', ?)",
                    (str(SCHEMA_VERSION),),
                )
            elif row["value"] != str(SCHEMA_VERSION):
                raise RecorderStoreError(
                    "Unsupported VTS recorder database schema version "
                    f"{row['value']}; expected {SCHEMA_VERSION}"
                )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _decode_json(value: str | None) -> Any:
    return json.loads(value) if value else None


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _required_parameter_name(parameter: Mapping[str, Any], source: str) -> str:
    name = str(parameter.get("name") or "").strip()
    if not name:
        raise RecorderStoreError(f"VTube Studio {source} parameter catalog contains an unnamed parameter")
    return name


def _relative_ns(value: int, start_ns: int) -> int:
    return max(value - start_ns, 0)


def _optional_bool(value: Any) -> bool | None:
    return None if value is None else bool(value)


def _last_row_id(cursor: sqlite3.Cursor) -> int:
    if cursor.lastrowid is None:
        raise RecorderStoreError("SQLite did not return a row ID for recorder insert")
    return int(cursor.lastrowid)


def _require_row(cursor: sqlite3.Cursor, label: str, record_id: int) -> None:
    if cursor.rowcount != 1:
        raise RecorderStoreError(f"Unknown {label} ID: {record_id}")
