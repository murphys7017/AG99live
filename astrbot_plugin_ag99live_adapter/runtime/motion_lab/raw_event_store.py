from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 2


class MotionLabRawEventStore:
    """Append-only SQLite store for motion lab raw events."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self._initialized = False

    def insert_events(self, events: list[dict[str, Any]]) -> None:
        if not events:
            return
        self._ensure_initialized()
        inserted_at = _utc_now_iso()
        rows = []
        for event in events:
            if not (
                str(event.get("id") or "").strip()
                and str(event.get("event_type") or "").strip()
            ):
                continue
            projection = _extract_motion_projection(event.get("raw"))
            rows.append(
                (
                str(event.get("id") or "").strip(),
                str(event.get("created_at") or "").strip() or inserted_at,
                str(event.get("event_type") or "").strip(),
                _optional_text(event.get("conversation_uid")),
                _optional_text(event.get("history_uid")),
                _optional_text(event.get("turn_id")),
                _optional_text(event.get("frontend_turn_id")),
                _optional_text(event.get("message_id")),
                _optional_text(event.get("source_route")),
                _optional_text(event.get("phase")),
                _optional_text(event.get("model_name")),
                _optional_text(event.get("profile_id")),
                _optional_int(event.get("profile_revision")),
                _optional_text(projection.get("profile_hash")),
                _optional_text(projection.get("transform_version")),
                _optional_text(projection.get("run_id")),
                _optional_text(event.get("user_text")),
                _optional_text(event.get("assistant_text")),
                _optional_text(event.get("payload_kind")),
                _json_dumps(event.get("raw")),
                _json_dumps(projection.get("transform_trace")),
                _json_dumps(projection.get("timeline_outcome")),
                inserted_at,
                )
            )
        if not rows:
            return
        with self._connect() as conn:
            conn.executemany(
                """
                INSERT OR IGNORE INTO motion_lab_raw_events (
                    id,
                    created_at,
                    event_type,
                    conversation_uid,
                    history_uid,
                    turn_id,
                    frontend_turn_id,
                    message_id,
                    source_route,
                    phase,
                    model_name,
                    profile_id,
                    profile_revision,
                    profile_hash,
                    transform_version,
                    run_id,
                    user_text,
                    assistant_text,
                    payload_kind,
                    raw_json,
                    transform_trace_json,
                    timeline_outcome_json,
                    inserted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )

    def get_turn_context(
        self,
        *,
        turn_id: str,
        message_id: str,
    ) -> dict[str, str] | None:
        normalized_turn_id = str(turn_id or "").strip()
        normalized_message_id = str(message_id or "").strip()
        if not normalized_turn_id or not normalized_message_id:
            return None
        self._ensure_initialized()
        with self._connect() as conn:
            user_row = conn.execute(
                """
                SELECT user_text
                FROM motion_lab_raw_events
                WHERE turn_id = ?
                  AND event_type = 'turn.input_received'
                  AND TRIM(COALESCE(user_text, '')) <> ''
                ORDER BY created_at DESC, id DESC
                LIMIT 1
                """,
                (normalized_turn_id,),
            ).fetchone()
            assistant_row = conn.execute(
                """
                SELECT assistant_text
                FROM motion_lab_raw_events
                WHERE turn_id = ?
                  AND message_id = ?
                  AND event_type = 'turn.assistant_output'
                  AND TRIM(COALESCE(assistant_text, '')) <> ''
                ORDER BY created_at DESC, id DESC
                LIMIT 1
                """,
                (normalized_turn_id, normalized_message_id),
            ).fetchone()
        user_text = str(user_row[0] or "").strip() if user_row else ""
        assistant_text = str(assistant_row[0] or "").strip() if assistant_row else ""
        if not user_text or not assistant_text:
            return None
        return {
            "user_text": user_text,
            "assistant_text": assistant_text,
        }

    def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS motion_lab_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS motion_lab_raw_events (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    conversation_uid TEXT,
                    history_uid TEXT,
                    turn_id TEXT,
                    frontend_turn_id TEXT,
                    message_id TEXT,
                    source_route TEXT,
                    phase TEXT,
                    model_name TEXT,
                    profile_id TEXT,
                    profile_revision INTEGER,
                    profile_hash TEXT,
                    transform_version TEXT,
                    run_id TEXT,
                    user_text TEXT,
                    assistant_text TEXT,
                    payload_kind TEXT,
                    raw_json TEXT NOT NULL,
                    transform_trace_json TEXT NOT NULL DEFAULT '{}',
                    timeline_outcome_json TEXT NOT NULL DEFAULT '{}',
                    inserted_at TEXT NOT NULL
                )
                """
            )
            _require_schema_version(conn)
            _require_current_event_columns(conn)
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_motion_lab_raw_events_created_at
                ON motion_lab_raw_events(created_at)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_motion_lab_raw_events_segment
                ON motion_lab_raw_events(turn_id, message_id)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_motion_lab_raw_events_run_id
                ON motion_lab_raw_events(run_id)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_motion_lab_raw_events_turn_id
                ON motion_lab_raw_events(turn_id)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_motion_lab_raw_events_event_type
                ON motion_lab_raw_events(event_type)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_motion_lab_raw_events_profile
                ON motion_lab_raw_events(profile_id, profile_revision)
                """
            )
        self._initialized = True

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(str(self.db_path), timeout=5.0)


