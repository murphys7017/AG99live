import asyncio
import time

from ag99_vts_recorder.client import VTSResponse
from ag99_vts_recorder.discovery import DiscoveryResult
from ag99_vts_recorder.recorder import record_parameters
from ag99_vts_recorder.store import RecorderStore


class _SamplingClient:
    def __init__(self, *, fail_tracking: bool = False) -> None:
        self._fail_tracking = fail_tracking

    async def request(self, message_type: str) -> VTSResponse:
        if message_type == "InputParameterListRequest" and self._fail_tracking:
            raise RuntimeError("tracking request failed")
        now_ns = time.monotonic_ns()
        if message_type == "InputParameterListRequest":
            data = {
                "defaultParameters": [{"name": "FaceAngleX", "value": 0.0}],
                "customParameters": [],
            }
        else:
            data = {
                "modelLoaded": True,
                "modelID": "model-id",
                "parameters": [{"name": "ParamAngleX", "value": 0.0}],
            }
        return VTSResponse(
            request_id=message_type,
            message_type=message_type,
            data=data,
            raw={},
            sent_monotonic_ns=now_ns,
            received_monotonic_ns=now_ns,
            vts_timestamp_ms=1,
        )

    def drain_events(self) -> list[object]:
        return []


def test_record_parameters_finishes_a_persisted_take(tmp_path) -> None:
    discovery = DiscoveryResult(
        model_loaded=True,
        model_id="model-id",
        model_name="Model Name",
        default_tracking_parameters=[{"name": "FaceAngleX"}],
        custom_tracking_parameters=[],
        live2d_parameters=[{"name": "ParamAngleX"}],
    )

    async def run(store: RecorderStore) -> int:
        result = await record_parameters(
            _SamplingClient(),
            store=store,
            endpoint="ws://localhost:8001",
            discovery=discovery,
            vts_version="1.0",
            hz=20,
            seconds=0.001,
            operator_label="test",
            subscription_warnings=[],
        )
        return result.take_id

    with RecorderStore(tmp_path / "recordings.sqlite3") as store:
        take_id = asyncio.run(run(store))
        take = store.inspect_take(take_id)

    assert take is not None
    assert take["status"] == "completed"
    assert take["frame_counts"] == {"live2d_parameter": 1, "tracking_input": 1}
    assert take["session"]["target_contract"]["export_eligible"] is False


def test_record_parameters_marks_incomplete_or_unverifiable_captures(tmp_path) -> None:
    discovery = DiscoveryResult(
        model_loaded=True,
        model_id="model-id",
        model_name="Model Name",
        default_tracking_parameters=[{"name": "FaceAngleX"}],
        custom_tracking_parameters=[],
        live2d_parameters=[{"name": "ParamAngleX"}],
    )

    async def run(
        store: RecorderStore,
        client: _SamplingClient,
        subscription_warnings: list[str],
    ) -> int:
        result = await record_parameters(
            client,
            store=store,
            endpoint="ws://localhost:8001",
            discovery=discovery,
            vts_version="1.0",
            hz=20,
            seconds=0.001,
            operator_label=None,
            subscription_warnings=subscription_warnings,
        )
        return result.take_id

    with RecorderStore(tmp_path / "recordings.sqlite3") as store:
        incomplete_take_id = asyncio.run(run(store, _SamplingClient(fail_tracking=True), []))
        unverified_take_id = asyncio.run(
            run(store, _SamplingClient(), ["ModelLoadedEvent subscription failed"])
        )
        incomplete_take = store.inspect_take(incomplete_take_id)
        unverified_take = store.inspect_take(unverified_take_id)

    assert incomplete_take is not None
    assert incomplete_take["status"] == "completed_with_issues"
    assert incomplete_take["sampling_report"]["capture_complete"] is False
    assert unverified_take is not None
    assert unverified_take["status"] == "completed_with_issues"
    assert unverified_take["environment_stable"] is False
    assert "VTube Studio environment event subscriptions were incomplete" in unverified_take[
        "sampling_report"
    ]["environment"]["issues"]
