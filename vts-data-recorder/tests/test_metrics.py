from ag99_vts_recorder.metrics import ProbeSample, build_sampling_report


def test_sampling_report_tracks_latency_intervals_and_parameter_changes() -> None:
    samples = [
        ProbeSample(
            source="tracking_input",
            request_id="one",
            scheduled_monotonic_ns=0,
            sent_monotonic_ns=0,
            received_monotonic_ns=10_000_000,
            vts_timestamp_ms=1,
            model_id="model",
            values={"FaceAngleX": 0.0},
        ),
        ProbeSample(
            source="tracking_input",
            request_id="two",
            scheduled_monotonic_ns=50_000_000,
            sent_monotonic_ns=50_000_000,
            received_monotonic_ns=65_000_000,
            vts_timestamp_ms=2,
            model_id="model",
            values={"FaceAngleX": 1.0},
        ),
        ProbeSample(
            source="tracking_input",
            request_id="three",
            scheduled_monotonic_ns=100_000_000,
            sent_monotonic_ns=100_000_000,
            received_monotonic_ns=110_000_000,
            vts_timestamp_ms=3,
            model_id="model",
            values={"FaceAngleX": 1.0},
        ),
    ]

    report = build_sampling_report(
        samples=samples,
        requested_hz=20,
        elapsed_monotonic_ns=150_000_000,
        skipped_schedule_slots=0,
        errors=[],
        event_counts={"TrackingStatusChangedEvent": 1},
    )

    source = report["sources"]["tracking_input"]
    assert source["sample_count"] == 3
    assert source["effective_hz"] == 20.0
    assert source["rtt_ms"]["avg"] == 11.667
    assert source["response_interval_ms"]["avg"] == 50.0
    assert source["interval_jitter_ms"]["avg"] == 5.0
    assert source["parameter_metrics"]["FaceAngleX"] == {
        "min": 0.0,
        "max": 1.0,
        "change_count": 1,
    }
