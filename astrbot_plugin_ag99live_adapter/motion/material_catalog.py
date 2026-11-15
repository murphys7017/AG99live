from __future__ import annotations

from collections import Counter
from typing import Any


MOTION_MATERIAL_CATALOG_SCHEMA_VERSION = "motion_material_catalog.v1"

_AMBIENT_CHANNELS = frozenset(
    {
        "head_yaw",
        "head_pitch",
        "head_roll",
        "body_yaw",
        "body_pitch",
        "body_roll",
        "gaze_x",
        "gaze_y",
        "breath",
    }
)
_FOREGROUND_CHANNELS = frozenset(
    {
        "mouth_smile",
        "mouth_open",
        "mouth_x",
        "eye_open_left",
        "eye_open_right",
        "eye_smile_left",
        "eye_smile_right",
        "brow_bias",
        "brow_left_detail",
        "brow_right_detail",
    }
)


def build_motion_material_catalog(
    *,
    model_id: str,
    motions: Any,
    parameter_action_library: Any,
    semantic_axis_profile: Any = None,
    source_hash: str = "",
) -> dict[str, Any]:
    """Build the compact, read-only material index used by later composers.

    The scanner already owns the expensive curve analysis. This function only
    normalizes that result into stable fragment and atom records, so it does
    not re-read motion files or retain sampled curves.
    """

    normalized_model_id = str(model_id or "").strip()
    profile = semantic_axis_profile if isinstance(semantic_axis_profile, dict) else {}
    axis_lookup = _build_parameter_axis_lookup(profile)
    profile_id = str(profile.get("profile_id") or "").strip()
    profile_revision = _coerce_non_negative_int(profile.get("revision"))
    normalized_source_hash = str(
        source_hash or profile.get("source_hash") or profile.get("last_scanned_hash") or ""
    ).strip()
    profile_ready = bool(profile_id and profile_revision > 0)

    fragment_records: list[dict[str, Any]] = []
    fragment_ids: set[str] = set()
    for motion in motions if isinstance(motions, list) else []:
        if not isinstance(motion, dict):
            continue
        fragment = _build_fragment(
            motion=motion,
            axis_lookup=axis_lookup,
            profile_ready=profile_ready,
        )
        fragment_id = str(fragment["id"])
        if fragment_id in fragment_ids:
            continue
        fragment_ids.add(fragment_id)
        fragment_records.append(fragment)

    atom_records: list[dict[str, Any]] = []
    atom_ids: set[str] = set()
    raw_atoms = (
        parameter_action_library.get("atoms")
        if isinstance(parameter_action_library, dict)
        else []
    )
    for atom in raw_atoms if isinstance(raw_atoms, list) else []:
        if not isinstance(atom, dict):
            continue
        normalized_atom = _build_atom(
            atom=atom,
            axis_lookup=axis_lookup,
            profile_ready=profile_ready,
            fragment_ids=fragment_ids,
        )
        atom_id = str(normalized_atom["id"])
        if atom_id in atom_ids:
            continue
        atom_ids.add(atom_id)
        atom_records.append(normalized_atom)

    status_counts = Counter(
        [str(item.get("status") or "rejected") for item in fragment_records]
        + [str(item.get("status") or "rejected") for item in atom_records]
    )
    reason_counts = Counter(
        reason
        for item in fragment_records + atom_records
        for reason in item.get("status_reasons", [])
        if str(reason).strip()
    )

    return {
        "schema_version": MOTION_MATERIAL_CATALOG_SCHEMA_VERSION,
        "model_id": normalized_model_id,
        "profile_id": profile_id,
        "profile_revision": profile_revision,
        "source_hash": normalized_source_hash,
        "summary": {
            "fragment_count": len(fragment_records),
            "atom_count": len(atom_records),
            "ambient_fragment_count": sum(
                1 for item in fragment_records if item.get("status") == "ambient_candidate"
            ),
            "ambient_atom_count": sum(
                1 for item in atom_records if item.get("status") == "ambient_candidate"
            ),
            "compatible_fragment_count": sum(
                1
                for item in fragment_records
                if item.get("status") in {"compatible", "ambient_candidate"}
            ),
            "compatible_atom_count": sum(
                1
                for item in atom_records
                if item.get("status") in {"compatible", "ambient_candidate"}
            ),
            "status_counts": _sorted_counter(status_counts),
            "reason_counts": _sorted_counter(reason_counts),
        },
        "fragments": fragment_records,
        "atoms": atom_records,
        "diagnostics": {
            "profile_ready": profile_ready,
            "status_counts": _sorted_counter(status_counts),
            "reason_counts": _sorted_counter(reason_counts),
        },
    }


