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
                        "schema_version": "engine.motion_intent.v4",
                        "intent_tags": ["hello"],
                        "axis_levels": {"head_yaw": 1},
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


def test_motion_lab_recorder_calls_persisted_callback_after_insert(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime.motion_lab.recorder import MotionLabRecorder

    operations: list[str] = []

    class StoreStub:
        def insert_events(self, events: list[dict[str, object]]) -> None:
            assert events[0]["id"] == "event-callback"
            operations.append("insert")

    async def run() -> None:
        recorder = MotionLabRecorder(store=StoreStub())  # type: ignore[arg-type]
        assert recorder.enqueue(
            {
                "id": "event-callback",
                "event_type": "motion.completed",
                "raw": {},
            },
            on_persisted=lambda: operations.append("callback"),
        )
        assert operations == []
        await recorder.close()

    asyncio.run(run())
    assert operations == ["insert", "callback"]


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
    assert schema_version == ("3",)


def test_motion_lab_schema_upgrade_discards_legacy_raw_event_rows(
    install_fake_astrbot,
    tmp_path,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime.motion_lab.raw_event_store import (
        MotionLabRawEventStore,
    )

    db_path = tmp_path / "motion_lab.sqlite3"
    legacy_store = MotionLabRawEventStore(db_path)
    legacy_store.insert_events(
        [{"id": "old-event", "event_type": "motion.playback_started", "raw": {}}]
    )
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "UPDATE motion_lab_meta SET value = '2' WHERE key = 'schema_version'"
        )

    upgraded_store = MotionLabRawEventStore(db_path)
    upgraded_store.insert_events(
        [
            {
                "id": "new-sample",
                "event_type": "motion.persona_sample.v1",
                "payload_kind": "ag99live.persona_motion_sample.v1",
                "raw": {
                    "sample_schema": "ag99live.persona_motion_sample.v1",
                    "sample_id": "sample-1",
                },
            }
        ]
    )

    with sqlite3.connect(db_path) as conn:
        event_ids = conn.execute(
            "SELECT id FROM motion_lab_raw_events ORDER BY id"
        ).fetchall()
        schema_version = conn.execute(
            "SELECT value FROM motion_lab_meta WHERE key = 'schema_version'"
        ).fetchone()

    assert event_ids == [("new-sample",)]
    assert schema_version == ("3",)


def test_persona_motion_sample_event_persists_input_and_intent(
    install_fake_astrbot,
    tmp_path,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.observation import (
        record_persona_motion_sample,
    )
    from astrbot_plugin_ag99live_adapter.runtime.motion_lab.raw_event_store import (
        MotionLabRawEventStore,
    )
    from astrbot_plugin_ag99live_adapter.runtime.motion_lab.recorder import (
        MotionLabRecorder,
    )

    db_path = tmp_path / "motion_lab.sqlite3"

    async def persist_sample() -> None:
        recorder = MotionLabRecorder(store=MotionLabRawEventStore(db_path))
        assert record_persona_motion_sample(
            recorder,
            turn_id="turn-1",
            core_turn_id="core-turn-1",
            persona_result_id="persona-1",
            segment_index=0,
            segment_count=1,
            segment_message_id="message-1",
            source_route="independent_motion",
            delivery_mode="M2_olv_incremental",
            record_stage="motion_request",
            record_key="request-1:request",
            input_context={
                "user_text": "你好",
                "recent_context": [],
                "motion_request": {
                    "prompt": "actual user prompt",
                    "system_prompt": "actual system prompt",
                },
            },
            persona_segment={
                "speech": "",
                "speech_state": "not_yet_ready",
                "actions": ["look_at_user"],
                "tendency": {"Joy": 4},
            },
            motion={"status": "requested", "provider_final": False},
        )
        assert record_persona_motion_sample(
            recorder,
            turn_id="turn-1",
            core_turn_id="core-turn-1",
            persona_result_id="persona-1",
            segment_index=0,
            segment_count=1,
            segment_message_id="message-1",
            source_route="independent_motion",
            delivery_mode="M2_olv_incremental",
            record_stage="motion_candidate",
            record_key="request-1:update:1",
            input_context={"user_text": "你好", "recent_context": []},
            persona_segment={
                "speech": "欢迎回来",
                "actions": ["look_at_user"],
                "tendency": {"Joy": 4},
            },
            motion={
                "accepted_payload": {"intent_tags": ["greeting"]},
                "status": "provider_preview",
                "provider_final": False,
                "provider_update_index": 1,
            },
        )
        assert record_persona_motion_sample(
            recorder,
            turn_id="turn-1",
            core_turn_id="core-turn-1",
            persona_result_id="persona-1",
            segment_index=0,
            segment_count=1,
            segment_message_id="message-1",
            source_route="independent_motion",
            delivery_mode="M2_olv_incremental",
            record_stage="motion_result",
            record_key="request-1:final",
            input_context={"user_text": "你好", "recent_context": []},
            persona_segment={
                "speech": "欢迎回来",
                "actions": ["look_at_user"],
                "tendency": {"Joy": 4},
            },
            motion={
                "accepted_payload": {"intent_tags": ["greeting"]},
                "status": "provider_normalized",
                "provider_final": True,
            },
        )
        await recorder.close()

    asyncio.run(persist_sample())
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT event_type, source_route, raw_json FROM motion_lab_raw_events"
        ).fetchall()

    assert len(rows) == 3
    samples = [json.loads(row[2]) for row in rows]
    assert all(row[:2] == ("motion.persona_sample.v1", "independent_motion") for row in rows)
    assert {sample["record_stage"] for sample in samples} == {
        "motion_request",
        "motion_candidate",
        "motion_result",
    }
    assert len({sample["sample_id"] for sample in samples}) == 1
    assert all(sample["sample_schema"] == "ag99live.persona_motion_sample.v1" for sample in samples)
    assert all(sample["delivery"]["mode"] == "M2_olv_incremental" for sample in samples)
    assert all(sample["identity"]["core_turn_id"] == "core-turn-1" for sample in samples)
    assert all(sample["input"]["user_text"] == "你好" for sample in samples)
    request_sample = next(
        sample for sample in samples if sample["record_stage"] == "motion_request"
    )
    assert request_sample["input"]["motion_request"]["prompt"] == "actual user prompt"
    assert request_sample["persona_segment"]["speech_state"] == "not_yet_ready"
    candidate_sample = next(
        sample for sample in samples if sample["record_stage"] == "motion_candidate"
    )
    assert candidate_sample["motion"]["status"] == "provider_preview"
    assert candidate_sample["motion"]["provider_update_index"] == 1
    assert all(sample["persona_segment"]["tendency"] == {"Joy": 4} for sample in samples)
    assert all(
        sample["motion"]["accepted_payload"]["intent_tags"] == ["greeting"]
        for sample in samples
        if "accepted_payload" in sample["motion"]
    )
    assert {sample["motion"]["provider_final"] for sample in samples} == {False, True}


def test_persona_delivery_mode_uses_incremental_writer_presence(
    install_fake_astrbot,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.motion.observation import (
        resolve_persona_delivery_mode,
    )
    from astrbot_plugin_ag99live_adapter.runtime.persona_lifecycle import (
        PersonaTurnIdentity,
        PersonaTurnSessionRegistry,
    )
    from types import SimpleNamespace

    class EventStub:
        def __init__(self, extras: dict[str, object]) -> None:
            self.extras = extras

        def get_extra(self, key: str, default: object = None) -> object:
            return self.extras.get(key, default)

    active_event = EventStub(
        {
            "_turn_id": "turn-1",
            "_interaction_persona_segment_stream_active": True,
        }
    )
    sessions = PersonaTurnSessionRegistry()
    active_event.adapter = SimpleNamespace(
        runtime_state=SimpleNamespace(persona_sessions=sessions)
    )
    sessions.register_writer(
        PersonaTurnIdentity("turn-1"),
        "result-1",
        SimpleNamespace(core_turn_id="core-turn-1", persona_result_id="result-1"),
    )

    assert resolve_persona_delivery_mode(EventStub({})) == "M0_nonstreaming"
    assert resolve_persona_delivery_mode(
        EventStub({"_interaction_persona_segment_stream_active": True})
    ) == "M1_persona_segment_stream"
    assert resolve_persona_delivery_mode(active_event) == "M2_olv_incremental"


def test_motion_lab_store_rejects_newer_schema_without_deleting_rows(
    install_fake_astrbot,
    tmp_path,
) -> None:
    install_fake_astrbot()
    from astrbot_plugin_ag99live_adapter.runtime.motion_lab.raw_event_store import (
        MotionLabRawEventStore,
    )

    db_path = tmp_path / "motion_lab.sqlite3"
    MotionLabRawEventStore(db_path).insert_events(
        [{"id": "future-event", "event_type": "motion.future", "raw": {}}]
    )
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "UPDATE motion_lab_meta SET value = '4' WHERE key = 'schema_version'"
        )

    with pytest.raises(RuntimeError, match="schema_version_newer_than_adapter"):
        MotionLabRawEventStore(db_path).insert_events(
            [{"id": "must-not-write", "event_type": "motion.current", "raw": {}}]
        )

    with sqlite3.connect(db_path) as conn:
        event_ids = conn.execute(
            "SELECT id FROM motion_lab_raw_events ORDER BY id"
        ).fetchall()

    assert event_ids == [("future-event",)]
