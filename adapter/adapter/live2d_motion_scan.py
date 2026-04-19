from __future__ import annotations

from collections import Counter, defaultdict
from statistics import fmean
from typing import Any


SEGMENT_LABELS = {
    0: "linear",
    1: "bezier",
    2: "stepped",
    3: "inverse_stepped",
}


def decompose_motion(
    *,
    motion_name: str,
    motion_file: str,
    motion_group: str,
    motion_category: str,
    motion_payload: dict[str, Any],
    parameter_lookup: dict[str, dict[str, Any]],
    catalog_entry: dict[str, Any],
) -> dict[str, Any]:
    meta = motion_payload.get("Meta", {})
    duration = _coerce_float(meta.get("Duration"))
    fps = _coerce_float(meta.get("Fps")) or 30.0
    loop = bool(meta.get("Loop", False))

    components: list[dict[str, Any]] = []
    channel_energy: Counter[str] = Counter()
    domain_energy: Counter[str] = Counter()
    kind_counts: Counter[str] = Counter()
    segment_type_counts: Counter[str] = Counter()
    motion_windows: list[dict[str, float]] = []

    for curve_index, curve in enumerate(motion_payload.get("Curves", [])):
        if not isinstance(curve, dict) or curve.get("Target") != "Parameter":
            continue

        parameter_id = str(curve.get("Id") or "").strip()
        if not parameter_id:
            continue

        parameter_entry = parameter_lookup.get(parameter_id, {})
        if parameter_entry.get("kind") == "marker":
            continue

        curve_segments = _parse_curve_segments(curve.get("Segments", []))
        if not curve_segments:
            continue

        component = _build_motion_component(
            motion_name=motion_name,
            motion_file=motion_file,
            motion_group=motion_group,
            motion_category=motion_category,
            duration=duration,
            fps=fps,
            loop=loop,
            curve_index=curve_index,
            parameter_id=parameter_id,
            parameter_entry=parameter_entry,
            curve_segments=curve_segments,
        )
        if component is None:
            continue

        components.append(component)
        kind_counts[component["kind"]] += 1
        for item in component["segment_types"]:
            segment_type_counts[item] += 1
        for item in component["channels"]:
            channel_energy[item] += max(component["energy_score"], 0.001)
        domain_energy[component["domain"]] += max(component["energy_score"], 0.001)
        motion_windows.extend(component["windows"])

    dominant_channels = _rank_counter(channel_energy)
    dominant_domains = _rank_counter(domain_energy)
    overall_windows = _merge_ratio_windows(motion_windows)
    timeline_profile = _build_timeline_profile(components)
    driver_components = [item for item in components if item.get("engine_role") == "driver"]

    return {
        "decomposition_level": "parameter_track",
        "component_count": len(components),
        "component_ids": [item["id"] for item in components],
        "driver_component_count": len(driver_components),
        "driver_component_ids": [item["id"] for item in driver_components],
        "components": components,
        "dominant_channels": [item["name"] for item in dominant_channels],
        "dominant_domains": [item["name"] for item in dominant_domains],
        "channel_weights": dominant_channels,
        "domain_weights": dominant_domains,
        "kind_counts": _rank_counter(kind_counts),
        "segment_types": _rank_counter(segment_type_counts),
        "timeline_profile": timeline_profile,
        "motion_windows": overall_windows,
        "loop": loop,
        "fps": round(fps, 3),
        "catalog_tags": [
            str(tag).strip()
            for tag in catalog_entry.get("tags", [])
            if str(tag).strip()
        ],
    }