def _build_fragment(
    *,
    motion: dict[str, Any],
    axis_lookup: dict[str, list[str]],
    profile_ready: bool,
) -> dict[str, Any]:
    source_file = str(motion.get("file") or "").strip().replace("\\", "/")
    source_motion = str(motion.get("name") or "").strip()
    fragment_id = f"motion:{source_file or source_motion}"
    parameter_ids = _text_list(motion.get("parameter_ids"))
    axis_ids = sorted(
        {
            axis_id
            for parameter_id in parameter_ids
            for axis_id in axis_lookup.get(parameter_id, [])
        }
    )
    channels = _text_list(motion.get("affects_channels") or motion.get("dominant_channels"))
    ambient_channels = sorted(set(channels) & _AMBIENT_CHANNELS)
    material_channels = ambient_channels or channels
    domains = _text_list(motion.get("dominant_domains"))
    status, status_reasons = _classify_material(
        channels=material_channels,
        intensity=str(motion.get("catalog_intensity") or "").strip(),
        category=str(motion.get("category") or "").strip(),
        # A registered motion can contain expression, physics, and ambient
        # parameters together. The atom catalog removes the non-ambient
        # parameters later, so keep the ambient part available as a fragment.
        uses_expression=(
            bool(motion.get("uses_expression_parameters"))
            and not ambient_channels
        ),
        uses_physics=(
            bool(motion.get("uses_physics_parameters"))
            and not ambient_channels
        ),
        axis_ids=axis_ids,
        profile_ready=profile_ready,
        duration_ms=_duration_ms(motion.get("duration")),
    )
    timeline_profile = motion.get("timeline_profile")
    trait = (
        str(timeline_profile.get("motion_trait") or "").strip()
        if isinstance(timeline_profile, dict)
        else ""
    )
    return {
        "id": fragment_id,
        "source_motion": source_motion,
        "source_file": source_file,
        "source_group": str(motion.get("group") or "").strip(),
        "source_category": str(motion.get("category") or "").strip(),
        "duration_ms": _duration_ms(motion.get("duration")),
        "channels": material_channels,
        "domains": domains,
        "parameter_ids": parameter_ids,
        "axis_ids": axis_ids,
        "component_ids": _text_list(motion.get("driver_component_ids")),
        "intensity": str(motion.get("catalog_intensity") or "").strip(),
        "trait": trait,
        "tags": _text_list(motion.get("catalog_tags")),
        "recommended_scenarios": _text_list(motion.get("recommended_scenarios")),
        "compatibility_groups": _build_compatibility_groups(
            parameter_ids=parameter_ids,
            axis_ids=axis_ids,
            channels=channels,
        ),
        "status": status,
        "status_reasons": status_reasons,
    }


def _build_atom(
    *,
    atom: dict[str, Any],
    axis_lookup: dict[str, list[str]],
    profile_ready: bool,
    fragment_ids: set[str],
) -> dict[str, Any]:
    parameter_id = str(atom.get("parameter_id") or "").strip()
    source_file = str(atom.get("source_file") or "").strip().replace("\\", "/")
    source_motion = str(atom.get("source_motion") or "").strip()
    source_fragment_id = f"motion:{source_file or source_motion}"
    axis_ids = sorted(axis_lookup.get(parameter_id, []))
    channels = _text_list(atom.get("channels"))
    status, status_reasons = _classify_material(
        channels=channels,
        intensity=str(atom.get("intensity") or "").strip(),
        category=str(atom.get("source_category") or "").strip(),
        uses_expression=str(atom.get("kind") or "").strip() == "expression",
        uses_physics=str(atom.get("kind") or "").strip() == "physics",
        axis_ids=axis_ids,
        profile_ready=profile_ready,
        duration_ms=_duration_ms(atom.get("duration")),
    )
    if source_fragment_id not in fragment_ids:
        status_reasons = [*status_reasons, "source_fragment_missing"]
        status = "suppressed"
    start_ratio = _coerce_ratio(atom.get("window_start_ratio"))
    end_ratio = _coerce_ratio(atom.get("window_end_ratio"))
    if end_ratio < start_ratio:
        start_ratio, end_ratio = end_ratio, start_ratio
    return {
        "id": str(atom.get("id") or "").strip(),
        "name": str(atom.get("name") or "").strip(),
        "label": str(atom.get("label") or "").strip(),
        "parameter_id": parameter_id,
        "parameter_name": str(atom.get("parameter_name") or "").strip(),
        "kind": str(atom.get("kind") or "").strip(),
        "domain": str(atom.get("domain") or "").strip(),
        "axis_ids": axis_ids,
        "channels": channels,
        "primary_channel": str(atom.get("primary_channel") or "").strip(),
        "polarity": str(atom.get("polarity") or "").strip(),
        "semantic_polarity": str(atom.get("semantic_polarity") or "").strip(),
        "trait": str(atom.get("trait") or "").strip(),
        "strength": str(atom.get("strength") or "").strip(),
        "score": _coerce_float(atom.get("score")),
        "duration_ms": _duration_ms(atom.get("duration")),
        "active_window": {
            "start_ratio": start_ratio,
            "end_ratio": end_ratio,
        },
        "source_fragment_id": source_fragment_id,
        "source_component_id": str(atom.get("source_component_id") or "").strip(),
        "source_motion": source_motion,
        "source_file": source_file,
        "source_group": str(atom.get("source_group") or "").strip(),
        "source_category": str(atom.get("source_category") or "").strip(),
        "source_tags": _text_list(atom.get("source_tags")),
        "intensity": str(atom.get("intensity") or "").strip(),
        "curve_ref": {
            "source_file": source_file,
            "source_component_id": str(atom.get("source_component_id") or "").strip(),
            "window_index": _coerce_non_negative_int(atom.get("window_index")),
        },
        "compatibility_groups": _build_compatibility_groups(
            parameter_ids=[parameter_id] if parameter_id else [],
            axis_ids=axis_ids,
            channels=channels,
        ),
        "status": status,
        "status_reasons": _unique_text(status_reasons),
    }


