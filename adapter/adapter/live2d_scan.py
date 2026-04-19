from __future__ import annotations

import json
import logging
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

try:
    from astrbot.api import logger
except Exception:  # pragma: no cover - fallback for local dry runs outside AstrBot.
    logger = logging.getLogger(__name__)

from .live2d_motion_scan import build_motion_resource_pool, decompose_motion

SCAN_SCHEMA_VERSION = "live2d_scan.v1"

STANDARD_CHANNEL_SPECS: tuple[dict[str, Any], ...] = (
    {
        "name": "head_yaw",
        "label": "Head Yaw",
        "exact_ids": ("ParamAngleX",),
        "tokens": ("anglex", "headx"),
    },
    {
        "name": "head_pitch",
        "label": "Head Pitch",
        "exact_ids": ("ParamAngleY",),
        "tokens": ("angley", "heady"),
    },
    {
        "name": "head_roll",
        "label": "Head Roll",
        "exact_ids": ("ParamAngleZ",),
        "tokens": ("anglez", "headz"),
    },
    {
        "name": "body_yaw",
        "label": "Body Yaw",
        "exact_ids": ("ParamBodyAngleX",),
        "tokens": ("bodyanglex", "bodyx"),
    },
    {
        "name": "body_roll",
        "label": "Body Roll",
        "exact_ids": ("ParamBodyAngleZ",),
        "tokens": ("bodyanglez", "bodyz"),
    },
    {
        "name": "gaze_x",
        "label": "Gaze X",
        "exact_ids": ("ParamEyeBallX",),
        "tokens": ("eyeballx", "eyex"),
    },
    {
        "name": "gaze_y",
        "label": "Gaze Y",
        "exact_ids": ("ParamEyeBallY",),
        "tokens": ("eyebally", "eyey"),
    },
    {
        "name": "eye_open_left",
        "label": "Eye Open Left",
        "exact_ids": ("ParamEyeLOpen",),
        "tokens": ("eyelopenl",),
    },
    {
        "name": "eye_open_right",
        "label": "Eye Open Right",
        "exact_ids": ("ParamEyeROpen",),
        "tokens": ("eyelopenr",),
    },
    {
        "name": "eye_smile_left",
        "label": "Eye Smile Left",
        "exact_ids": ("ParamEyeLSmile",),
        "tokens": ("eyesmilel",),
    },
    {
        "name": "eye_smile_right",
        "label": "Eye Smile Right",
        "exact_ids": ("ParamEyeRSmile",),
        "tokens": ("eyesmiler",),
    },
    {
        "name": "brow_bias",
        "label": "Brow Bias",
        "exact_ids": ("ParamBrowForm",),
        "tokens": ("browform", "brow"),
    },
    {
        "name": "mouth_smile",
        "label": "Mouth Smile",
        "exact_ids": ("ParamMouthForm",),
        "tokens": ("mouthform", "mouthsmile"),
    },
    {
        "name": "mouth_open",
        "label": "Mouth Open",
        "exact_ids": ("ParamMouthOpenY", "ParamJawOpen"),
        "tokens": ("mouthopen", "jawopen"),
    },
    {
        "name": "mouth_x",
        "label": "Mouth X",
        "exact_ids": ("ParamMouthX",),
        "tokens": ("mouthx",),
    },
    {
        "name": "breath",
        "label": "Breath",
        "exact_ids": ("ParamBreath",),
        "tokens": ("breath",),
    },
)

BASE_EXPRESSION_NAMES = {
    "neutral",
    "happy",
    "angry",
    "surprised",
    "question",
    "confused",
    "embarrassed",
    "blush",
    "tired",
    "extremelytired",
    "messy",
    "murderous",
}

SPECIAL_EXPRESSION_KEYWORDS = {
    "controller",
    "tracking",
    "tablet",
    "pen",
    "outfit",
    "jaketoff",
    "mouseclick",
    "loading",
    "eyemask",
}