def build_motion_resource_pool(
    *,
    motions: list[dict[str, Any]],
) -> dict[str, Any]:
    components = [
        component
        for motion in motions
        for component in motion.get("components", [])
        if isinstance(component, dict)
    ]

    channel_pool: dict[str, list[dict[str, Any]]] = defaultdict(list)
    domain_pool: dict[str, list[dict[str, Any]]] = defaultdict(list)
    parameter_pool: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for component in components:
        compact = {
            "id": component["id"],
            "source_motion": component["source_motion"],
            "source_file": component["source_file"],
            "strength": component["strength"],
            "trait": component["trait"],
            "energy_score": component["energy_score"],
            "peak_time_ratio": component["peak_time_ratio"],
        }
        for channel_name in component.get("channels", []):
            channel_pool[channel_name].append(compact)
        domain_pool[component.get("domain") or "other"].append(compact)
        parameter_pool[component.get("parameter_id") or ""].append(compact)

    return {
        "decomposition_level": "parameter_track",
        "summary": {
            "motion_count": len(motions),
            "component_count": len(components),
            "driver_component_count": len(
                [item for item in components if item.get("engine_role") == "driver"]
            ),
            "overlay_component_count": len(
                [item for item in components if item.get("engine_role") == "overlay"]
            ),
            "channel_pool_count": len(channel_pool),
            "domain_pool_count": len(domain_pool),
            "parameter_pool_count": len([key for key in parameter_pool if key]),
        },
        "components": components,
        "driver_components": [
            component for component in components if component.get("engine_role") == "driver"
        ],
        "channel_pool": [
            _build_pool_entry("channel", channel_name, entries)
            for channel_name, entries in sorted(channel_pool.items())
        ],
        "domain_pool": [
            _build_pool_entry("domain", domain_name, entries)
            for domain_name, entries in sorted(domain_pool.items())
        ],
        "parameter_pool": [
            _build_pool_entry("parameter", parameter_id, entries)
            for parameter_id, entries in sorted(parameter_pool.items())
            if parameter_id
        ],
        "motion_presets": [
            {
                "motion_name": motion["name"],
                "motion_file": motion["file"],
                "category": motion["category"],
                "group": motion["group"],
                "component_ids": motion.get("component_ids", []),
                "dominant_channels": motion.get("dominant_channels", []),
                "dominant_domains": motion.get("dominant_domains", []),
                "intensity": motion.get("catalog_intensity", ""),
                "timeline_profile": motion.get("timeline_profile", {}),
                "catalog_tags": motion.get("catalog_tags", []),
            }
            for motion in motions
        ],
    }


def _build_pool_entry(pool_type: str, pool_name: str, entries: list[dict[str, Any]]) -> dict[str, Any]:
    trait_counter: Counter[str] = Counter()
    motion_counter: Counter[str] = Counter()
    strength_counter: Counter[str] = Counter()
    for entry in entries:
        trait_counter[str(entry.get("trait") or "unknown")] += 1
        motion_counter[str(entry.get("source_motion") or "unknown")] += 1
        strength_counter[str(entry.get("strength") or "none")] += 1
    sorted_entries = sorted(
        entries,
        key=lambda item: (-float(item.get("energy_score") or 0.0), item.get("id", "")),
    )
    return {
        "pool_type": pool_type,
        "name": pool_name,
        "component_count": len(entries),
        "strength_counts": _rank_counter(strength_counter),
        "trait_counts": _rank_counter(trait_counter),
        "source_motions": [item["name"] for item in _rank_counter(motion_counter)],
        "component_ids": [item["id"] for item in sorted_entries],
    }


