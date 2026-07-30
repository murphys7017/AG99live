import asyncio
import time

from ag99_vts_recorder.client import VTSResponse
from ag99_vts_recorder.sampler import sample_parameters


class _BlockingClient:
    def __init__(self) -> None:
        self._request_count = 0
        self.blocking_request_started = asyncio.Event()

    async def request(self, message_type: str) -> VTSResponse:
        self._request_count += 1
        if self._request_count > 2:
            self.blocking_request_started.set()
            await asyncio.Future()

        now_ns = time.monotonic_ns()
        if message_type == "InputParameterListRequest":
            data = {
                "defaultParameters": [{"name": "FaceAngleX", "value": 0.0}],
                "customParameters": [],
            }
        else:
            data = {
                "modelLoaded": True,
                "modelID": "model",
                "parameters": [{"name": "ParamAngleX", "value": 0.0}],
            }
        return VTSResponse(
            request_id=str(self._request_count),
            message_type=message_type,
            data=data,
            raw={},
            sent_monotonic_ns=now_ns,
            received_monotonic_ns=now_ns,
            vts_timestamp_ms=None,
        )

    def drain_events(self) -> list[object]:
        return []


def test_sampling_interruption_returns_the_samples_collected_so_far() -> None:
    async def run() -> tuple[object, list[int]]:
        client = _BlockingClient()
        batch_sizes: list[int] = []
        task = asyncio.create_task(
            sample_parameters(
                client,
                hz=20,
                seconds=10,
                known_model_id="model",
                on_batch=lambda samples, _events: batch_sizes.append(len(samples)),
            )
        )
        await asyncio.wait_for(client.blocking_request_started.wait(), timeout=1)
        task.cancel()
        return await task, batch_sizes

    result, batch_sizes = asyncio.run(run())

    assert result.report["termination_reason"] == "interrupted"
    assert len(result.samples) == 2
    assert batch_sizes == [2]
    assert result.report["sources"]["tracking_input"]["sample_count"] == 1
    assert result.report["sources"]["live2d_parameter"]["sample_count"] == 1