def _json_dumps(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False, default=str)


def _require_schema_version(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT value FROM motion_lab_meta WHERE key = 'schema_version'"
    ).fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO motion_lab_meta (key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
        return
    if str(row[0]) != str(SCHEMA_VERSION):
        raise RuntimeError(
            f"motion_lab_schema_version_mismatch:{row[0]}:{SCHEMA_VERSION}"
        )


def _require_current_event_columns(conn: sqlite3.Connection) -> None:
    required_columns = {
        "id",
        "created_at",
        "event_type",
        "conversation_uid",
        "history_uid",
        "turn_id",
        "frontend_turn_id",
        "message_id",
        "source_route",
        "phase",
        "model_name",
        "profile_id",
        "profile_revision",
        "profile_hash",
        "transform_version",
        "run_id",
        "user_text",
        "assistant_text",
        "payload_kind",
        "raw_json",
        "transform_trace_json",
        "timeline_outcome_json",
        "inserted_at",
    }
    actual_columns = {
        str(row[1])
        for row in conn.execute("PRAGMA table_info(motion_lab_raw_events)").fetchall()
    }
    missing_columns = sorted(required_columns - actual_columns)
    if missing_columns:
        raise RuntimeError(
            "motion_lab_schema_columns_missing:" + ",".join(missing_columns)
        )


def _extract_motion_projection(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}

    candidates = [value]
    frontend_payload = value.get("frontend_payload")
    if isinstance(frontend_payload, dict):
        candidates.append(frontend_payload)
        frontend_raw = frontend_payload.get("raw")
        if isinstance(frontend_raw, dict):
            candidates.append(frontend_raw)

    transform_trace = None
    timeline_outcome = None
    run_id = ""
    for candidate in candidates:
        if not run_id:
            run_id = str(candidate.get("runId") or candidate.get("run_id") or "").strip()
        raw_trace = candidate.get("transform_trace")
        if isinstance(raw_trace, dict):
            transform_trace = raw_trace
        diagnostics = candidate.get("diagnostics")
        if isinstance(diagnostics, dict) and isinstance(
            diagnostics.get("transformTrace"), dict
        ):
            transform_trace = diagnostics["transformTrace"]
        raw_outcome = candidate.get("timeline_outcome")
        if isinstance(raw_outcome, dict):
            timeline_outcome = raw_outcome

    trace = transform_trace if isinstance(transform_trace, dict) else {}
    return {
        "profile_hash": trace.get("profileHash"),
        "transform_version": trace.get("transformVersion"),
        "run_id": run_id,
        "transform_trace": trace,
        "timeline_outcome": (
            timeline_outcome if isinstance(timeline_outcome, dict) else {}
        ),
    }


def _optional_text(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _optional_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
