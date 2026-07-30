from ag99_vts_recorder.discovery import DiscoveryResult
from ag99_vts_recorder.metrics import ProbeSample
from ag99_vts_recorder.sampler import SamplingEvent
from ag99_vts_recorder.store import RecorderStore


def test_recording_store_persists_inspects_and_deletes_a_take(tmp_path) -> None:
    database = tmp_path / "recordings.sqlite3"
    discovery = DiscoveryResult(
        model_loaded=True,
        model_id="model-id",
        model_name="Model Name",
        default_tracking_parameters=[
            {"name": "FaceAngleX", "min": -30, "max": 30, "defaultValue": 0}
        ],
        custom_tracking_parameters=[],
        live2d_parameters=[
            {"name": "ParamAngleX", "min": -30, "max": 30, "defaultValue": 0}
        ],
    )
    tracking_sample = ProbeSample(
        source="tracking_input",
        request_id="tracking-request",
        scheduled_monotonic_ns=1_100,
        sent_monotonic_ns=1_120,
        received_monotonic_ns=1_140,
        vts_timestamp_ms=12,
        model_id="model-id",
        values={"FaceAngleX": 1.5},
    )
    live2d_sample = ProbeSample(
        source="live2d_parameter",
        request_id="live2d-request",
        scheduled_monotonic_ns=1_100,
        sent_monotonic_ns=1_121,
        received_monotonic_ns=1_141,
        vts_timestamp_ms=12,
        model_id="model-id",
        values={"ParamAngleX": 1.0},
    )
    event = SamplingEvent(
        relative_monotonic_ns=145,
        message_type="TrackingStatusChangedEvent",
        vts_timestamp_ms=13,
        raw={"messageType": "TrackingStatusChangedEvent", "data": {"trackingActive": True}},
    )

    with RecorderStore(database) as store:
        session_id = store.create_session(
            endpoint="ws://localhost:8001",
            requested_hz=20,
            vts_version="1.0",
            model_id=discovery.model_id,
            model_name=discovery.model_name,
            target_contract={"axis_levels": {"allowed_axes": []}},
        )
        store.save_parameter_catalog(session_id, discovery)
        take_id = store.create_take(
            session_id,
            start_monotonic_ns=1_000,
            operator_label="calibration",
        )
        store.append_capture_batch(
            take_id,
            take_start_monotonic_ns=1_000,
            samples=[tracking_sample, live2d_sample],
            events=[event],
        )
        store.finish_take(
            take_id,
            status="completed",
            termination_reason="completed",
            environment_stable=True,
            duration_ms=200,
            sampling_report={"requested_hz": 20},
        )
        store.finish_session(session_id, status="completed")

        takes = store.list_takes()
        assert len(takes) == 1
        assert takes[0]["take_id"] == take_id
        assert takes[0]["session_id"] == session_id
        assert takes[0]["status"] == "completed"
        assert takes[0]["termination_reason"] == "completed"
        assert takes[0]["environment_stable"] is True
        assert takes[0]["duration_ms"] == 200
        assert takes[0]["operator_label"] == "calibration"
        assert takes[0]["tracking_frame_count"] == 1
        assert takes[0]["live2d_frame_count"] == 1
        assert takes[0]["event_count"] == 1
        inspected = store.inspect_take(take_id)
        assert inspected is not None
        assert inspected["frame_counts"] == {"live2d_parameter": 1, "tracking_input": 1}
        assert inspected["events"][0]["type"] == "TrackingStatusChangedEvent"
        assert inspected["session"]["model_id"] == "model-id"

        assert store.delete_take(take_id) is True
        assert store.inspect_take(take_id) is None
        assert store.list_takes() == []
