from __future__ import annotations

import asyncio
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Mapping

from .client import VTSClient
from .discovery import live2d_model_identity, live2d_values, tracking_values
from .metrics import ProbeSample, build_sampling_report


EVENT_SUBSCRIPTIONS: tuple[tuple[str, Mapping[str, Any]], ...] = (
    ("ModelLoadedEvent", {"modelID": []}),
    ("ModelConfigChangedEvent", {}),
    ("TrackingStatusChangedEvent", {}),
)

CAPTURE_INVALIDATING_EVENTS = frozenset({"ModelLoadedEvent", "ModelConfigChangedEvent"})


@dataclass(frozen=True)
class SamplingResult:
    samples: list[ProbeSample]
    events: list["SamplingEvent"]
    report: dict[str, Any]


@dataclass(frozen=True)
class SamplingProgress:
    elapsed_seconds: float
    target_seconds: float
    sample_count: int
    error_count: int
    skipped_schedule_slots: int


@dataclass(frozen=True)
class SamplingEvent:
    relative_monotonic_ns: int
    message_type: str
    vts_timestamp_ms: int | None
    raw: Mapping[str, Any]


async def subscribe_environment_events(client: VTSClient) -> list[str]:
    warnings: list[str] = []
    for event_name, config in EVENT_SUBSCRIPTIONS:
        try:
            await client.request(
                "EventSubscriptionRequest",
                {
                    "eventName": event_name,
                    "subscribe": True,
                    "config": dict(config),
                },
            )
        except Exception as exc:
            warnings.append(f"Event subscription failed for {event_name}: {exc}")
    return warnings


async def sample_parameters(
    client: VTSClient,
    *,
    hz: float,
    seconds: float,
    known_model_id: str | None,
    on_progress: Callable[[SamplingProgress], None] | None = None,
    on_batch: Callable[[list[ProbeSample], list[SamplingEvent]], None] | None = None,
) -> SamplingResult:
    if hz <= 0 or hz > 30:
        raise ValueError("hz must be greater than 0 and no greater than 30 for this probe")
    if seconds <= 0:
        raise ValueError("seconds must be greater than 0")

    period_ns = int(1_000_000_000 / hz)
    start_ns = time.monotonic_ns()
    deadline_ns = start_ns + int(seconds * 1_000_000_000)
    scheduled_ns = start_ns
    skipped_schedule_slots = 0
    samples: list[ProbeSample] = []
    events: list[SamplingEvent] = []
    errors: list[str] = []
    event_counts: Counter[str] = Counter()
    environment_issues: set[str] = set()
    next_progress_report_ns = start_ns
    interrupted = False
    client.drain_events()

    try:
        while scheduled_ns < deadline_ns:
            now_ns = time.monotonic_ns()
            if now_ns < scheduled_ns:
                await asyncio.sleep((scheduled_ns - now_ns) / 1_000_000_000)

            round_samples: list[ProbeSample] = []
            await asyncio.gather(
                _sample_source(
                    client=client,
                    source="tracking_input",
                    request_type="InputParameterListRequest",
                    scheduled_ns=scheduled_ns,
                    fallback_model_id=known_model_id,
                    samples=round_samples,
                    errors=errors,
                    environment_issues=environment_issues,
                ),
                _sample_source(
                    client=client,
                    source="live2d_parameter",
                    request_type="Live2DParameterListRequest",
                    scheduled_ns=scheduled_ns,
                    fallback_model_id=known_model_id,
                    samples=round_samples,
                    errors=errors,
                    environment_issues=environment_issues,
                )
            )
            samples.extend(round_samples)
            round_events = _record_environment_events(
                client.drain_events(),
                start_monotonic_ns=start_ns,
                event_counts=event_counts,
                environment_issues=environment_issues,
            )
            events.extend(round_events)
            if on_batch is not None and (round_samples or round_events):
                on_batch(round_samples, round_events)
            if environment_issues:
                break

            scheduled_ns += period_ns
            now_ns = time.monotonic_ns()
            if now_ns - scheduled_ns >= period_ns:
                missed_slots = (now_ns - scheduled_ns) // period_ns
                skipped_schedule_slots += missed_slots
                scheduled_ns += missed_slots * period_ns

            now_ns = time.monotonic_ns()
            if on_progress is not None and now_ns >= next_progress_report_ns:
                on_progress(
                    SamplingProgress(
                        elapsed_seconds=(now_ns - start_ns) / 1_000_000_000,
                        target_seconds=seconds,
                        sample_count=len(samples),
                        error_count=len(errors),
                        skipped_schedule_slots=skipped_schedule_slots,
                    )
                )
                next_progress_report_ns = now_ns + 1_000_000_000
    except asyncio.CancelledError:
        interrupted = True

    elapsed_ns = time.monotonic_ns() - start_ns
    final_events = _record_environment_events(
        client.drain_events(),
        start_monotonic_ns=start_ns,
        event_counts=event_counts,
        environment_issues=environment_issues,
    )
    events.extend(final_events)
    if on_batch is not None and final_events:
        on_batch([], final_events)
    report = build_sampling_report(
        samples=samples,
        requested_hz=hz,
        elapsed_monotonic_ns=elapsed_ns,
        skipped_schedule_slots=skipped_schedule_slots,
        errors=errors,
        event_counts=event_counts,
    )
    report["capture_complete"] = not errors
    report["environment"] = {
        "expected_model_id": known_model_id,
        "observed_model_ids": sorted(
            {sample.model_id for sample in samples if sample.model_id is not None}
        ),
        "capture_stable": not environment_issues,
        "issues": sorted(environment_issues),
        "tracking_status_changed": event_counts["TrackingStatusChangedEvent"] > 0,
    }
    report["termination_reason"] = (
        "interrupted"
        if interrupted
        else "environment_changed"
        if environment_issues
        else "completed"
    )
    return SamplingResult(samples=samples, events=events, report=report)


