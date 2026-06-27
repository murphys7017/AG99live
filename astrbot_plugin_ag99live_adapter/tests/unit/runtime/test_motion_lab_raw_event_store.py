from __future__ import annotations

import asyncio
from copy import Error as CopyError
import json
import sqlite3


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
        await recorder._queue.join()
        return store

    store = asyncio.run(run())

    assert len(store.events) == 1
    assert store.events[0]["raw"] == {
        "value": "non-copyable-value",
        "cycle": {"self": "<cycle>"},
    }
