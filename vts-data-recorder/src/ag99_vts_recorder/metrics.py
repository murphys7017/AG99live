from __future__ import annotations

from dataclasses import dataclass
from statistics import fmean
from typing import Any, Iterable, Mapping


@dataclass(frozen=True)
class ProbeSample:
    source: str
    request_id: str
    scheduled_monotonic_ns: int
    sent_monotonic_ns: int
    received_monotonic_ns: int
    vts_timestamp_ms: int | None
    model_id: str | None
    values: Mapping[str, float]


def build_sampling_report(
    *,
    samples: Iterable[ProbeSample],
    requested_hz: float,
    elapsed_monotonic_ns: int,
    skipped_schedule_slots: int,
    errors: list[str],
    event_counts: Mapping[str, int],
) -> dict[str, Any]:
    grouped: dict[str, list[ProbeSample]] = {
        "tracking_input": [],
        "live2d_parameter": [],
    }
    for sample in samples:
        grouped.setdefault(sample.source, []).append(sample)

    elapsed_seconds = max(elapsed_monotonic_ns, 0) / 1_000_000_000
    return {
        "requested_hz": _round(requested_hz),
        "elapsed_seconds": _round(elapsed_seconds),
        "skipped_schedule_slots": skipped_schedule_slots,
        "error_count": len(errors),
        "errors": errors,
        "events_seen": dict(sorted(event_counts.items())),
        "sources": {
            source: _source_report(
                source_samples,
                elapsed_seconds=elapsed_seconds,
                target_period_ms=1_000 / requested_hz,
            )
            for source, source_samples in grouped.items()
        },
    }


def _source_report(
    samples: list[ProbeSample],
    *,
    elapsed_seconds: float,
    target_period_ms: float,
) -> dict[str, Any]:
    rtts_ms = [
        (sample.received_monotonic_ns - sample.sent_monotonic_ns) / 1_000_000
        for sample in samples
        if sample.received_monotonic_ns >= sample.sent_monotonic_ns
    ]
    received_times = [sample.received_monotonic_ns for sample in samples]
    intervals_ms = [
        (current - previous) / 1_000_000
        for previous, current in zip(received_times, received_times[1:])
        if current >= previous
    ]
    jitter_ms = [abs(interval - target_period_ms) for interval in intervals_ms]
    return {
        "sample_count": len(samples),
        "effective_hz": _round(len(samples) / elapsed_seconds) if elapsed_seconds else 0.0,
        "rtt_ms": _distribution(rtts_ms),
        "response_interval_ms": _distribution(intervals_ms),
        "interval_jitter_ms": _distribution(jitter_ms),
        "parameter_metrics": _parameter_metrics(samples),
    }


def _parameter_metrics(samples: list[ProbeSample]) -> dict[str, dict[str, int | float]]:
    previous: dict[str, float] = {}
    aggregate: dict[str, dict[str, int | float]] = {}
    for sample in samples:
        for name, value in sample.values.items():
            metrics = aggregate.setdefault(
                name,
                {
                    "min": value,
                    "max": value,
                    "change_count": 0,
                },
            )
            metrics["min"] = min(float(metrics["min"]), value)
            metrics["max"] = max(float(metrics["max"]), value)
            if name in previous and previous[name] != value:
                metrics["change_count"] = int(metrics["change_count"]) + 1
            previous[name] = value
    return {
        name: {
            "min": _round(float(metrics["min"])),
            "max": _round(float(metrics["max"])),
            "change_count": int(metrics["change_count"]),
        }
        for name, metrics in sorted(aggregate.items())
    }


def _distribution(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "avg": None, "p50": None, "p95": None, "max": None}
    return {
        "count": len(values),
        "avg": _round(fmean(values)),
        "p50": _round(_percentile(values, 0.50)),
        "p95": _round(_percentile(values, 0.95)),
        "max": _round(max(values)),
    }


def _percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _round(value: float) -> float:
    return round(value, 3)