async def _sample_source(
    *,
    client: VTSClient,
    source: str,
    request_type: str,
    scheduled_ns: int,
    fallback_model_id: str | None,
    samples: list[ProbeSample],
    errors: list[str],
    environment_issues: set[str],
) -> None:
    try:
        response = await client.request(request_type)
    except Exception as exc:
        errors.append(f"{source}: {exc}")
        return

    if source == "tracking_input":
        values = tracking_values(response.data)
        model_id = fallback_model_id
    else:
        if not bool(response.data.get("modelLoaded")):
            environment_issues.add("Live2D model was unloaded during sampling")
            return
        values = live2d_values(response.data)
        reported_model_id, _ = live2d_model_identity(response.data)
        if fallback_model_id is not None and reported_model_id != fallback_model_id:
            environment_issues.add(
                f"Live2D model changed from `{fallback_model_id}` to `{reported_model_id or '<unknown>'}`"
            )
            return
        model_id = reported_model_id or fallback_model_id
    samples.append(
        ProbeSample(
            source=source,
            request_id=response.request_id,
            scheduled_monotonic_ns=scheduled_ns,
            sent_monotonic_ns=response.sent_monotonic_ns,
            received_monotonic_ns=response.received_monotonic_ns,
            vts_timestamp_ms=response.vts_timestamp_ms,
            model_id=model_id,
            values=values,
        )
    )


def _record_environment_events(
    events: list[Any],
    *,
    start_monotonic_ns: int,
    event_counts: Counter[str],
    environment_issues: set[str],
) -> list[SamplingEvent]:
    records: list[SamplingEvent] = []
    drained_monotonic_ns = time.monotonic_ns()
    for event in events:
        event_counts[event.message_type] += 1
        records.append(
            SamplingEvent(
                relative_monotonic_ns=max(drained_monotonic_ns - start_monotonic_ns, 0),
                message_type=event.message_type,
                vts_timestamp_ms=event.timestamp_ms,
                raw=event.raw,
            )
        )
        if event.message_type in CAPTURE_INVALIDATING_EVENTS:
            environment_issues.add(
                f"VTube Studio emitted {event.message_type} during sampling"
            )
    return records