def _build_motion_component(
    *,
    motion_name: str,
    motion_file: str,
    motion_group: str,
    motion_category: str,
    duration: float,
    fps: float,
    loop: bool,
    curve_index: int,
    parameter_id: str,
    parameter_entry: dict[str, Any],
    curve_segments: list[dict[str, Any]],
) -> dict[str, Any] | None:
    times, values = _sample_curve(curve_segments, duration=duration, fps=fps)
    if not times or not values:
        return None

    baseline = _estimate_baseline(values)
    deltas = [value - baseline for value in values]
    abs_deltas = [abs(value) for value in deltas]

    peak_abs = max(abs_deltas, default=0.0)
    span = max(values, default=0.0) - min(values, default=0.0)
    active_threshold = max(span * 0.12, peak_abs * 0.18, 0.03)
    peak_index = abs_deltas.index(peak_abs) if abs_deltas else 0
    active_flags = [delta >= active_threshold for delta in abs_deltas]
    active_ratio = round(sum(1 for item in active_flags if item) / max(len(active_flags), 1), 4)

    segment_types = sorted(
        {segment["type_label"] for segment in curve_segments if segment.get("type_label")}
    )
    windows = _extract_active_windows(
        times=times,
        active_flags=active_flags,
        duration=duration,
    )
    trait = _classify_component_trait(
        deltas=deltas,
        active_ratio=active_ratio,
        peak_index=peak_index,
        segment_types=segment_types,
    )

    energy_score = round((peak_abs * 0.7) + (active_ratio * 0.3), 4)
    return {
        "id": f"{motion_file}#{parameter_id}",
        "source_motion": motion_name,
        "source_file": motion_file,
        "source_group": motion_group,
        "source_category": motion_category,
        "curve_index": curve_index,
        "parameter_id": parameter_id,
        "parameter_name": str(parameter_entry.get("name") or "").strip(),
        "kind": str(parameter_entry.get("kind") or "unknown"),
        "domain": str(parameter_entry.get("domain") or "other"),
        "engine_role": _infer_engine_role(parameter_entry),
        "channels": list(parameter_entry.get("channels", [])),
        "group_name": str(parameter_entry.get("group_name") or "").strip(),
        "duration": round(duration, 4),
        "fps": round(fps, 3),
        "loop": loop,
        "strength": _classify_strength(peak_abs),
        "trait": trait,
        "segment_types": segment_types,
        "sample_count": len(values),
        "value_profile": {
            "start": round(values[0], 4),
            "end": round(values[-1], 4),
            "min": round(min(values), 4),
            "max": round(max(values), 4),
            "baseline": round(baseline, 4),
            "span": round(span, 4),
        },
        "peak_abs_value": round(peak_abs, 4),
        "peak_time_ratio": round(times[peak_index] / duration, 4) if duration > 0 else 0.0,
        "active_ratio": active_ratio,
        "energy_score": energy_score,
        "windows": windows,
    }


def _parse_curve_segments(raw_segments: list[Any]) -> list[dict[str, Any]]:
    if not isinstance(raw_segments, list) or len(raw_segments) < 5:
        return []

    start_time = _coerce_float(raw_segments[0])
    start_value = _coerce_float(raw_segments[1])
    current_point = (start_time, start_value)
    index = 2
    segments: list[dict[str, Any]] = []

    while index < len(raw_segments):
        segment_type = int(_coerce_float(raw_segments[index]))
        if segment_type == 0 and index + 2 < len(raw_segments):
            end_point = (
                _coerce_float(raw_segments[index + 1]),
                _coerce_float(raw_segments[index + 2]),
            )
            segments.append(
                {
                    "type": 0,
                    "type_label": SEGMENT_LABELS[0],
                    "start": current_point,
                    "end": end_point,
                }
            )
            current_point = end_point
            index += 3
            continue
        if segment_type == 1 and index + 6 < len(raw_segments):
            control_1 = (
                _coerce_float(raw_segments[index + 1]),
                _coerce_float(raw_segments[index + 2]),
            )
            control_2 = (
                _coerce_float(raw_segments[index + 3]),
                _coerce_float(raw_segments[index + 4]),
            )
            end_point = (
                _coerce_float(raw_segments[index + 5]),
                _coerce_float(raw_segments[index + 6]),
            )
            segments.append(
                {
                    "type": 1,
                    "type_label": SEGMENT_LABELS[1],
                    "start": current_point,
                    "control_1": control_1,
                    "control_2": control_2,
                    "end": end_point,
                }
            )
            current_point = end_point
            index += 7
            continue
        if segment_type in {2, 3} and index + 2 < len(raw_segments):
            end_point = (
                _coerce_float(raw_segments[index + 1]),
                _coerce_float(raw_segments[index + 2]),
            )
            segments.append(
                {
                    "type": segment_type,
                    "type_label": SEGMENT_LABELS[segment_type],
                    "start": current_point,
                    "end": end_point,
                }
            )
            current_point = end_point
            index += 3
            continue
        break

    return segments