def scan_live2d_models(
    *,
    live2ds_dir: Path,
    base_url: str,
    selected_model_name: str = "",
) -> dict[str, Any]:
    models: list[dict[str, Any]] = []

    if not live2ds_dir.exists():
        return {
            "schema_version": SCAN_SCHEMA_VERSION,
            "driver_priority": ["parameters", "expression", "motion"],
            "selected_model": "",
            "available_models": [],
            "models": [],
        }

    for candidate in sorted(entry for entry in live2ds_dir.iterdir() if entry.is_dir()):
        try:
            model_summary = _scan_single_model(candidate, base_url=base_url)
        except Exception as exc:
            logger.warning("Failed to scan Live2D model directory `%s`: %s", candidate, exc)
            continue
        if model_summary:
            models.append(model_summary)

    selected = _pick_selected_model(models, selected_model_name)
    return {
        "schema_version": SCAN_SCHEMA_VERSION,
        "driver_priority": ["parameters", "expression", "motion"],
        "selected_model": selected,
        "available_models": [item["name"] for item in models],
        "models": models,
    }


def _scan_single_model(model_dir: Path, *, base_url: str) -> dict[str, Any] | None:
    model3_path = _find_first(model_dir, "*.model3.json")
    if model3_path is None:
        return None

    model_payload = _load_json_file(model3_path)
    cdi_path = _resolve_optional_path(
        model_dir,
        model3_path.with_suffix("").with_suffix(".cdi3.json"),
        "*.cdi3.json",
    )
    cdi_payload = _load_json_file(cdi_path) if cdi_path is not None else {}
    motion_catalog = _load_motion_catalog(model_dir / "motion_catalog.json")
    resource_scan = _scan_model_resources(
        model_dir=model_dir,
        model3_path=model3_path,
        cdi_path=cdi_path,
        model_payload=model_payload,
        motion_catalog=motion_catalog,
    )

    parameter_scan = _build_parameter_scan(cdi_payload)
    parameter_lookup = {
        item["id"]: item for item in parameter_scan["parameters"] if item.get("id")
    }

    expressions = _scan_expressions(
        model_dir=model_dir,
        model_payload=model_payload,
        parameter_lookup=parameter_lookup,
    )
    expression_scan = _apply_expression_hints_to_parameters(
        parameter_scan=parameter_scan,
        expressions=expressions,
    )
    motions = _scan_motions(
        model_dir=model_dir,
        model_payload=model_payload,
        parameter_lookup=parameter_lookup,
        motion_catalog=motion_catalog,
    )
    motion_resource_pool = build_motion_resource_pool(motions=motions)
    for motion in motions:
        motion.pop("components", None)

    selected_icon = _select_icon(model_dir)
    return {
        "name": model_dir.name,
        "root_path": f"/live2ds/{model_dir.name}",
        "model_path": _relative_to(model_dir, model3_path),
        "model_url": _to_static_url(base_url, model_dir, model3_path),
        "icon_url": _to_static_url(base_url, model_dir, selected_icon) if selected_icon else "",
        "resource_scan": resource_scan,
        "parameter_scan": parameter_scan,
        "expression_scan": expression_scan,
        "motion_resource_pool": motion_resource_pool,
        "constraints": {
            "expressions": expressions,
            "motions": motions,
        },
        "engine_hints": _build_engine_hints(
            parameter_scan=parameter_scan,
            expressions=expressions,
            motions=motions,
        ),
    }