def _classify_material(
    *,
    channels: list[str],
    intensity: str,
    category: str,
    uses_expression: bool,
    uses_physics: bool,
    axis_ids: list[str],
    profile_ready: bool,
    duration_ms: int,
) -> tuple[str, list[str]]:
    reasons: list[str] = []
    if uses_expression:
        return "foreground_only", ["uses_expression_parameters"]
    if uses_physics:
        return "foreground_only", ["uses_physics_parameters"]

    blocked_channels = sorted(set(channels) & _FOREGROUND_CHANNELS)
    if blocked_channels:
        reasons.append("foreground_channel:" + ",".join(blocked_channels))
    if intensity == "high":
        reasons.append("high_intensity")
    if category in {"base_emotion", "emotion_overlay", "special"}:
        reasons.append("foreground_category:" + category)
    if reasons:
        return "foreground_only", reasons
    if not profile_ready:
        return "parseable", ["semantic_profile_unavailable"]
    if not axis_ids:
        return "suppressed", ["no_semantic_axis_binding"]
    if not channels:
        return "suppressed", ["no_known_channels"]
    if set(channels) & _AMBIENT_CHANNELS and 0 < duration_ms <= 8000:
        return "ambient_candidate", []
    return "compatible", []


def _build_parameter_axis_lookup(profile: dict[str, Any]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    axes = profile.get("axes")
    if not isinstance(axes, list):
        return result
    for axis in axes:
        if not isinstance(axis, dict):
            continue
        axis_id = str(axis.get("id") or "").strip()
        bindings = axis.get("parameter_bindings")
        if not axis_id or not isinstance(bindings, list):
            continue
        for binding in bindings:
            if not isinstance(binding, dict):
                continue
            parameter_id = str(binding.get("parameter_id") or "").strip()
            if parameter_id and axis_id not in result.setdefault(parameter_id, []):
                result[parameter_id].append(axis_id)
    return result


def _build_compatibility_groups(
    *,
    parameter_ids: list[str],
    axis_ids: list[str],
    channels: list[str],
) -> list[str]:
    return sorted(
        {
            *(f"parameter:{value}" for value in parameter_ids if value),
            *(f"axis:{value}" for value in axis_ids if value),
            *(f"channel:{value}" for value in channels if value),
        }
    )


def _sorted_counter(counter: Counter[str]) -> list[dict[str, Any]]:
    return [
        {"name": name, "count": count}
        for name, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))
    ]


def _text_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return _unique_text(value)


def _unique_text(values: Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    if not isinstance(values, list):
        values = [values]
    for value in values:
        normalized = str(value or "").strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def _duration_ms(value: Any) -> int:
    return max(round(_coerce_float(value) * 1000), 0)


def _coerce_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _coerce_non_negative_int(value: Any) -> int:
    return max(round(_coerce_float(value)), 0)


def _coerce_ratio(value: Any) -> float:
    return round(max(min(_coerce_float(value), 1.0), 0.0), 4)