def _sample_curve(
    segments: list[dict[str, Any]],
    *,
    duration: float,
    fps: float,
) -> tuple[list[float], list[float]]:
    if not segments:
        return [], []

    if duration <= 0:
        duration = float(segments[-1]["end"][0] or 0.0)
    if duration <= 0:
        duration = max(
            float(segments[-1]["end"][0] or 0.0),
            float(segments[0]["start"][0] or 0.0),
            1.0,
        )

    sample_count = max(12, min(int(duration * min(max(fps, 1.0), 24.0)) + 1, 96))
    if sample_count <= 1:
        sample_count = 12
    times = [duration * index / (sample_count - 1) for index in range(sample_count)]
    values = [_evaluate_curve_at_time(segments, time_point) for time_point in times]
    return times, values


def _evaluate_curve_at_time(segments: list[dict[str, Any]], time_point: float) -> float:
    if time_point <= segments[0]["start"][0]:
        return float(segments[0]["start"][1])

    for segment in segments:
        start_t, start_v = segment["start"]
        end_t, end_v = segment["end"]
        if time_point > end_t:
            continue
        if end_t <= start_t:
            return float(end_v)

        if segment["type"] == 0:
            ratio = (time_point - start_t) / (end_t - start_t)
            return _lerp(start_v, end_v, ratio)
        if segment["type"] == 1:
            return _evaluate_bezier_segment(segment, time_point)
        if segment["type"] == 2:
            return float(start_v)
        if segment["type"] == 3:
            return float(end_v)
        return float(end_v)

    return float(segments[-1]["end"][1])


def _evaluate_bezier_segment(segment: dict[str, Any], time_point: float) -> float:
    p0 = segment["start"]
    p1 = segment["control_1"]
    p2 = segment["control_2"]
    p3 = segment["end"]
    start_t = float(p0[0])
    end_t = float(p3[0])

    if end_t <= start_t:
        return float(p3[1])

    target_t = min(max(time_point, start_t), end_t)
    low = 0.0
    high = 1.0
    for _ in range(14):
        mid = (low + high) / 2
        mid_t = _cubic_bezier(p0[0], p1[0], p2[0], p3[0], mid)
        if mid_t < target_t:
            low = mid
        else:
            high = mid
    ratio = (low + high) / 2
    return float(_cubic_bezier(p0[1], p1[1], p2[1], p3[1], ratio))


def _extract_active_windows(
    *,
    times: list[float],
    active_flags: list[bool],
    duration: float,
) -> list[dict[str, float]]:
    if not times or not active_flags or duration <= 0:
        return []

    windows: list[dict[str, float]] = []
    start_index: int | None = None
    for index, is_active in enumerate(active_flags):
        if is_active and start_index is None:
            start_index = index
            continue
        if not is_active and start_index is not None:
            end_index = max(index - 1, start_index)
            windows.append(
                _window_to_ratio_payload(
                    times[start_index],
                    times[end_index],
                    duration,
                )
            )
            start_index = None

    if start_index is not None:
        windows.append(
            _window_to_ratio_payload(
                times[start_index],
                times[-1],
                duration,
            )
        )
    return _merge_ratio_windows(windows)


def _build_timeline_profile(components: list[dict[str, Any]]) -> dict[str, Any]:
    if not components:
        return {
            "intro_energy": 0.0,
            "middle_energy": 0.0,
            "outro_energy": 0.0,
            "peak_window": {"start_ratio": 0.0, "end_ratio": 0.0},
            "motion_trait": "static",
        }

    intro_energy = 0.0
    middle_energy = 0.0
    outro_energy = 0.0
    peak_energy = 0.0
    peak_window = {"start_ratio": 0.0, "end_ratio": 0.0}

    for component in components:
        energy = float(component.get("energy_score") or 0.0)
        for window in component.get("windows", []):
            center = (float(window.get("start_ratio") or 0.0) + float(window.get("end_ratio") or 0.0)) / 2
            if center < 0.33:
                intro_energy += energy
            elif center < 0.66:
                middle_energy += energy
            else:
                outro_energy += energy

            width = max(float(window.get("end_ratio") or 0.0) - float(window.get("start_ratio") or 0.0), 0.01)
            window_energy = energy * width
            if window_energy >= peak_energy:
                peak_energy = window_energy
                peak_window = {
                    "start_ratio": round(float(window.get("start_ratio") or 0.0), 4),
                    "end_ratio": round(float(window.get("end_ratio") or 0.0), 4),
                }

    motion_trait = "balanced"
    if intro_energy > middle_energy and intro_energy > outro_energy:
        motion_trait = "front_loaded"
    elif outro_energy > intro_energy and outro_energy > middle_energy:
        motion_trait = "back_loaded"
    elif middle_energy > intro_energy and middle_energy > outro_energy:
        motion_trait = "centered"

    return {
        "intro_energy": round(intro_energy, 4),
        "middle_energy": round(middle_energy, 4),
        "outro_energy": round(outro_energy, 4),
        "peak_window": peak_window,
        "motion_trait": motion_trait,
    }