def _scan_model_resources(
    *,
    model_dir: Path,
    model3_path: Path,
    cdi_path: Path | None,
    model_payload: dict[str, Any],
    motion_catalog: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    file_references = model_payload.get("FileReferences", {})
    texture_files = [
        str(item).replace("\\", "/")
        for item in file_references.get("Textures", [])
        if str(item).strip()
    ]
    expression_files = sorted(
        {
            str(item.get("File") or "").strip().replace("\\", "/")
            for item in file_references.get("Expressions", [])
            if isinstance(item, dict) and str(item.get("File") or "").strip()
        }
    )
    motion_groups: dict[str, int] = {}
    motion_files: list[str] = []
    for group_name, items in file_references.get("Motions", {}).items():
        if not isinstance(items, list):
            continue
        files = [
            str(item.get("File") or "").strip().replace("\\", "/")
            for item in items
            if isinstance(item, dict) and str(item.get("File") or "").strip()
        ]
        motion_groups[str(group_name or "").strip() or "default"] = len(files)
        motion_files.extend(files)

    vtube_profiles = sorted(path.name for path in model_dir.glob("*.vtube.json"))
    physics_path = _resolve_optional_path(
        model_dir,
        model3_path.with_suffix("").with_suffix(".physics3.json"),
        "*.physics3.json",
    )
    return {
        "model3_file": _relative_to(model_dir, model3_path),
        "cdi3_file": _relative_to(model_dir, cdi_path) if cdi_path else "",
        "physics3_file": _relative_to(model_dir, physics_path) if physics_path else "",
        "texture_count": len(texture_files),
        "texture_files": texture_files,
        "expression_count": len(expression_files),
        "expression_files": expression_files,
        "motion_count": len(sorted(set(motion_files))),
        "motion_files": sorted(set(motion_files)),
        "motion_groups": [
            {"name": name, "count": count}
            for name, count in sorted(motion_groups.items(), key=lambda pair: (-pair[1], pair[0]))
        ],
        "vtube_profile_count": len(vtube_profiles),
        "vtube_profiles": vtube_profiles,
        "has_motion_catalog": bool(motion_catalog),
    }


def _build_parameter_scan(cdi_payload: dict[str, Any]) -> dict[str, Any]:
    parameter_groups = cdi_payload.get("ParameterGroups", [])
    parameters = cdi_payload.get("Parameters", [])
    group_name_by_id = {
        str(item.get("Id")): str(item.get("Name") or "")
        for item in parameter_groups
        if isinstance(item, dict) and item.get("Id")
    }

    parameter_entries: list[dict[str, Any]] = []
    group_counts: dict[str, int] = {}
    group_domains: dict[str, Counter[str]] = defaultdict(Counter)
    domain_counts: Counter[str] = Counter()
    for item in parameters:
        if not isinstance(item, dict):
            continue
        parameter_id = str(item.get("Id") or "").strip()
        if not parameter_id:
            continue
        parameter_name = str(item.get("Name") or "").strip()
        group_id = str(item.get("GroupId") or "").strip()
        group_name = group_name_by_id.get(group_id, "")
        kind = _infer_parameter_kind(parameter_id, parameter_name)
        channels = _match_standard_channels(parameter_id, parameter_name)
        domain = _infer_parameter_domain(parameter_id, parameter_name, kind, channels)
        entry = {
            "id": parameter_id,
            "name": parameter_name,
            "group_id": group_id,
            "group_name": group_name,
            "kind": kind,
            "domain": domain,
            "channels": channels,
            "expression_usage_count": 0,
            "expression_categories": [],
            "expression_max_abs_value": 0.0,
            "expression_mean_abs_value": 0.0,
            "expression_blends": [],
            "expression_examples": [],
            "expression_profile": "none",
        }
        parameter_entries.append(entry)
        domain_counts[domain] += 1

        if kind == "marker":
            continue
        group_key = group_name or group_id or "UNGROUPED"
        group_counts[group_key] = group_counts.get(group_key, 0) + 1
        group_domains[group_key][domain] += 1

    standard_channels = _build_standard_channel_map(parameter_entries)
    primary_parameters = [
        {
            "channel": channel_name,
            "parameter_id": channel_payload["primary_parameter_id"],
            "parameter_name": channel_payload["primary_parameter_name"],
            "group_name": channel_payload["group_name"],
        }
        for channel_name, channel_payload in standard_channels.items()
        if channel_payload["available"]
    ]

    return {
        "source": "cdi3" if parameter_entries else "unavailable",
        "total_parameters": len(parameter_entries),
        "drivable_parameters": len(
            [item for item in parameter_entries if item["kind"] not in {"marker", "physics"}]
        ),
        "physics_parameters": len(
            [item for item in parameter_entries if item["kind"] == "physics"]
        ),
        "expression_parameters": len(
        [item for item in parameter_entries if item["kind"] == "expression"]
        ),
        "groups": [
            {
                "name": name,
                "count": count,
                "dominant_domain": _pick_top_counter_key(group_domains.get(name, Counter())),
                "domain_counts": _counter_to_ranked_list(group_domains.get(name, Counter())),
            }
            for name, count in sorted(group_counts.items(), key=lambda pair: (-pair[1], pair[0]))
        ],
        "domain_counts": _counter_to_ranked_list(domain_counts),
        "standard_channels": standard_channels,
        "primary_parameters": primary_parameters,
        "parameters": parameter_entries,
    }


def _scan_expressions(
    *,
    model_dir: Path,
    model_payload: dict[str, Any],
    parameter_lookup: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    expressions_payload = model_payload.get("FileReferences", {}).get("Expressions", [])
    expressions: list[dict[str, Any]] = []

    for item in expressions_payload:
        if not isinstance(item, dict):
            continue
        file_value = str(item.get("File") or "").strip()
        if not file_value:
            continue

        expression_path = model_dir / file_value
        expression_payload = _load_json_file(expression_path)
        expression_parameters: list[dict[str, Any]] = []
        for param in expression_payload.get("Parameters", []):
            if not isinstance(param, dict):
                continue
            parameter_id = str(param.get("Id") or "").strip()
            if not parameter_id:
                continue
            value = _coerce_float(param.get("Value"))
            blend = str(param.get("Blend") or "Add").strip() or "Add"
            parameter_entry = parameter_lookup.get(parameter_id, {})
            expression_parameters.append(
                {
                    "id": parameter_id,
                    "name": str(parameter_entry.get("name") or "").strip(),
                    "group_name": str(parameter_entry.get("group_name") or "").strip(),
                    "kind": str(parameter_entry.get("kind") or "unknown"),
                    "domain": str(parameter_entry.get("domain") or "other"),
                    "channels": list(parameter_entry.get("channels", [])),
                    "value": value,
                    "abs_value": round(abs(value), 4),
                    "blend": blend,
                    "intensity": _classify_scalar_intensity(abs(value)),
                }
            )
        parameter_ids = [item["id"] for item in expression_parameters]
        name = str(item.get("Name") or expression_path.stem).strip() or expression_path.stem
        dominant_parameters = [
            {
                "id": item["id"],
                "value": item["value"],
                "blend": item["blend"],
                "domain": item["domain"],
                "channels": item["channels"],
            }
            for item in sorted(
                expression_parameters,
                key=lambda candidate: (-candidate["abs_value"], candidate["id"]),
            )[:5]
        ]
        dominant_domains = _collect_ranked_values(
            item["domain"] for item in expression_parameters if item["domain"]
        )
        dominant_channels = _collect_ranked_values(
            channel
            for item in expression_parameters
            for channel in item["channels"]
            if channel
        )
        expressions.append(
            {
                "name": name,
                "file": file_value.replace("\\", "/"),
                "category": _infer_expression_category(name, parameter_ids),
                "parameter_ids": parameter_ids,
                "parameter_count": len(parameter_ids),
                "affects_channels": _collect_affected_channels(parameter_ids, parameter_lookup),
                "parameters": expression_parameters,
                "dominant_parameters": dominant_parameters,
                "dominant_domains": dominant_domains,
                "dominant_channels": dominant_channels,
                "blend_modes": sorted({item["blend"] for item in expression_parameters}),
                "intensity": _classify_scalar_intensity(
                    max((item["abs_value"] for item in expression_parameters), default=0.0)
                ),
                "touches_non_expression_parameters": any(
                    item["kind"] not in {"expression", "marker", "unknown"}
                    for item in expression_parameters
                ),
            }
        )

    return expressions


def _apply_expression_hints_to_parameters(
    *,
    parameter_scan: dict[str, Any],
    expressions: list[dict[str, Any]],
) -> dict[str, Any]:
    parameter_entries = parameter_scan["parameters"]
    parameter_stats: dict[str, dict[str, Any]] = {}
    category_counts: Counter[str] = Counter()
    blend_counts: Counter[str] = Counter()
    domain_usage: Counter[str] = Counter()
    channel_usage: Counter[str] = Counter()

    for expression in expressions:
        category_counts[str(expression.get("category") or "supplement")] += 1
        for parameter in expression.get("parameters", []):
            parameter_id = str(parameter.get("id") or "").strip()
            if not parameter_id:
                continue
            stats = parameter_stats.setdefault(
                parameter_id,
                {
                    "usage_count": 0,
                    "total_abs_value": 0.0,
                    "max_abs_value": 0.0,
                    "categories": set(),
                    "blends": set(),
                    "examples": [],
                },
            )
            stats["usage_count"] += 1
            stats["total_abs_value"] += float(parameter.get("abs_value") or 0.0)
            stats["max_abs_value"] = max(
                stats["max_abs_value"], float(parameter.get("abs_value") or 0.0)
            )
            stats["categories"].add(str(expression.get("category") or "supplement"))
            blend_value = str(parameter.get("blend") or "").strip()
            if blend_value:
                stats["blends"].add(blend_value)
                blend_counts[blend_value] += 1
            if len(stats["examples"]) < 5:
                stats["examples"].append(str(expression.get("name") or parameter_id))

            domain_value = str(parameter.get("domain") or "").strip()
            if domain_value:
                domain_usage[domain_value] += 1
            for channel_name in parameter.get("channels", []):
                if channel_name:
                    channel_usage[str(channel_name)] += 1

    expression_driven_parameters: list[dict[str, Any]] = []
    for entry in parameter_entries:
        stats = parameter_stats.get(entry["id"])
        if not stats:
            continue
        mean_abs_value = stats["total_abs_value"] / max(stats["usage_count"], 1)
        entry["expression_usage_count"] = stats["usage_count"]
        entry["expression_categories"] = sorted(stats["categories"])
        entry["expression_max_abs_value"] = round(stats["max_abs_value"], 4)
        entry["expression_mean_abs_value"] = round(mean_abs_value, 4)
        entry["expression_blends"] = sorted(stats["blends"])
        entry["expression_examples"] = stats["examples"]
        entry["expression_profile"] = _infer_expression_parameter_profile(entry)
        expression_driven_parameters.append(
            {
                "parameter_id": entry["id"],
                "parameter_name": entry["name"],
                "domain": entry["domain"],
                "kind": entry["kind"],
                "usage_count": entry["expression_usage_count"],
                "max_abs_value": entry["expression_max_abs_value"],
                "profile": entry["expression_profile"],
            }
        )

    base_expression_names = sorted(
        expression["name"]
        for expression in expressions
        if expression.get("category") == "base_emotion"
    )
    special_state_names = sorted(
        expression["name"]
        for expression in expressions
        if expression.get("category") == "special_state"
    )
    return {
        "total_expressions": len(expressions),
        "category_counts": _counter_to_ranked_list(category_counts),
        "blend_counts": _counter_to_ranked_list(blend_counts),
        "domain_usage": _counter_to_ranked_list(domain_usage),
        "channel_usage": _counter_to_ranked_list(channel_usage),
        "base_expression_names": base_expression_names,
        "special_state_names": special_state_names,
        "expression_driven_parameters": sorted(
            expression_driven_parameters,
            key=lambda item: (-item["usage_count"], -item["max_abs_value"], item["parameter_id"]),
        )[:20],
    }


def _scan_motions(
    *,
    model_dir: Path,
    model_payload: dict[str, Any],
    parameter_lookup: dict[str, dict[str, Any]],
    motion_catalog: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    motions_payload = model_payload.get("FileReferences", {}).get("Motions", {})
    seen_files: set[str] = set()
    motions: list[dict[str, Any]] = []

    for group_name, items in motions_payload.items():
        if not isinstance(items, list):
            continue
        normalized_group_name = str(group_name or "").strip()
        for item in items:
            if not isinstance(item, dict):
                continue
            file_value = str(item.get("File") or "").strip()
            if not file_value or file_value in seen_files:
                continue

            seen_files.add(file_value)
            motion_path = model_dir / file_value
            motion_payload = _load_json_file(motion_path)
            parameter_ids = [
                str(curve.get("Id") or "").strip()
                for curve in motion_payload.get("Curves", [])
                if isinstance(curve, dict)
                and curve.get("Target") == "Parameter"
                and str(curve.get("Id") or "").strip()
            ]
            catalog_entry = motion_catalog.get(file_value.replace("\\", "/"), {})
            motion_category = _infer_motion_category(
                group_name=normalized_group_name,
                motion_name=motion_path.stem,
                catalog_entry=catalog_entry,
            )
            decomposition = decompose_motion(
                motion_name=motion_path.stem,
                motion_file=file_value.replace("\\", "/"),
                motion_group=normalized_group_name,
                motion_category=motion_category,
                motion_payload=motion_payload,
                parameter_lookup=parameter_lookup,
                catalog_entry=catalog_entry,
            )
            motions.append(
                {
                    "name": motion_path.stem,
                    "file": file_value.replace("\\", "/"),
                    "group": normalized_group_name,
                    "category": motion_category,
                    "duration": float(
                        motion_payload.get("Meta", {}).get("Duration") or 0.0
                    ),
                    "curve_count": int(motion_payload.get("Meta", {}).get("CurveCount") or 0),
                    "parameter_count": len(set(parameter_ids)),
                    "affects_channels": _collect_affected_channels(parameter_ids, parameter_lookup),
                    "uses_expression_parameters": any(
                        parameter_lookup.get(parameter_id, {}).get("kind") == "expression"
                        for parameter_id in parameter_ids
                    ),
                    "uses_physics_parameters": any(
                        parameter_lookup.get(parameter_id, {}).get("kind") == "physics"
                        for parameter_id in parameter_ids
                    ),
                    "catalog_label": str(catalog_entry.get("label") or "").strip(),
                    "catalog_tags": [
                        str(tag).strip()
                        for tag in catalog_entry.get("tags", [])
                        if str(tag).strip()
                    ],
                    "catalog_intensity": str(catalog_entry.get("intensity") or "").strip(),
                    "decomposition_level": decomposition["decomposition_level"],
                    "component_count": decomposition["component_count"],
                    "component_ids": decomposition["component_ids"],
                    "driver_component_count": decomposition["driver_component_count"],
                    "driver_component_ids": decomposition["driver_component_ids"],
                    "components": decomposition["components"],
                    "dominant_channels": decomposition["dominant_channels"],
                    "dominant_domains": decomposition["dominant_domains"],
                    "channel_weights": decomposition["channel_weights"],
                    "domain_weights": decomposition["domain_weights"],
                    "kind_counts": decomposition["kind_counts"],
                    "segment_types": decomposition["segment_types"],
                    "timeline_profile": decomposition["timeline_profile"],
                    "motion_windows": decomposition["motion_windows"],
                    "loop": decomposition["loop"],
                    "fps": decomposition["fps"],
                }
            )

    return motions


def _build_engine_hints(
    *,
    parameter_scan: dict[str, Any],
    expressions: list[dict[str, Any]],
    motions: list[dict[str, Any]],
) -> dict[str, Any]:
    available_channels = [
        channel_name
        for channel_name, channel_payload in parameter_scan["standard_channels"].items()
        if channel_payload["available"]
    ]
    base_expressions = [
        item["name"]
        for item in expressions
        if item.get("category") in {"base_emotion", "emotion_overlay"}
    ]
    fallback_motions = [
        item["name"]
        for item in motions
        if item.get("category") in {"idle", "talk", "expressive"}
    ]
    if len(available_channels) >= 6:
        recommended_mode = "parameter_primary"
    elif base_expressions:
        recommended_mode = "expression_supported"
    else:
        recommended_mode = "motion_fallback"

    return {
        "driver_priority": ["parameters", "expression", "motion"],
        "recommended_mode": recommended_mode,
        "available_channels": available_channels,
        "base_expression_count": len(base_expressions),
        "fallback_motion_count": len(fallback_motions),
        "motion_decomposition_level": "parameter_track" if motions else "none",
    }


def _build_standard_channel_map(
    parameter_entries: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    channel_map: dict[str, dict[str, Any]] = {}

    for spec in STANDARD_CHANNEL_SPECS:
        candidates: list[tuple[int, dict[str, Any]]] = []
        for entry in parameter_entries:
            if spec["name"] not in entry["channels"]:
                continue
            candidates.append((_score_channel_candidate(spec, entry), entry))
        candidates.sort(key=lambda item: (-item[0], item[1]["id"]))

        if candidates:
            _, primary = candidates[0]
            channel_map[spec["name"]] = {
                "label": spec["label"],
                "available": True,
                "primary_parameter_id": primary["id"],
                "primary_parameter_name": primary["name"],
                "group_name": primary["group_name"],
                "candidate_parameter_ids": [entry["id"] for _, entry in candidates],
            }
        else:
            channel_map[spec["name"]] = {
                "label": spec["label"],
                "available": False,
                "primary_parameter_id": "",
                "primary_parameter_name": "",
                "group_name": "",
                "candidate_parameter_ids": [],
            }

    return channel_map


def _score_channel_candidate(spec: dict[str, Any], entry: dict[str, Any]) -> int:
    parameter_id = entry["id"]
    parameter_name = entry["name"]
    normalized_id = _normalize_lookup_key(parameter_id)
    normalized_name = _normalize_lookup_key(parameter_name)

    if parameter_id in spec["exact_ids"]:
        return 100

    score = 10
    for token in spec["tokens"]:
        if token in normalized_id:
            score += 40
        if token in normalized_name:
            score += 20
    if entry["kind"] == "core":
        score += 20
    return score


def _collect_affected_channels(
    parameter_ids: list[str],
    parameter_lookup: dict[str, dict[str, Any]],
) -> list[str]:
    channels: set[str] = set()
    for parameter_id in parameter_ids:
        parameter_entry = parameter_lookup.get(parameter_id)
        if not parameter_entry:
            continue
        channels.update(parameter_entry.get("channels", []))
    return sorted(channels)


def _infer_parameter_kind(parameter_id: str, parameter_name: str) -> str:
    if parameter_name.startswith("====="):
        return "marker"
    if parameter_id.startswith("Exp") or parameter_id.startswith("Anim"):
        return "expression"
    if parameter_id.startswith("Phy"):
        return "physics"
    if parameter_id.startswith("Param") or parameter_id.startswith("Body") or parameter_id.startswith("Brow"):
        return "core"
    return "auxiliary"


def _infer_parameter_domain(
    parameter_id: str,
    parameter_name: str,
    kind: str,
    channels: list[str],
) -> str:
    if kind == "marker":
        return "marker"
    if kind == "physics":
        return "physics"
    if kind == "expression":
        return "expression"

    normalized = _normalize_lookup_key(f"{parameter_id}{parameter_name}")
    if any(channel.startswith("head_") for channel in channels):
        return "head"
    if any(channel.startswith("body_") for channel in channels):
        return "body"
    if any(channel.startswith("gaze_") for channel in channels):
        return "gaze"
    if any(channel.startswith("eye_") for channel in channels):
        return "eye"
    if any(channel.startswith("brow_") for channel in channels):
        return "brow"
    if any(channel.startswith("mouth_") for channel in channels):
        return "mouth"
    if "breath" in channels:
        return "breath"

    if any(token in normalized for token in ("mouth", "jaw", "lip", "tongue", "teeth")):
        return "mouth"
    if any(token in normalized for token in ("eye", "iris", "pupil", "lash")):
        return "eye"
    if "brow" in normalized:
        return "brow"
    if any(token in normalized for token in ("angle", "head", "neck")):
        return "head"
    if any(token in normalized for token in ("arm", "hand", "finger", "wrist", "shoulder", "forearm")):
        return "limb"
    if any(token in normalized for token in ("body", "breath", "chest", "bust", "torso")):
        return "body"
    if any(token in normalized for token in ("hair", "bang", "ahoge", "tail")):
        return "hair"
    if any(token in normalized for token in ("cloth", "skirt", "jacket", "ribbon", "accessory", "mask")):
        return "accessory"
    if any(token in normalized for token in ("nose", "cheek", "face")):
        return "face"
    return "other"


def _match_standard_channels(parameter_id: str, parameter_name: str) -> list[str]:
    normalized_id = _normalize_lookup_key(parameter_id)
    normalized_name = _normalize_lookup_key(parameter_name)
    matches: list[str] = []
    for spec in STANDARD_CHANNEL_SPECS:
        if parameter_id in spec["exact_ids"]:
            matches.append(spec["name"])
            continue
        if any(token in normalized_id for token in spec["tokens"]):
            matches.append(spec["name"])
            continue
        if any(token in normalized_name for token in spec["tokens"]):
            matches.append(spec["name"])
    return sorted(set(matches))


def _infer_expression_category(name: str, parameter_ids: list[str]) -> str:
    normalized_name = _normalize_lookup_key(name)
    if normalized_name in BASE_EXPRESSION_NAMES:
        return "base_emotion"
    if normalized_name in SPECIAL_EXPRESSION_KEYWORDS:
        return "special_state"
    if parameter_ids and all(item.startswith("Exp") or item.startswith("Anim") for item in parameter_ids):
        return "emotion_overlay"
    if any("Forearm" in item or "Tracking" in item for item in parameter_ids):
        return "special_state"
    return "supplement"


def _infer_expression_parameter_profile(entry: dict[str, Any]) -> str:
    if entry.get("kind") == "expression":
        return "expression_switch"
    if entry.get("kind") == "physics":
        return "physics_secondary"
    if entry.get("expression_usage_count", 0) <= 0:
        return "none"
    if entry.get("channels"):
        return "channel_overlay"
    if entry.get("domain") in {"mouth", "eye", "brow", "face"}:
        return "facial_overlay"
    if entry.get("domain") in {"head", "body", "gaze", "breath"}:
        return "pose_overlay"
    if entry.get("expression_max_abs_value", 0.0) >= 0.95:
        return "hard_toggle"
    return "aux_overlay"


def _infer_motion_category(
    *,
    group_name: str,
    motion_name: str,
    catalog_entry: dict[str, Any],
) -> str:
    normalized_group = group_name.lower()
    if normalized_group == "idle":
        return "idle"
    if normalized_group == "talk":
        return "talk"

    tags = {
        str(tag).strip().lower()
        for tag in catalog_entry.get("tags", [])
        if str(tag).strip()
    }
    if "idle" in tags:
        return "idle"
    if "talk" in tags or "explain" in tags:
        return "talk"

    normalized_name = _normalize_lookup_key(motion_name)
    if "idle" in normalized_name:
        return "idle"
    return "expressive"


def _load_motion_catalog(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    payload = _load_json_file(path)
    motions = payload.get("motions", [])
    catalog: dict[str, dict[str, Any]] = {}
    for item in motions:
        if not isinstance(item, dict):
            continue
        file_value = str(item.get("file") or "").strip().replace("\\", "/")
        if not file_value:
            continue
        catalog[file_value] = item
    return catalog


def _load_json_file(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"`{path}` must contain a JSON object.")
    return payload


def _pick_selected_model(models: list[dict[str, Any]], selected_model_name: str) -> str:
    normalized_target = selected_model_name.strip()
    if normalized_target:
        for item in models:
            if item["name"] == normalized_target:
                return item["name"]
    return models[0]["name"] if models else ""


def _select_icon(model_dir: Path) -> Path | None:
    icons = sorted(model_dir.glob("icon*.png"))
    return icons[0] if icons else None


def _find_first(directory: Path, pattern: str) -> Path | None:
    matches = sorted(directory.glob(pattern))
    return matches[0] if matches else None


def _resolve_optional_path(model_dir: Path, preferred_path: Path, fallback_pattern: str) -> Path | None:
    if preferred_path.exists():
        return preferred_path
    return _find_first(model_dir, fallback_pattern)


def _relative_to(model_dir: Path, path: Path) -> str:
    return str(path.relative_to(model_dir)).replace("\\", "/")


def _to_static_url(base_url: str, model_dir: Path, path: Path) -> str:
    relative = str(path.relative_to(model_dir.parent)).replace("\\", "/")
    return f"{base_url}/live2ds/{relative}"


def _normalize_lookup_key(value: str) -> str:
    return "".join(ch for ch in value.lower() if ch.isalnum())


def _coerce_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _classify_scalar_intensity(value: float) -> str:
    if value >= 0.85:
        return "high"
    if value >= 0.35:
        return "medium"
    if value > 0:
        return "low"
    return "none"


def _counter_to_ranked_list(counter: Counter[str]) -> list[dict[str, Any]]:
    return [
        {"name": name, "count": count}
        for name, count in sorted(counter.items(), key=lambda pair: (-pair[1], pair[0]))
    ]


def _pick_top_counter_key(counter: Counter[str]) -> str:
    ranked = _counter_to_ranked_list(counter)
    return str(ranked[0]["name"]) if ranked else ""


def _collect_ranked_values(values: Any) -> list[str]:
    counter: Counter[str] = Counter(str(item).strip() for item in values if str(item).strip())
    return [item["name"] for item in _counter_to_ranked_list(counter)]
