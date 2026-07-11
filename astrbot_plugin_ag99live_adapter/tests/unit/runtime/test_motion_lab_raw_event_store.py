from __future__ import annotations

import asyncio
from copy import Error as CopyError
import json
import sqlite3

import pytest


def test_motion_lab_raw_event_store_creates_sqlite_and_inserts_events(
    install_fake_astrbot,
    tmp_path,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime.motion_lab.raw_event_store import (
        MotionLabRawEventStore,
    )

    db_path = tmp_path / "motion_lab.sqlite3"
    store = MotionLabRawEventStore(db_path)

    store.insert_events(
        [
            {
                "id": "event-1",
                "created_at": "2026-06-28T00:00:00+00:00",
                "event_type": "motion.egress_sent",
                "turn_id": "turn-1",
                "message_id": "message-1",
                "source_route": "persona_effect",
                "profile_id": "pet.semantic.v1",
                "profile_revision": 2,
                "assistant_text": "你好",
                "payload_kind": "intent",
                "raw": {
                    "motion_payload": {
                        "schema_version": "engine.motion_intent.v3",
                        "intent_tags": ["hello"],
                    },
                },
            }
        ]
    )

    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT event_type, turn_id, profile_id, profile_revision, raw_json
            FROM motion_lab_raw_events
            WHERE id = 'event-1'
            """
        ).fetchone()

    assert row is not None
    assert row[0] == "motion.egress_sent"
    assert row[1] == "turn-1"
    assert row[2] == "pet.semantic.v1"
    assert row[3] == 2
    assert json.loads(row[4])["motion_payload"]["intent_tags"] == ["hello"]


def test_motion_lab_recorder_keeps_event_when_raw_contains_non_json_object(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime.motion_lab.recorder import MotionLabRecorder

    class NonCopyableValue:
        def __deepcopy__(self, _memo):
            raise CopyError("cannot copy")

        def __str__(self) -> str:
            return "non-copyable-value"

    class StoreStub:
        def __init__(self) -> None:
            self.events: list[dict[str, object]] = []

        def insert_events(self, events: list[dict[str, object]]) -> None:
            self.events.extend(events)

    async def run() -> StoreStub:
        store = StoreStub()
        recorder = MotionLabRecorder(store=store)  # type: ignore[arg-type]
        cyclic: dict[str, object] = {}
        cyclic["self"] = cyclic

        assert recorder.enqueue(
            {
                "event_type": "motion.egress_sent",
                "raw": {
                    "value": NonCopyableValue(),
                    "cycle": cyclic,
                },
            }
        )
        await recorder.close()
        assert recorder.enqueue({"event_type": "motion.after_close"}) is False
        return store

    store = asyncio.run(run())

    assert len(store.events) == 1
    assert store.events[0]["raw"] == {
        "value": "non-copyable-value",
        "cycle": {"self": "<cycle>"},
    }


def test_motion_lab_recorder_close_cancels_worker_after_persistent_write_failure(
    install_fake_astrbot,
    tmp_path,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime.motion_lab.raw_event_store import (
        MotionLabRawEventStore,
    )
    from astrbot_plugin_ag99live_adapter.runtime.motion_lab.recorder import MotionLabRecorder

    class FailingStore(MotionLabRawEventStore):
        def insert_events(self, events: list[dict[str, object]]) -> None:
            raise OSError("sqlite unavailable")

    async def run() -> None:
        recorder = MotionLabRecorder(
            store=FailingStore(tmp_path / "motion_lab.sqlite3"),
        )
        assert recorder.enqueue({"event_type": "motion.write_failure"}) is True
        with pytest.raises(RuntimeError, match="close timed out"):
            await recorder.close(timeout_seconds=0.1)
        assert recorder._worker_task is None

    asyncio.run(run())


def test_motion_lab_store_projects_transform_trace_and_timeline_outcome(
    install_fake_astrbot,
    tmp_path,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime.motion_lab.raw_event_store import (
        MotionLabRawEventStore,
    )

    db_path = tmp_path / "motion_lab.sqlite3"
    store = MotionLabRawEventStore(db_path)
    store.insert_events(
        [
            {
                "id": "event-trace",
                "event_type": "motion.playback_completed",
                "turn_id": "turn-1",
                "message_id": "message-1",
                "raw": {
                    "frontend_payload": {
                        "raw": {
                            "runId": "run-1",
                            "transform_trace": {
                                "transformVersion": "semantic_motion_transform.v1",
                                "profileHash": "sha256:test",
                                "rawAxisLevels": {"head_yaw": 2},
                                "resolvedAxes": {"head_yaw": 64},
                            },
                            "timeline_outcome": {"motion": "completed"},
                        }
                    }
                },
            }
        ]
    )

    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT profile_hash, transform_version, run_id,
                   transform_trace_json, timeline_outcome_json
            FROM motion_lab_raw_events
            WHERE id = 'event-trace'
            """
        ).fetchone()
        schema_version = conn.execute(
            "SELECT value FROM motion_lab_meta WHERE key = 'schema_version'"
        ).fetchone()

    assert row is not None
    assert row[:3] == (
        "sha256:test",
        "semantic_motion_transform.v1",
        "run-1",
    )
    assert json.loads(row[3])["rawAxisLevels"] == {"head_yaw": 2}
    assert json.loads(row[4]) == {"motion": "completed"}
    assert schema_version == ("2",)


def test_motion_lab_store_migrates_existing_v1_table(
    install_fake_astrbot,
    tmp_path,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime.motion_lab.raw_event_store import (
        MotionLabRawEventStore,
    )

    db_path = tmp_path / "motion_lab.sqlite3"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "CREATE TABLE motion_lab_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        conn.execute(
            "INSERT INTO motion_lab_meta (key, value) VALUES ('schema_version', '1')"
        )
        conn.execute(
            """
            CREATE TABLE motion_lab_raw_events (
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
            INSERT INTO motion_lab_raw_events (
                id, created_at, event_type, raw_json, inserted_at
            ) VALUES ('legacy-event', '2026-01-01', 'motion.legacy', '{}', '2026-01-01')
            """
        )

    store = MotionLabRawEventStore(db_path)
    store.insert_events(
        [{"id": "v2-event", "event_type": "motion.v2", "raw": {}}]
    )

    with sqlite3.connect(db_path) as conn:
        columns = {
            row[1]
            for row in conn.execute("PRAGMA table_info(motion_lab_raw_events)")
        }
        event_ids = {
            row[0]
            for row in conn.execute("SELECT id FROM motion_lab_raw_events")
        }
        schema_version = conn.execute(
            "SELECT value FROM motion_lab_meta WHERE key = 'schema_version'"
        ).fetchone()

    assert {
        "profile_hash",
        "transform_version",
        "run_id",
        "transform_trace_json",
        "timeline_outcome_json",
    }.issubset(columns)
    assert event_ids == {"legacy-event", "v2-event"}
    assert schema_version == ("2",)
