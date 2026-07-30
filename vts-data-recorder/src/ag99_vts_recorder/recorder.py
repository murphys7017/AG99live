from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Mapping

from .client import VTSClient
from .discovery import DiscoveryResult
from .metrics import ProbeSample
from .sampler import SamplingEvent, SamplingResult, sample_parameters
from .store import RecorderStore


FRAME_BATCH_SIZE = 40


def default_target_contract() -> dict[str, Any]:
    """Persist the current target shape without claiming that axis calibration is complete."""

    return {
        "target_type": "MotionDecisionTarget",
        "axis_levels": {
            "allowed_axes": [],
            "minimum": -4,
            "maximum": 4,
        },
        "duration_hint_ms": {"minimum": 320, "maximum": 15000},
        "curve": [
            "default",
            "quick_in_hold_soft_out",
            "slow_in_hold_quick_out",
            "pulse_then_settle",
            "soft_breathe",
        ],
        "export_eligible": False,
        "reason": "semantic axis catalog has not been calibrated",
    }


@dataclass(frozen=True)
class RecordingResult:
    session_id: int
    take_id: int
    sampling: SamplingResult


class _BatchWriter:
    def __init__(
        self,
        store: RecorderStore,
        *,
        take_id: int,
        take_start_monotonic_ns: int,
    ) -> None:
        self._store = store
        self._take_id = take_id
        self._take_start_monotonic_ns = take_start_monotonic_ns
        self._samples: list[ProbeSample] = []
        self._events: list[SamplingEvent] = []

    def append(self, samples: list[ProbeSample], events: list[SamplingEvent]) -> None:
        self._samples.extend(samples)
        self._events.extend(events)
        if len(self._samples) >= FRAME_BATCH_SIZE or events:
            self.flush()

    def flush(self) -> None:
        self._store.append_capture_batch(
            self._take_id,
            take_start_monotonic_ns=self._take_start_monotonic_ns,
            samples=self._samples,
            events=self._events,
        )
        self._samples.clear()
        self._events.clear()


async def record_parameters(
    client: VTSClient,
    *,
    store: RecorderStore,
    endpoint: str,
    discovery: DiscoveryResult,
    vts_version: str | None,
    hz: float,
    seconds: float,
    operator_label: str | None,
    subscription_warnings: list[str],
) -> RecordingResult:
    session_id = store.create_session(
        endpoint=endpoint,
        requested_hz=hz,
        vts_version=vts_version,
        model_id=discovery.model_id,
        model_name=discovery.model_name,
        target_contract=default_target_contract(),
    )
    take_id: int | None = None
    try:
        store.save_parameter_catalog(session_id, discovery)
        take_start_monotonic_ns = time.monotonic_ns()
        take_id = store.create_take(
            session_id,
            start_monotonic_ns=take_start_monotonic_ns,
            operator_label=operator_label,
        )
        if subscription_warnings:
            store.append_recorder_messages(
                take_id,
                relative_monotonic_ns=0,
                event_type="event_subscription_warning",
                messages=subscription_warnings,
            )
        writer = _BatchWriter(
            store,
            take_id=take_id,
            take_start_monotonic_ns=take_start_monotonic_ns,
        )
        sampling = await sample_parameters(
            client,
            hz=hz,
            seconds=seconds,
            known_model_id=discovery.model_id,
            on_batch=writer.append,
        )
        writer.flush()
        sampling_errors = [str(error) for error in sampling.report["errors"]]
        if sampling_errors:
            store.append_recorder_messages(
                take_id,
                relative_monotonic_ns=int(sampling.report["elapsed_seconds"] * 1_000_000_000),
                event_type="sampling_error",
                messages=sampling_errors,
            )
        if subscription_warnings:
            environment = dict(sampling.report["environment"])
            environment["capture_stable"] = False
            environment["issues"] = sorted(
                {
                    *environment["issues"],
                    "VTube Studio environment event subscriptions were incomplete",
                }
            )
            sampling.report["environment"] = environment
        environment_stable = bool(sampling.report["environment"]["capture_stable"])
        termination_reason = str(sampling.report["termination_reason"])
        capture_usable = bool(sampling.report["capture_complete"]) and environment_stable
        store.finish_take(
            take_id,
            status=_take_status(termination_reason, capture_usable=capture_usable),
            termination_reason=termination_reason,
            environment_stable=environment_stable,
            duration_ms=round(float(sampling.report["elapsed_seconds"]) * 1000),
            sampling_report=sampling.report,
        )
        store.finish_session(
            session_id,
            status=_take_status(termination_reason, capture_usable=capture_usable),
        )
        return RecordingResult(session_id=session_id, take_id=take_id, sampling=sampling)
    except BaseException as exc:
        if take_id is not None:
            try:
                store.fail_take(take_id, message=str(exc) or type(exc).__name__)
            finally:
                store.finish_session(session_id, status="failed")
        else:
            store.finish_session(session_id, status="failed")
        raise


def _take_status(termination_reason: str, *, capture_usable: bool) -> str:
    if termination_reason == "completed" and not capture_usable:
        return "completed_with_issues"
    return {
        "completed": "completed",
        "interrupted": "interrupted",
        "environment_changed": "environment_changed",
    }.get(termination_reason, "failed")