def _classify_component_trait(
    *,
    deltas: list[float],
    active_ratio: float,
    peak_index: int,
    segment_types: list[str],
) -> str:
    if "stepped" in segment_types or "inverse_stepped" in segment_types:
        return "hold"

    sign_changes = 0
    previous_sign = 0
    for value in deltas:
        sign = 1 if value > 0 else -1 if value < 0 else 0
        if sign != 0 and previous_sign != 0 and sign != previous_sign:
            sign_changes += 1
        if sign != 0:
            previous_sign = sign

    if sign_changes >= 3 and active_ratio >= 0.22:
        return "oscillate"
    if active_ratio >= 0.62:
        return "sustain"
    if peak_index <= max(2, int(len(deltas) * 0.2)) or peak_index >= int(len(deltas) * 0.8):
        return "ramp"
    return "pulse"


def _merge_ratio_windows(windows: list[dict[str, float]]) -> list[dict[str, float]]:
    normalized = sorted(
        (
            {
                "start_ratio": max(min(float(item.get("start_ratio") or 0.0), 1.0), 0.0),
                "end_ratio": max(min(float(item.get("end_ratio") or 0.0), 1.0), 0.0),
            }
            for item in windows
        ),
        key=lambda item: (item["start_ratio"], item["end_ratio"]),
    )
    merged: list[dict[str, float]] = []
    for item in normalized:
        if not merged:
            merged.append(item)
            continue
        previous = merged[-1]
        if item["start_ratio"] <= previous["end_ratio"] + 0.02:
            previous["end_ratio"] = max(previous["end_ratio"], item["end_ratio"])
        else:
            merged.append(item)
    for item in merged:
        item["start_ratio"] = round(item["start_ratio"], 4)
        item["end_ratio"] = round(item["end_ratio"], 4)
    return merged


def _window_to_ratio_payload(start_time: float, end_time: float, duration: float) -> dict[str, float]:
    if duration <= 0:
        return {"start_ratio": 0.0, "end_ratio": 0.0}
    return {
        "start_ratio": round(max(min(start_time / duration, 1.0), 0.0), 4),
        "end_ratio": round(max(min(end_time / duration, 1.0), 0.0), 4),
    }


def _estimate_baseline(values: list[float]) -> float:
    if not values:
        return 0.0
    if len(values) <= 3:
        return float(fmean(values))
    return float(fmean(values[:3]))


def _classify_strength(value: float) -> str:
    if value >= 0.85:
        return "high"
    if value >= 0.35:
        return "medium"
    if value > 0:
        return "low"
    return "none"


def _infer_engine_role(parameter_entry: dict[str, Any]) -> str:
    kind = str(parameter_entry.get("kind") or "unknown")
    domain = str(parameter_entry.get("domain") or "other")
    if kind == "expression":
        return "overlay"
    if kind == "physics":
        return "secondary"
    if domain in {"marker", "other"}:
        return "secondary"
    return "driver"


def _rank_counter(counter: Counter[str]) -> list[dict[str, Any]]:
    return [
        {"name": name, "count": round(count, 4) if isinstance(count, float) else count}
        for name, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))
    ]


def _coerce_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _lerp(start: float, end: float, ratio: float) -> float:
    ratio = max(min(ratio, 1.0), 0.0)
    return float(start + (end - start) * ratio)


def _cubic_bezier(p0: float, p1: float, p2: float, p3: float, ratio: float) -> float:
    inv = 1.0 - ratio
    return (
        (inv**3) * p0
        + 3 * (inv**2) * ratio * p1
        + 3 * inv * (ratio**2) * p2
        + (ratio**3) * p3
    )
