from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1


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
        rows = [
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
                _optional_text(event.get("user_text")),
                _optional_text(event.get("assistant_text")),
                _optional_text(event.get("payload_kind")),
                _json_dumps(event.get("raw")),
                inserted_at,
            )
            for event in events
            if str(event.get("id") or "").strip()
            and str(event.get("event_type") or "").strip()
        ]
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
                    user_text,
                    assistant_text,
                    payload_kind,
                    raw_json,
                    inserted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )

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
                INSERT OR REPLACE INTO motion_lab_meta (key, value)
                VALUES ('schema_version', ?)
                """,
                (str(SCHEMA_VERSION),),
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
                    user_text TEXT,
                    assistant_text TEXT,
                    payload_kind TEXT,
                    raw_json TEXT NOT NULL,
                    inserted_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_motion_lab_raw_events_created_at
                ON motion_lab_raw_events(created_at)
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
