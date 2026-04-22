from __future__ import annotations

import json
import logging
from collections import Counter, defaultdict
from pathlib import Path
from statistics import median
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

BASE_ACTION_LIBRARY_SCHEMA_VERSION = "base_action_library.v1"
PARAMETER_ACTION_LIBRARY_SCHEMA_VERSION = "parameter_action_library.v1"
ADAPTIVE_PARAMETER_PROFILE_SCHEMA_VERSION = "adaptive_parameter_profile.v1"
CALIBRATION_PROFILE_SCHEMA_VERSION = "direct_parameter_calibration.v1"
MODEL_SUMMARY_SCHEMA_VERSION = "live2d_model_summary.v1"
PARAMETER_ACTION_MAX_ATOMS_PER_PARAMETER = 24

CORE_BASE_ACTION_CHANNEL_SPECS: tuple[dict[str, Any], ...] = (
    {
        "name": "head_yaw",
        "label": "Head Yaw",
        "family": "head_pose",
        "family_label": "Head Pose",
        "domain": "head",
        "max_atoms": 6,
    },
    {
        "name": "head_pitch",
        "label": "Head Pitch",
        "family": "head_pose",
        "family_label": "Head Pose",
        "domain": "head",
        "max_atoms": 6,
    },
    {
        "name": "head_roll",
        "label": "Head Roll",
        "family": "head_pose",
        "family_label": "Head Pose",
        "domain": "head",
        "max_atoms": 6,
    },
    {
        "name": "body_yaw",
        "label": "Body Yaw",
        "family": "body_pose",
        "family_label": "Body Pose",
        "domain": "body",
        "max_atoms": 5,
    },
    {
        "name": "body_roll",
        "label": "Body Roll",
        "family": "body_pose",
        "family_label": "Body Pose",
        "domain": "body",
        "max_atoms": 5,
    },
    {
        "name": "gaze_x",
        "label": "Gaze X",
        "family": "gaze",
        "family_label": "Gaze",
        "domain": "gaze",
        "max_atoms": 5,
    },
    {
        "name": "gaze_y",
        "label": "Gaze Y",
        "family": "gaze",
        "family_label": "Gaze",
        "domain": "gaze",
        "max_atoms": 5,
    },
    {
        "name": "eye_open_left",
        "label": "Eye Open Left",
        "family": "eye",
        "family_label": "Eyes",
        "domain": "eye",
        "max_atoms": 4,
    },
    {
        "name": "eye_open_right",
        "label": "Eye Open Right",
        "family": "eye",
        "family_label": "Eyes",
        "domain": "eye",
        "max_atoms": 4,
    },
    {
        "name": "eye_smile_left",
        "label": "Eye Smile Left",
        "family": "eye",
        "family_label": "Eyes",
        "domain": "eye",
        "max_atoms": 4,
    },
    {
        "name": "eye_smile_right",
        "label": "Eye Smile Right",
        "family": "eye",
        "family_label": "Eyes",
        "domain": "eye",
        "max_atoms": 4,
    },
    {
        "name": "brow_bias",
        "label": "Brow Bias",
        "family": "brow",
        "family_label": "Brows",
        "domain": "brow",
        "max_atoms": 5,
    },
    {
        "name": "mouth_smile",
        "label": "Mouth Smile",
        "family": "mouth",
        "family_label": "Mouth",
        "domain": "mouth",
        "max_atoms": 5,
    },
    {
        "name": "mouth_open",
        "label": "Mouth Open",
        "family": "mouth",
        "family_label": "Mouth",
        "domain": "mouth",
        "max_atoms": 5,
    },
    {
        "name": "mouth_x",
        "label": "Mouth X",
        "family": "mouth",
        "family_label": "Mouth",
        "domain": "mouth",
        "max_atoms": 4,
    },
    {
        "name": "breath",
        "label": "Breath",
        "family": "breath",
        "family_label": "Breath",
        "domain": "breath",
        "max_atoms": 3,
    },
)


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
    try:
        base_action_library = _build_base_action_library(
            parameter_scan=parameter_scan,
            motions=motions,
        )
    except Exception as exc:
        logger.warning(
            "Failed to build base action library for model `%s`, fallback to empty seed: %s",
            model_dir.name,
            exc,
        )
        base_action_library = _build_empty_base_action_library(
            parameter_scan=parameter_scan,
            error=str(exc),
        )
    try:
        parameter_action_library = _build_parameter_action_library(
            parameter_scan=parameter_scan,
            motions=motions,
        )
    except Exception as exc:
        logger.warning(
            "Failed to build parameter action library for model `%s`, fallback to empty seed: %s",
            model_dir.name,
            exc,
        )
        parameter_action_library = _build_empty_parameter_action_library(
            parameter_scan=parameter_scan,
            error=str(exc),
        )
    adaptive_parameter_profile = _build_adaptive_parameter_profile(
        parameter_scan=parameter_scan,
        motions=motions,
        parameter_action_library=parameter_action_library,
    )
    calibration_profile = _build_calibration_profile(
        adaptive_parameter_profile=adaptive_parameter_profile,
    )
    motion_resource_pool = build_motion_resource_pool(motions=motions)
    for motion in motions:
        motion.pop("components", None)

    engine_hints = _build_engine_hints(
        parameter_scan=parameter_scan,
        expressions=expressions,
        motions=motions,
    )
    model_summary = _build_model_summary(
        resource_scan=resource_scan,
        parameter_scan=parameter_scan,
        expressions=expressions,
        motions=motions,
        base_action_library=base_action_library,
        parameter_action_library=parameter_action_library,
        adaptive_parameter_profile=adaptive_parameter_profile,
        calibration_profile=calibration_profile,
        engine_hints=engine_hints,
    )

    selected_icon = _select_icon(model_dir)
    return {
        "name": model_dir.name,
        "root_path": f"/live2ds/{model_dir.name}",
        "model_path": _relative_to(model_dir, model3_path),
        "model_url": _to_static_url(base_url, model_dir, model3_path),
        "icon_url": _to_static_url(base_url, model_dir, selected_icon) if selected_icon else "",
        "resource_scan": resource_scan,
        "summary": model_summary,
        "parameter_scan": parameter_scan,
        "expression_scan": expression_scan,
        "base_action_library": base_action_library,
        "parameter_action_library": parameter_action_library,
        "adaptive_parameter_profile": adaptive_parameter_profile,
        "calibration_profile": calibration_profile,
        "motion_resource_pool": motion_resource_pool,
        "constraints": {
            "expressions": expressions,
            "motions": motions,
        },
        "engine_hints": engine_hints,
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


def _build_base_action_library(
    *,
    parameter_scan: dict[str, Any],
    motions: list[dict[str, Any]],
) -> dict[str, Any]:
    standard_channels = parameter_scan.get("standard_channels", {})
    channel_entries: list[dict[str, Any]] = []
    atoms: list[dict[str, Any]] = []
    family_entries: dict[str, dict[str, Any]] = {}
    channel_rank = {
        spec["name"]: index for index, spec in enumerate(CORE_BASE_ACTION_CHANNEL_SPECS)
    }
    total_candidates = 0
    selected_channel_count = 0

    # Always pre-build family records from channel specs so family/channel references are closed.
    for spec in CORE_BASE_ACTION_CHANNEL_SPECS:
        family_payload = family_entries.setdefault(
            str(spec["family"]),
            {
                "name": spec["family"],
                "label": spec["family_label"],
                "channels": [],
                "atom_ids": [],
            },
        )
        channel_name = str(spec["name"])
        if channel_name not in family_payload["channels"]:
            family_payload["channels"].append(channel_name)

    for spec in CORE_BASE_ACTION_CHANNEL_SPECS:
        channel_name = spec["name"]
        standard_entry = standard_channels.get(channel_name, {})
        available = bool(standard_entry.get("available"))
        primary_parameter_id = str(standard_entry.get("primary_parameter_id") or "").strip()
        selected_candidates: list[dict[str, Any]] = []
        candidate_count = 0
        atom_ids: list[str] = []

        if available:
            candidates = _collect_base_action_candidates(
                motions=motions,
                channel_name=channel_name,
                primary_parameter_id=primary_parameter_id,
                expected_domain=str(spec["domain"]),
            )
            candidate_count = len(candidates)
            total_candidates += candidate_count
            selected_candidates = _select_base_action_candidates(
                candidates=candidates,
                max_atoms=int(spec.get("max_atoms") or 4),
            )

        for rank, candidate in enumerate(selected_candidates, start=1):
            atom = _build_base_action_atom(
                spec=spec,
                standard_entry=standard_entry,
                candidate=candidate,
                rank=rank,
            )
            atoms.append(atom)
            atom_ids.append(atom["id"])

            family_payload = family_entries.setdefault(
                str(spec["family"]),
                {
                    "name": spec["family"],
                    "label": spec["family_label"],
                    "channels": [],
                    "atom_ids": [],
                },
            )
            family_payload["atom_ids"].append(atom["id"])
        if atom_ids:
            selected_channel_count += 1

        polarity_modes = sorted(
            {candidate["polarity"] for candidate in selected_candidates if candidate.get("polarity")}
        )

        channel_entries.append(
            {
                "name": channel_name,
                "label": spec["label"],
                "family": spec["family"],
                "family_label": spec["family_label"],
                "domain": spec["domain"],
                "available": available,
                "primary_parameter_id": primary_parameter_id,
                "primary_parameter_name": str(
                    standard_entry.get("primary_parameter_name") or ""
                ).strip(),
                "candidate_parameter_ids": list(
                    standard_entry.get("candidate_parameter_ids", [])
                ),
                "candidate_component_count": candidate_count,
                "selected_atom_count": len(atom_ids),
                "polarity_modes": polarity_modes,
                "atom_ids": atom_ids,
            }
        )

    family_rank = {
        spec["family"]: index for index, spec in enumerate(CORE_BASE_ACTION_CHANNEL_SPECS)
    }
    families = sorted(
        (
            {
                "name": payload["name"],
                "label": payload["label"],
                "channels": sorted(
                    payload["channels"],
                    key=lambda channel_name: channel_rank.get(channel_name, 999),
                ),
                "atom_ids": payload["atom_ids"],
                "atom_count": len(payload["atom_ids"]),
            }
            for payload in family_entries.values()
        ),
        key=lambda item: (family_rank.get(item["name"], 999), item["name"]),
    )

    return {
        "schema_version": BASE_ACTION_LIBRARY_SCHEMA_VERSION,
        "extraction_mode": "rule_seed",
        "analysis": {
            "status": "pending",
            "mode": "rule_seed",
            "provider_id": "",
        },
        "focus_channels": [spec["name"] for spec in CORE_BASE_ACTION_CHANNEL_SPECS],
        "focus_domains": sorted({spec["domain"] for spec in CORE_BASE_ACTION_CHANNEL_SPECS}),
        "ignored_domains": ["hair", "accessory", "limb", "physics", "marker", "other"],
        "summary": {
            "motion_count": len(motions),
            "available_channel_count": len(
                [item for item in channel_entries if item["available"]]
            ),
            "selected_channel_count": selected_channel_count,
            "candidate_component_count": total_candidates,
            "selected_atom_count": len(atoms),
            "family_count": len(families),
        },
        "families": families,
        "channels": channel_entries,
        "atoms": atoms,
    }


def _build_empty_base_action_library(
    *,
    parameter_scan: dict[str, Any],
    error: str,
) -> dict[str, Any]:
    standard_channels = parameter_scan.get("standard_channels", {})
    channel_rank = {
        spec["name"]: index for index, spec in enumerate(CORE_BASE_ACTION_CHANNEL_SPECS)
    }
    family_entries: dict[str, dict[str, Any]] = {}
    channel_entries: list[dict[str, Any]] = []

    for spec in CORE_BASE_ACTION_CHANNEL_SPECS:
        family_payload = family_entries.setdefault(
            str(spec["family"]),
            {
                "name": spec["family"],
                "label": spec["family_label"],
                "channels": [],
                "atom_ids": [],
            },
        )
        channel_name = str(spec["name"])
        if channel_name not in family_payload["channels"]:
            family_payload["channels"].append(channel_name)

        standard_entry = standard_channels.get(channel_name, {})
        channel_entries.append(
            {
                "name": channel_name,
                "label": spec["label"],
                "family": spec["family"],
                "family_label": spec["family_label"],
                "domain": spec["domain"],
                "available": bool(standard_entry.get("available")),
                "primary_parameter_id": str(
                    standard_entry.get("primary_parameter_id") or ""
                ).strip(),
                "primary_parameter_name": str(
                    standard_entry.get("primary_parameter_name") or ""
                ).strip(),
                "candidate_parameter_ids": list(
                    standard_entry.get("candidate_parameter_ids", [])
                ),
                "candidate_component_count": 0,
                "selected_atom_count": 0,
                "polarity_modes": [],
                "atom_ids": [],
            }
        )

    family_rank = {
        spec["family"]: index for index, spec in enumerate(CORE_BASE_ACTION_CHANNEL_SPECS)
    }
    families = sorted(
        (
            {
                "name": payload["name"],
                "label": payload["label"],
                "channels": sorted(
                    payload["channels"],
                    key=lambda channel_name: channel_rank.get(channel_name, 999),
                ),
                "atom_ids": [],
                "atom_count": 0,
            }
            for payload in family_entries.values()
        ),
        key=lambda item: (family_rank.get(item["name"], 999), item["name"]),
    )

    return {
        "schema_version": BASE_ACTION_LIBRARY_SCHEMA_VERSION,
        "extraction_mode": "rule_seed",
        "analysis": {
            "status": "failed",
            "mode": "rule_seed",
            "provider_id": "",
            "error": error,
        },
        "focus_channels": [spec["name"] for spec in CORE_BASE_ACTION_CHANNEL_SPECS],
        "focus_domains": sorted({spec["domain"] for spec in CORE_BASE_ACTION_CHANNEL_SPECS}),
        "ignored_domains": ["hair", "accessory", "limb", "physics", "marker", "other"],
        "summary": {
            "motion_count": 0,
            "available_channel_count": len(
                [item for item in channel_entries if item["available"]]
            ),
            "selected_channel_count": 0,
            "candidate_component_count": 0,
            "selected_atom_count": 0,
            "family_count": len(families),
        },
        "families": families,
        "channels": channel_entries,
        "atoms": [],
    }


def _build_parameter_action_library(
    *,
    parameter_scan: dict[str, Any],
    motions: list[dict[str, Any]],
) -> dict[str, Any]:
    parameter_lookup = {
        str(item.get("id") or "").strip(): item
        for item in parameter_scan.get("parameters", [])
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }
    candidates_by_parameter: dict[str, list[dict[str, Any]]] = defaultdict(list)
    driver_component_count = 0
    candidate_atom_count = 0

    for motion in motions:
        for component in motion.get("components", []):
            if not isinstance(component, dict):
                continue
            if str(component.get("engine_role") or "").strip() != "driver":
                continue
            if str(component.get("strength") or "").strip() == "none":
                continue

            parameter_id = str(component.get("parameter_id") or "").strip()
            if not parameter_id:
                continue
            driver_component_count += 1

            channels = [
                str(item).strip()
                for item in component.get("channels", [])
                if str(item).strip()
            ]
            primary_channel = channels[0] if channels else ""
            polarity = _infer_base_action_polarity(
                component=component,
                channel_name=primary_channel or "parameter",
            )
            semantic_polarity = _map_semantic_polarity(
                channel_name=primary_channel or "parameter",
                polarity=polarity,
            )
            windows = _normalize_component_windows(component.get("windows"))

            for window_index, window in enumerate(windows, start=1):
                window_duration_ratio = round(
                    max(window["end_ratio"] - window["start_ratio"], 0.0),
                    4,
                )
                score = _score_parameter_action_candidate(
                    component=component,
                    window_duration_ratio=window_duration_ratio,
                )
                candidate_atom_count += 1
                candidates_by_parameter[parameter_id].append(
                    {
                        "motion": motion,
                        "component": component,
                        "parameter_id": parameter_id,
                        "channels": channels,
                        "primary_channel": primary_channel,
                        "polarity": polarity,
                        "semantic_polarity": semantic_polarity,
                        "trait": str(component.get("trait") or "unknown"),
                        "strength": str(component.get("strength") or "none"),
                        "window_index": window_index,
                        "window_start_ratio": window["start_ratio"],
                        "window_end_ratio": window["end_ratio"],
                        "window_duration_ratio": window_duration_ratio,
                        "score": score,
                    }
                )

    atoms: list[dict[str, Any]] = []
    parameter_entries: list[dict[str, Any]] = []
    selected_parameter_count = 0

    for parameter_id in sorted(candidates_by_parameter.keys()):
        parameter_candidates = _select_parameter_action_candidates(
            candidates=candidates_by_parameter[parameter_id],
            max_atoms=PARAMETER_ACTION_MAX_ATOMS_PER_PARAMETER,
        )
        atom_ids: list[str] = []
        for rank, candidate in enumerate(parameter_candidates, start=1):
            atom = _build_parameter_action_atom(
                candidate=candidate,
                parameter_entry=parameter_lookup.get(parameter_id, {}),
                rank=rank,
            )
            atoms.append(atom)
            atom_ids.append(atom["id"])

        if atom_ids:
            selected_parameter_count += 1
        parameter_entry = parameter_lookup.get(parameter_id, {})
        parameter_entries.append(
            {
                "parameter_id": parameter_id,
                "parameter_name": str(parameter_entry.get("name") or "").strip(),
                "group_name": str(parameter_entry.get("group_name") or "").strip(),
                "kind": str(parameter_entry.get("kind") or "unknown"),
                "domain": str(
                    parameter_entry.get("domain")
                    or parameter_candidates[0]["component"].get("domain")
                    or "other"
                ),
                "channels": list(parameter_entry.get("channels", []))
                or list(parameter_candidates[0].get("channels", [])),
                "candidate_atom_count": len(candidates_by_parameter[parameter_id]),
                "selected_atom_count": len(atom_ids),
                "atom_ids": atom_ids,
            }
        )

    domain_counts = Counter(
        str(item.get("domain") or "other")
        for item in parameter_entries
        if item.get("selected_atom_count", 0) > 0
    )
    channel_counts = Counter(
        channel_name
        for item in parameter_entries
        if item.get("selected_atom_count", 0) > 0
        for channel_name in item.get("channels", [])
        if channel_name
    )

    return {
        "schema_version": PARAMETER_ACTION_LIBRARY_SCHEMA_VERSION,
        "extraction_mode": "rule_seed",
        "analysis": {
            "status": "seeded",
            "mode": "parameter_track",
            "provider_id": "",
        },
        "summary": {
            "motion_count": len(motions),
            "driver_component_count": driver_component_count,
            "candidate_atom_count": candidate_atom_count,
            "selected_atom_count": len(atoms),
            "candidate_parameter_count": len(candidates_by_parameter),
            "selected_parameter_count": selected_parameter_count,
            "domain_count": len(domain_counts),
            "channel_count": len(channel_counts),
        },
        "domains": _counter_to_ranked_list(domain_counts),
        "channels": _counter_to_ranked_list(channel_counts),
        "parameters": parameter_entries,
        "atoms": atoms,
    }


def _build_empty_parameter_action_library(
    *,
    parameter_scan: dict[str, Any],
    error: str,
) -> dict[str, Any]:
    domains = Counter(
        str(item.get("domain") or "other")
        for item in parameter_scan.get("parameters", [])
        if isinstance(item, dict)
    )
    channels = Counter(
        channel_name
        for item in parameter_scan.get("parameters", [])
        if isinstance(item, dict)
        for channel_name in item.get("channels", [])
        if channel_name
    )
    return {
        "schema_version": PARAMETER_ACTION_LIBRARY_SCHEMA_VERSION,
        "extraction_mode": "rule_seed",
        "analysis": {
            "status": "failed",
            "mode": "parameter_track",
            "provider_id": "",
            "error": error,
        },
        "summary": {
            "motion_count": 0,
            "driver_component_count": 0,
            "candidate_atom_count": 0,
            "selected_atom_count": 0,
            "candidate_parameter_count": 0,
            "selected_parameter_count": 0,
            "domain_count": len(domains),
            "channel_count": len(channels),
        },
        "domains": _counter_to_ranked_list(domains),
        "channels": _counter_to_ranked_list(channels),
        "parameters": [],
        "atoms": [],
    }


def _build_adaptive_parameter_profile(
    *,
    parameter_scan: dict[str, Any],
    motions: list[dict[str, Any]],
    parameter_action_library: dict[str, Any],
) -> dict[str, Any]:
    parameter_lookup = {
        str(item.get("id") or "").strip(): item
        for item in parameter_scan.get("parameters", [])
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }
    standard_channels = {
        str(channel_name): channel_payload
        for channel_name, channel_payload in (parameter_scan.get("standard_channels") or {}).items()
        if str(channel_name).strip() and isinstance(channel_payload, dict)
    }
    parameter_library_lookup = {
        str(item.get("parameter_id") or "").strip(): item
        for item in parameter_action_library.get("parameters", [])
        if isinstance(item, dict) and str(item.get("parameter_id") or "").strip()
    }
    atoms_by_parameter: dict[str, list[dict[str, Any]]] = defaultdict(list)
    atoms_by_channel: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for atom in parameter_action_library.get("atoms", []):
        if not isinstance(atom, dict):
            continue
        parameter_id = str(atom.get("parameter_id") or "").strip()
        if parameter_id:
            atoms_by_parameter[parameter_id].append(atom)
        primary_channel = str(atom.get("primary_channel") or "").strip()
        if primary_channel:
            atoms_by_channel[primary_channel].append(atom)
        for channel_name in atom.get("channels", []):
            normalized_channel = str(channel_name).strip()
            if normalized_channel and atom not in atoms_by_channel[normalized_channel]:
                atoms_by_channel[normalized_channel].append(atom)

    observations_by_parameter: dict[str, list[dict[str, Any]]] = defaultdict(list)
    observations_by_channel: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for motion in motions:
        if not isinstance(motion, dict):
            continue
        for component in motion.get("components", []):
            if not isinstance(component, dict):
                continue
            if str(component.get("engine_role") or "").strip() != "driver":
                continue
            if str(component.get("strength") or "").strip() == "none":
                continue

            parameter_id = str(component.get("parameter_id") or "").strip()
            if not parameter_id:
                continue
            parameter_entry = parameter_lookup.get(parameter_id, {})
            parameter_domain = str(parameter_entry.get("domain") or "").strip()
            component_domain = str(component.get("domain") or "").strip()
            if (
                parameter_domain
                and component_domain
                and parameter_domain not in {"other", "unknown"}
                and component_domain not in {"other", "unknown"}
                and component_domain != parameter_domain
            ):
                continue
            component_channels = [
                str(item).strip()
                for item in component.get("channels", [])
                if str(item).strip()
            ]
            channels = sorted(
                set(component_channels)
                | {
                    str(item).strip()
                    for item in parameter_entry.get("channels", [])
                    if str(item).strip()
                }
            )
            primary_channel = component_channels[0] if component_channels else (channels[0] if channels else "")
            value_profile = component.get("value_profile", {})
            baseline = _coerce_float(value_profile.get("baseline"))
            observed_min = _coerce_float(value_profile.get("min"))
            observed_max = _coerce_float(value_profile.get("max"))
            if observed_max < observed_min:
                observed_min, observed_max = observed_max, observed_min
            polarity = _infer_base_action_polarity(
                component=component,
                channel_name=primary_channel or "parameter",
            )
            observation = {
                "parameter_id": parameter_id,
                "channels": channels,
                "primary_channel": primary_channel,
                "domain": str(parameter_entry.get("domain") or component.get("domain") or "other"),
                "baseline": round(baseline, 4),
                "observed_min": round(observed_min, 4),
                "observed_max": round(observed_max, 4),
                "polarity": polarity,
                "source_motion": str(motion.get("name") or component.get("source_motion") or "").strip(),
                "source_component_id": str(component.get("id") or "").strip(),
            }
            observations_by_parameter[parameter_id].append(observation)
            for channel_name in channels:
                observations_by_channel[channel_name].append(observation)

    parameter_ids: set[str] = set(parameter_lookup.keys())
    parameter_ids.update(parameter_library_lookup.keys())
    parameter_ids.update(atoms_by_parameter.keys())
    parameter_ids.update(observations_by_parameter.keys())
    for channel_payload in standard_channels.values():
        parameter_ids.update(
            str(item).strip()
            for item in channel_payload.get("candidate_parameter_ids", [])
            if str(item).strip()
        )
        primary_parameter_id = str(channel_payload.get("primary_parameter_id") or "").strip()
        if primary_parameter_id:
            parameter_ids.add(primary_parameter_id)

    parameter_profiles: list[dict[str, Any]] = []
    parameter_profiles_by_id: dict[str, dict[str, Any]] = {}
    for parameter_id in sorted(parameter_ids):
        parameter_entry = parameter_lookup.get(parameter_id, {})
        library_entry = parameter_library_lookup.get(parameter_id, {})
        observations = observations_by_parameter.get(parameter_id, [])
        atoms = atoms_by_parameter.get(parameter_id, [])
        channels = sorted(
            set(str(item).strip() for item in parameter_entry.get("channels", []) if str(item).strip())
            | set(str(item).strip() for item in library_entry.get("channels", []) if str(item).strip())
            | {
                str(channel_name).strip()
                for observation in observations
                for channel_name in observation.get("channels", [])
                if str(channel_name).strip()
            }
        )
        range_profile = _summarize_range_profile(
            observations=observations,
            fallback_baseline=0.0,
        )
        directionality = _build_directionality_profile(
            component_polarities=[
                str(item.get("polarity") or "").strip()
                for item in observations
                if str(item.get("polarity") or "").strip()
            ],
            selected_atom_polarities=[
                str(item.get("polarity") or "").strip()
                for item in atoms
                if str(item.get("polarity") or "").strip()
            ],
        )
        recommended_range = _build_recommended_execution_range(
            baseline=float(range_profile["baseline"]),
            common_range=dict(range_profile["common_range"]),
            observed_min=float(range_profile["observed_min"]),
            observed_max=float(range_profile["observed_max"]),
            observation_count=len(observations),
            selected_atom_count=len(atoms),
            source="parameter",
        )
        parameter_profile = {
            "parameter_id": parameter_id,
            "parameter_name": str(parameter_entry.get("name") or library_entry.get("parameter_name") or "").strip(),
            "group_name": str(parameter_entry.get("group_name") or library_entry.get("group_name") or "").strip(),
            "kind": str(parameter_entry.get("kind") or library_entry.get("kind") or "unknown"),
            "domain": str(parameter_entry.get("domain") or library_entry.get("domain") or "other"),
            "channels": channels,
            "baseline": float(range_profile["baseline"]),
            "common_range": dict(range_profile["common_range"]),
            "observed_min": float(range_profile["observed_min"]),
            "observed_max": float(range_profile["observed_max"]),
            "directionality": directionality,
            "recommended_execution_range": recommended_range,
            "observation_count": len(observations),
            "source_motion_count": len(
                {
                    str(item.get("source_motion") or "").strip()
                    for item in observations
                    if str(item.get("source_motion") or "").strip()
                }
            ),
            "candidate_atom_count": int(library_entry.get("candidate_atom_count") or len(observations)),
            "selected_atom_count": len(atoms),
        }
        parameter_profiles.append(parameter_profile)
        parameter_profiles_by_id[parameter_id] = parameter_profile

    channel_specs = [
        spec for spec in STANDARD_CHANNEL_SPECS if spec["name"] in standard_channels
    ] or [
        {"name": channel_name, "label": str(channel_payload.get("label") or channel_name)}
        for channel_name, channel_payload in sorted(standard_channels.items())
    ]
    channel_profiles: list[dict[str, Any]] = []
    for spec in channel_specs:
        channel_name = str(spec["name"])
        channel_payload = standard_channels.get(channel_name, {})
        channel_observations = observations_by_channel.get(channel_name, [])
        associated_parameter_ids = sorted(
            set(
                str(item).strip()
                for item in channel_payload.get("candidate_parameter_ids", [])
                if str(item).strip()
            )
            | {
                str(item.get("parameter_id") or "").strip()
                for item in channel_observations
                if str(item.get("parameter_id") or "").strip()
            }
        )
        range_profile = _summarize_range_profile(
            observations=channel_observations,
            fallback_baseline=0.0,
        )
        directionality = _build_directionality_profile(
            component_polarities=[
                str(item.get("polarity") or "").strip()
                for item in channel_observations
                if str(item.get("polarity") or "").strip()
            ],
            selected_atom_polarities=[
                str(item.get("polarity") or "").strip()
                for item in atoms_by_channel.get(channel_name, [])
                if str(item.get("polarity") or "").strip()
            ],
        )
        axis_range = _build_axis_execution_range(
            channel_name=channel_name,
            primary_parameter_id=str(channel_payload.get("primary_parameter_id") or "").strip(),
            parameter_profiles_by_id=parameter_profiles_by_id,
            range_profile=range_profile,
            observation_count=len(channel_observations),
            selected_atom_count=len(atoms_by_channel.get(channel_name, [])),
        )
        channel_profiles.append(
            {
                "channel": channel_name,
                "label": str(channel_payload.get("label") or spec.get("label") or channel_name),
                "available": bool(channel_payload.get("available")),
                "primary_parameter_id": str(channel_payload.get("primary_parameter_id") or "").strip(),
                "primary_parameter_name": str(
                    channel_payload.get("primary_parameter_name") or ""
                ).strip(),
                "candidate_parameter_ids": associated_parameter_ids,
                "baseline": float(range_profile["baseline"]),
                "common_range": dict(range_profile["common_range"]),
                "observed_min": float(range_profile["observed_min"]),
                "observed_max": float(range_profile["observed_max"]),
                "directionality": directionality,
                "recommended_execution_range": axis_range,
                "observation_count": len(channel_observations),
                "selected_atom_count": len(atoms_by_channel.get(channel_name, [])),
                "parameter_count": len(associated_parameter_ids),
            }
        )

    key_axes = [
        {
            "axis": channel_profile["channel"],
            "parameter_id": str(
                channel_profile.get("recommended_execution_range", {}).get("parameter_id") or ""
            ).strip(),
            "parameter_name": str(
                channel_profile.get("recommended_execution_range", {}).get("parameter_name") or ""
            ).strip(),
            "baseline": _coerce_float(
                channel_profile.get("recommended_execution_range", {}).get(
                    "baseline",
                    channel_profile.get("baseline", 0.0),
                )
            ),
            "recommended_execution_range": {
                "min": _coerce_float(
                    channel_profile.get("recommended_execution_range", {}).get(
                        "min",
                        channel_profile.get("baseline", 0.0),
                    )
                ),
                "max": _coerce_float(
                    channel_profile.get("recommended_execution_range", {}).get(
                        "max",
                        channel_profile.get("baseline", 0.0),
                    )
                ),
                "confidence": str(
                    channel_profile.get("recommended_execution_range", {}).get("confidence")
                    or "none"
                ),
            },
            "recommended": bool(
                channel_profile.get("recommended_execution_range", {}).get("recommended", False)
            ),
            "safe_to_apply": bool(
                channel_profile.get("recommended_execution_range", {}).get("safe_to_apply", False)
            ),
            "source": str(
                channel_profile.get("recommended_execution_range", {}).get("source") or ""
            ),
            "skip_reason": str(
                channel_profile.get("recommended_execution_range", {}).get("skip_reason") or ""
            ),
            "direction_preference": str(
                channel_profile.get("directionality", {}).get("dominant") or "none"
            ),
        }
        for channel_profile in channel_profiles
        if channel_profile.get("available")
    ]

    runtime_axis_ranges = {
        str(item["axis"]): {
            "parameter_id": str(item["parameter_id"] or ""),
            "parameter_name": str(item["parameter_name"] or ""),
            "baseline": float(item["baseline"]),
            "min": float(item["recommended_execution_range"]["min"]),
            "max": float(item["recommended_execution_range"]["max"]),
            "confidence": str(item["recommended_execution_range"]["confidence"]),
            "recommended": bool(item.get("recommended", False)),
            "safe_to_apply": bool(item.get("safe_to_apply", False)),
            "source": str(item.get("source") or ""),
            "skip_reason": str(item.get("skip_reason") or ""),
        }
        for item in key_axes
    }

    return {
        "schema_version": ADAPTIVE_PARAMETER_PROFILE_SCHEMA_VERSION,
        "analysis": {
            "status": "seeded" if motions or parameter_profiles else "empty",
            "mode": "rule_seed",
            "source_components": [
                "parameter_scan",
                "motions",
                "parameter_action_library",
            ],
        },
        "summary": {
            "profiled_parameter_count": len(parameter_profiles),
            "observed_parameter_count": len(
                [item for item in parameter_profiles if int(item["observation_count"]) > 0]
            ),
            "available_channel_count": len(
                [item for item in channel_profiles if bool(item["available"])]
            ),
            "observed_channel_count": len(
                [item for item in channel_profiles if int(item["observation_count"]) > 0]
            ),
            "recommended_axis_count": len(
                [
                    item
                    for item in key_axes
                    if bool(item.get("recommended"))
                ]
            ),
        },
        "channels": channel_profiles,
        "parameters": parameter_profiles,
        "key_axes": key_axes,
        "runtime_summary": {
            "axis_parameter_map": {
                axis_name: str(axis_payload["parameter_id"])
                for axis_name, axis_payload in runtime_axis_ranges.items()
                if str(axis_payload["parameter_id"]).strip()
                and bool(axis_payload.get("recommended"))
            },
            "axis_execution_ranges": runtime_axis_ranges,
            "channel_direction_preferences": {
                str(item["channel"]): str(item.get("directionality", {}).get("dominant") or "none")
                for item in channel_profiles
                if bool(item.get("available"))
            },
        },
    }


def _build_calibration_profile(
    *,
    adaptive_parameter_profile: dict[str, Any],
) -> dict[str, Any]:
    channels = {
        str(item.get("channel") or "").strip(): item
        for item in adaptive_parameter_profile.get("channels", [])
        if isinstance(item, dict) and str(item.get("channel") or "").strip()
    }
    axes: dict[str, dict[str, Any]] = {}

    for key_axis in adaptive_parameter_profile.get("key_axes", []):
        if not isinstance(key_axis, dict):
            continue
        axis_name = str(key_axis.get("axis") or "").strip()
        if not axis_name:
            continue

        range_payload = key_axis.get("recommended_execution_range", {})
        if not isinstance(range_payload, dict):
            range_payload = {}
        channel_payload = channels.get(axis_name, {})
        confidence = str(range_payload.get("confidence") or "none")
        source = str(key_axis.get("source") or range_payload.get("source") or "").strip()
        safe_to_apply = bool(
            key_axis.get("safe_to_apply", key_axis.get("recommended", False))
        )

        calibration_axis: dict[str, Any] = {
            "parameter_id": str(key_axis.get("parameter_id") or "").strip(),
            "parameter_ids": [
                str(item).strip()
                for item in channel_payload.get("candidate_parameter_ids", [])
                if str(item).strip()
            ],
            "baseline": _round_float(key_axis.get("baseline")),
            "observed_range": {
                "min": _round_float(channel_payload.get("observed_min")),
                "max": _round_float(channel_payload.get("observed_max")),
            },
            "confidence": confidence,
            "source": source,
            "recommended": safe_to_apply,
            "safe_to_apply": safe_to_apply,
        }
        if safe_to_apply:
            calibration_axis["recommended_range"] = {
                "min": _round_float(range_payload.get("min")),
                "max": _round_float(range_payload.get("max")),
            }
        else:
            skip_reason = str(key_axis.get("skip_reason") or "").strip()
            if skip_reason:
                calibration_axis["skip_reason"] = skip_reason

        direction_preference = str(key_axis.get("direction_preference") or "").strip().lower()
        if direction_preference == "negative":
            calibration_axis["direction"] = -1
        elif direction_preference == "positive":
            calibration_axis["direction"] = 1

        axes[axis_name] = calibration_axis

    return {
        "schema_version": CALIBRATION_PROFILE_SCHEMA_VERSION,
        "axes": axes,
    }


def _summarize_range_profile(
    *,
    observations: list[dict[str, Any]],
    fallback_baseline: float,
) -> dict[str, Any]:
    baselines = [_coerce_float(item.get("baseline")) for item in observations]
    baseline = _round_float(
        (sum(baselines) / len(baselines)) if baselines else fallback_baseline
    )
    observed_min = _round_float(
        min(_coerce_float(item.get("observed_min")) for item in observations)
        if observations
        else baseline
    )
    observed_max = _round_float(
        max(_coerce_float(item.get("observed_max")) for item in observations)
        if observations
        else baseline
    )

    negative_spans = sorted(
        max(_coerce_float(item.get("baseline")) - _coerce_float(item.get("observed_min")), 0.0)
        for item in observations
    )
    positive_spans = sorted(
        max(_coerce_float(item.get("observed_max")) - _coerce_float(item.get("baseline")), 0.0)
        for item in observations
    )
    common_negative = _round_float(float(median(negative_spans)) if negative_spans else 0.0)
    common_positive = _round_float(float(median(positive_spans)) if positive_spans else 0.0)
    common_min = _round_float(max(observed_min, baseline - common_negative))
    common_max = _round_float(min(observed_max, baseline + common_positive))
    if common_max < common_min:
        common_min = baseline
        common_max = baseline

    return {
        "baseline": baseline,
        "common_range": {
            "min": common_min,
            "max": common_max,
        },
        "observed_min": observed_min,
        "observed_max": observed_max,
    }


def _build_directionality_profile(
    *,
    component_polarities: list[str],
    selected_atom_polarities: list[str],
) -> dict[str, Any]:
    supported_polarities = ("positive", "negative", "balanced", "neutral", "cyclical")
    component_counter = Counter(
        item for item in component_polarities if item in supported_polarities
    )
    atom_counter = Counter(
        item for item in selected_atom_polarities if item in supported_polarities
    )
    combined_counter = component_counter if sum(component_counter.values()) > 0 else atom_counter
    dominant = _resolve_direction_preference(combined_counter)
    return {
        "component_counts": {
            polarity: int(component_counter.get(polarity, 0))
            for polarity in supported_polarities
        },
        "selected_atom_counts": {
            polarity: int(atom_counter.get(polarity, 0))
            for polarity in supported_polarities
        },
        "dominant": dominant,
    }


def _resolve_direction_preference(counter: Counter[str]) -> str:
    total = sum(counter.values())
    if total <= 0:
        return "none"

    ranked = sorted(counter.items(), key=lambda item: (-item[1], item[0]))
    top_name, top_count = ranked[0]
    second_count = ranked[1][1] if len(ranked) > 1 else 0
    if top_count <= 0:
        return "none"
    if second_count > 0 and top_count < max(second_count * 1.5, second_count + 1):
        return "mixed"
    return str(top_name)


def _build_recommended_execution_range(
    *,
    baseline: float,
    common_range: dict[str, Any],
    observed_min: float,
    observed_max: float,
    observation_count: int,
    selected_atom_count: int,
    source: str,
) -> dict[str, Any]:
    confidence = _classify_range_confidence(
        observation_count=observation_count,
        selected_atom_count=selected_atom_count,
    )
    return {
        "min": _round_float(float(common_range.get("min") or baseline)),
        "max": _round_float(float(common_range.get("max") or baseline)),
        "baseline": _round_float(baseline),
        "observed_min": _round_float(observed_min),
        "observed_max": _round_float(observed_max),
        "confidence": confidence,
        "source": source,
    }


def _classify_range_confidence(
    *,
    observation_count: int,
    selected_atom_count: int,
) -> str:
    if observation_count >= 4 or selected_atom_count >= 4:
        return "high"
    if observation_count >= 2 or selected_atom_count >= 2:
        return "medium"
    if observation_count >= 1 or selected_atom_count >= 1:
        return "low"
    return "none"


def _build_axis_execution_range(
    *,
    channel_name: str,
    primary_parameter_id: str,
    parameter_profiles_by_id: dict[str, dict[str, Any]],
    range_profile: dict[str, Any],
    observation_count: int,
    selected_atom_count: int,
) -> dict[str, Any]:
    del channel_name
    selected_parameter = parameter_profiles_by_id.get(primary_parameter_id, {})
    parameter_range = selected_parameter.get("recommended_execution_range", {})
    channel_range = _build_recommended_execution_range(
        baseline=float(range_profile["baseline"]),
        common_range=dict(range_profile["common_range"]),
        observed_min=float(range_profile["observed_min"]),
        observed_max=float(range_profile["observed_max"]),
        observation_count=observation_count,
        selected_atom_count=selected_atom_count,
        source="channel_aggregate",
    )
    parameter_confidence = str(parameter_range.get("confidence") or "none")
    parameter_observation_count = int(selected_parameter.get("observation_count") or 0)
    if (
        selected_parameter
        and parameter_observation_count >= 2
        and parameter_confidence in {"medium", "high"}
    ):
        return {
            "parameter_id": primary_parameter_id,
            "parameter_name": str(selected_parameter.get("parameter_name") or "").strip(),
            "min": _round_float(float(parameter_range.get("min") or 0.0)),
            "max": _round_float(float(parameter_range.get("max") or 0.0)),
            "baseline": _round_float(float(parameter_range.get("baseline") or 0.0)),
            "confidence": parameter_confidence,
            "source": "primary_parameter",
            "recommended": True,
            "safe_to_apply": True,
        }

    skip_reason = "primary_parameter_insufficient_observations"
    if not primary_parameter_id:
        skip_reason = "missing_primary_parameter"
    elif not selected_parameter:
        skip_reason = "missing_primary_parameter_profile"
    elif parameter_observation_count <= 0:
        skip_reason = "primary_parameter_unobserved"

    return {
        "parameter_id": primary_parameter_id,
        "parameter_name": str(
            parameter_profiles_by_id.get(primary_parameter_id, {}).get("parameter_name") or ""
        ).strip(),
        "min": _round_float(float(channel_range["min"])),
        "max": _round_float(float(channel_range["max"])),
        "baseline": _round_float(float(channel_range["baseline"])),
        "confidence": str(channel_range["confidence"]),
        "source": str(channel_range["source"] or "channel_aggregate"),
        "recommended": False,
        "safe_to_apply": False,
        "skip_reason": skip_reason,
    }


def _build_model_summary(
    *,
    resource_scan: dict[str, Any],
    parameter_scan: dict[str, Any],
    expressions: list[dict[str, Any]],
    motions: list[dict[str, Any]],
    base_action_library: dict[str, Any],
    parameter_action_library: dict[str, Any],
    adaptive_parameter_profile: dict[str, Any],
    calibration_profile: dict[str, Any],
    engine_hints: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schema_version": MODEL_SUMMARY_SCHEMA_VERSION,
        "resources": {
            "texture_count": int(resource_scan.get("texture_count") or 0),
            "expression_count": int(resource_scan.get("expression_count") or 0),
            "motion_count": int(resource_scan.get("motion_count") or 0),
            "vtube_profile_count": int(resource_scan.get("vtube_profile_count") or 0),
        },
        "parameters": {
            "total": int(parameter_scan.get("total_parameters") or 0),
            "drivable": int(parameter_scan.get("drivable_parameters") or 0),
            "standard_channel_count": len(parameter_scan.get("standard_channels", {})),
            "available_standard_channel_count": len(
                [
                    item
                    for item in parameter_scan.get("standard_channels", {}).values()
                    if isinstance(item, dict) and bool(item.get("available"))
                ]
            ),
        },
        "expressions": {
            "count": len(expressions),
            "base_emotion_count": len(
                [
                    item
                    for item in expressions
                    if str(item.get("category") or "") in {"base_emotion", "emotion_overlay"}
                ]
            ),
        },
        "motions": {
            "count": len(motions),
            "parameter_driver_component_count": int(
                parameter_action_library.get("summary", {}).get("driver_component_count") or 0
            ),
            "base_action_atom_count": int(
                base_action_library.get("summary", {}).get("selected_atom_count") or 0
            ),
            "parameter_action_atom_count": int(
                parameter_action_library.get("summary", {}).get("selected_atom_count") or 0
            ),
        },
        "engine": {
            "recommended_mode": str(engine_hints.get("recommended_mode") or ""),
            "available_channels": list(engine_hints.get("available_channels", [])),
        },
        "adaptive_parameter_profile": {
            "schema_version": str(adaptive_parameter_profile.get("schema_version") or ""),
            "summary": dict(adaptive_parameter_profile.get("summary") or {}),
            "runtime_summary": dict(adaptive_parameter_profile.get("runtime_summary") or {}),
        },
        "calibration_profile": {
            "schema_version": str(calibration_profile.get("schema_version") or ""),
            "axis_count": len(
                [
                    axis_name
                    for axis_name, payload in (calibration_profile.get("axes") or {}).items()
                    if str(axis_name).strip() and isinstance(payload, dict)
                ]
            ),
        },
    }


def _round_float(value: Any) -> float:
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return 0.0


def _normalize_component_windows(raw_windows: Any) -> list[dict[str, float]]:
    if not isinstance(raw_windows, list) or not raw_windows:
        return [{"start_ratio": 0.0, "end_ratio": 1.0}]

    normalized: list[dict[str, float]] = []
    for item in raw_windows:
        if not isinstance(item, dict):
            continue
        start_ratio = _clamp_ratio(item.get("start_ratio"))
        end_ratio = _clamp_ratio(item.get("end_ratio"))
        if end_ratio < start_ratio:
            start_ratio, end_ratio = end_ratio, start_ratio
        normalized.append(
            {
                "start_ratio": round(start_ratio, 4),
                "end_ratio": round(end_ratio, 4),
            }
        )

    if not normalized:
        return [{"start_ratio": 0.0, "end_ratio": 1.0}]
    return normalized


def _score_parameter_action_candidate(
    *,
    component: dict[str, Any],
    window_duration_ratio: float,
) -> float:
    strength_score = {
        "none": 0.0,
        "low": 0.35,
        "medium": 0.7,
        "high": 1.0,
    }.get(str(component.get("strength") or "none"), 0.0)
    trait_score = {
        "oscillate": 1.0,
        "sustain": 0.95,
        "pulse": 0.82,
        "ramp": 0.72,
        "hold": 0.65,
    }.get(str(component.get("trait") or "unknown"), 0.6)

    return round(
        (float(component.get("energy_score") or 0.0) * 0.55)
        + (float(component.get("active_ratio") or 0.0) * 0.2)
        + (window_duration_ratio * 0.1)
        + (strength_score * 0.1)
        + (trait_score * 0.05),
        4,
    )


def _window_bucket_key(window_duration_ratio: float) -> str:
    if window_duration_ratio >= 0.66:
        return "long"
    if window_duration_ratio >= 0.33:
        return "medium"
    return "short"


def _select_parameter_action_candidates(
    *,
    candidates: list[dict[str, Any]],
    max_atoms: int,
) -> list[dict[str, Any]]:
    if not candidates or max_atoms <= 0:
        return []

    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for candidate in candidates:
        grouped[
            (
                str(candidate.get("polarity") or ""),
                str(candidate.get("trait") or ""),
                _window_bucket_key(float(candidate.get("window_duration_ratio") or 0.0)),
            )
        ].append(candidate)

    selected: list[dict[str, Any]] = []
    selected_component_windows: set[tuple[str, int]] = set()
    per_bucket_limit = 2 if max_atoms >= 12 else 1

    for bucket in sorted(grouped.keys()):
        bucket_candidates = sorted(
            grouped[bucket],
            key=lambda item: (
                -float(item.get("score") or 0.0),
                -float(item.get("component", {}).get("energy_score") or 0.0),
                str(item.get("component", {}).get("id") or ""),
                int(item.get("window_index") or 0),
            ),
        )
        for candidate in bucket_candidates[:per_bucket_limit]:
            key = (
                str(candidate.get("component", {}).get("id") or ""),
                int(candidate.get("window_index") or 0),
            )
            if key in selected_component_windows:
                continue
            selected.append(candidate)
            selected_component_windows.add(key)

    if len(selected) < max_atoms:
        sorted_candidates = sorted(
            candidates,
            key=lambda item: (
                -float(item.get("score") or 0.0),
                -float(item.get("component", {}).get("energy_score") or 0.0),
                str(item.get("component", {}).get("id") or ""),
                int(item.get("window_index") or 0),
            ),
        )
        for candidate in sorted_candidates:
            key = (
                str(candidate.get("component", {}).get("id") or ""),
                int(candidate.get("window_index") or 0),
            )
            if key in selected_component_windows:
                continue
            selected.append(candidate)
            selected_component_windows.add(key)
            if len(selected) >= max_atoms:
                break

    return sorted(
        selected[:max_atoms],
        key=lambda item: (
            -float(item.get("score") or 0.0),
            -float(item.get("component", {}).get("energy_score") or 0.0),
            str(item.get("component", {}).get("id") or ""),
            int(item.get("window_index") or 0),
        ),
    )


def _build_parameter_action_atom(
    *,
    candidate: dict[str, Any],
    parameter_entry: dict[str, Any],
    rank: int,
) -> dict[str, Any]:
    component = candidate["component"]
    motion = candidate["motion"]
    parameter_id = str(candidate["parameter_id"])
    trait = str(candidate.get("trait") or "unknown")
    polarity = str(candidate.get("polarity") or "neutral")
    window_index = int(candidate.get("window_index") or 0)
    atom_id = f"{parameter_id}.{polarity}.{trait}.w{window_index:02d}.{rank:02d}"
    channels = list(candidate.get("channels", []))

    return {
        "id": atom_id,
        "name": f"{parameter_id}_{polarity}_{trait}_w{window_index:02d}",
        "label": f"{parameter_id} {polarity} {trait} w{window_index}",
        "parameter_id": parameter_id,
        "parameter_name": str(parameter_entry.get("name") or component.get("parameter_name") or "").strip(),
        "group_name": str(parameter_entry.get("group_name") or component.get("group_name") or "").strip(),
        "kind": str(parameter_entry.get("kind") or component.get("kind") or "unknown"),
        "domain": str(parameter_entry.get("domain") or component.get("domain") or "other"),
        "channels": channels,
        "primary_channel": str(candidate.get("primary_channel") or ""),
        "polarity": polarity,
        "semantic_polarity": str(candidate.get("semantic_polarity") or polarity),
        "trait": trait,
        "strength": str(candidate.get("strength") or "none"),
        "score": round(float(candidate.get("score") or 0.0), 4),
        "source_component_id": str(component.get("id") or "").strip(),
        "source_motion": str(component.get("source_motion") or "").strip(),
        "source_file": str(component.get("source_file") or "").strip(),
        "source_group": str(component.get("source_group") or "").strip(),
        "source_category": str(component.get("source_category") or "").strip(),
        "source_tags": list(motion.get("catalog_tags", [])),
        "duration": round(float(component.get("duration") or 0.0), 4),
        "fps": round(float(component.get("fps") or 0.0), 3),
        "loop": bool(component.get("loop")),
        "energy_score": round(float(component.get("energy_score") or 0.0), 4),
        "peak_abs_value": round(float(component.get("peak_abs_value") or 0.0), 4),
        "peak_time_ratio": round(float(component.get("peak_time_ratio") or 0.0), 4),
        "active_ratio": round(float(component.get("active_ratio") or 0.0), 4),
        "intensity": str(motion.get("catalog_intensity") or "").strip(),
        "window_index": window_index,
        "window_start_ratio": round(float(candidate.get("window_start_ratio") or 0.0), 4),
        "window_end_ratio": round(float(candidate.get("window_end_ratio") or 0.0), 4),
        "window_duration_ratio": round(float(candidate.get("window_duration_ratio") or 0.0), 4),
    }


def _clamp_ratio(value: Any) -> float:
    try:
        normalized = float(value)
    except (TypeError, ValueError):
        normalized = 0.0
    return max(min(normalized, 1.0), 0.0)


def _collect_base_action_candidates(
    *,
    motions: list[dict[str, Any]],
    channel_name: str,
    primary_parameter_id: str,
    expected_domain: str,
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for motion in motions:
        for component in motion.get("components", []):
            if not isinstance(component, dict):
                continue
            if component.get("engine_role") != "driver":
                continue
            if channel_name not in component.get("channels", []):
                continue
            if str(component.get("domain") or "").strip() != expected_domain:
                continue
            if str(component.get("strength") or "").strip() == "none":
                continue

            channel_purity = 1.0 / max(len(component.get("channels", [])), 1)
            primary_parameter_match = bool(
                primary_parameter_id
                and str(component.get("parameter_id") or "").strip() == primary_parameter_id
            )
            score = _score_base_action_candidate(
                component=component,
                primary_parameter_match=primary_parameter_match,
                channel_purity=channel_purity,
            )
            polarity = _infer_base_action_polarity(component=component, channel_name=channel_name)
            candidates.append(
                {
                    "component": component,
                    "motion": motion,
                    "score": score,
                    "channel_purity": round(channel_purity, 4),
                    "primary_parameter_match": primary_parameter_match,
                    "polarity": polarity,
                    "semantic_polarity": _map_semantic_polarity(
                        channel_name=channel_name,
                        polarity=polarity,
                    ),
                }
            )

    return sorted(
        candidates,
        key=lambda item: (
            -float(item["score"]),
            -float(item["component"].get("energy_score") or 0.0),
            str(item["component"].get("id") or ""),
        ),
    )


def _select_base_action_candidates(
    *,
    candidates: list[dict[str, Any]],
    max_atoms: int,
) -> list[dict[str, Any]]:
    if not candidates or max_atoms <= 0:
        return []

    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for candidate in candidates:
        component = candidate["component"]
        grouped[(candidate["polarity"], str(component.get("trait") or "unknown"))].append(candidate)

    selected: list[dict[str, Any]] = []
    selected_ids: set[str] = set()
    per_bucket_limit = 2 if max_atoms >= 5 else 1

    for bucket in sorted(grouped.keys()):
        for candidate in grouped[bucket][:per_bucket_limit]:
            component_id = str(candidate["component"].get("id") or "")
            if component_id in selected_ids:
                continue
            selected.append(candidate)
            selected_ids.add(component_id)

    if len(selected) < max_atoms:
        for candidate in candidates:
            component_id = str(candidate["component"].get("id") or "")
            if component_id in selected_ids:
                continue
            selected.append(candidate)
            selected_ids.add(component_id)
            if len(selected) >= max_atoms:
                break

    return sorted(
        selected[:max_atoms],
        key=lambda item: (
            -float(item["score"]),
            -float(item["component"].get("energy_score") or 0.0),
            str(item["component"].get("id") or ""),
        ),
    )


def _build_base_action_atom(
    *,
    spec: dict[str, Any],
    standard_entry: dict[str, Any],
    candidate: dict[str, Any],
    rank: int,
) -> dict[str, Any]:
    component = candidate["component"]
    motion = candidate["motion"]
    polarity = str(candidate["polarity"])
    semantic_polarity = str(candidate["semantic_polarity"])
    trait = str(component.get("trait") or "unknown")
    atom_id = f"{spec['name']}.{polarity}.{trait}.{rank:02d}"

    return {
        "id": atom_id,
        "name": f"{spec['name']}_{semantic_polarity}_{trait}",
        "label": f"{spec['label']} {semantic_polarity} {trait}",
        "channel": spec["name"],
        "channel_label": spec["label"],
        "family": spec["family"],
        "family_label": spec["family_label"],
        "domain": spec["domain"],
        "polarity": polarity,
        "semantic_polarity": semantic_polarity,
        "trait": trait,
        "strength": str(component.get("strength") or "none"),
        "score": round(float(candidate["score"]), 4),
        "primary_parameter_match": bool(candidate["primary_parameter_match"]),
        "channel_purity": float(candidate["channel_purity"]),
        "primary_parameter_id": str(standard_entry.get("primary_parameter_id") or "").strip(),
        "parameter_id": str(component.get("parameter_id") or "").strip(),
        "parameter_name": str(component.get("parameter_name") or "").strip(),
        "group_name": str(component.get("group_name") or "").strip(),
        "source_component_id": str(component.get("id") or "").strip(),
        "source_motion": str(component.get("source_motion") or "").strip(),
        "source_file": str(component.get("source_file") or "").strip(),
        "source_group": str(component.get("source_group") or "").strip(),
        "source_category": str(component.get("source_category") or "").strip(),
        "source_tags": list(motion.get("catalog_tags", [])),
        "duration": round(float(component.get("duration") or 0.0), 4),
        "fps": round(float(component.get("fps") or 0.0), 3),
        "loop": bool(component.get("loop")),
        "energy_score": round(float(component.get("energy_score") or 0.0), 4),
        "peak_abs_value": round(float(component.get("peak_abs_value") or 0.0), 4),
        "peak_time_ratio": round(float(component.get("peak_time_ratio") or 0.0), 4),
        "active_ratio": round(float(component.get("active_ratio") or 0.0), 4),
        "intensity": str(motion.get("catalog_intensity") or "").strip(),
    }


def _score_base_action_candidate(
    *,
    component: dict[str, Any],
    primary_parameter_match: bool,
    channel_purity: float,
) -> float:
    strength_score = {
        "none": 0.0,
        "low": 0.35,
        "medium": 0.7,
        "high": 1.0,
    }.get(str(component.get("strength") or "none"), 0.0)
    trait_score = {
        "oscillate": 1.0,
        "sustain": 0.95,
        "pulse": 0.82,
        "ramp": 0.72,
        "hold": 0.65,
    }.get(str(component.get("trait") or "unknown"), 0.6)
    loop_bonus = (
        0.08
        if bool(component.get("loop")) and str(component.get("domain") or "") == "breath"
        else 0.0
    )
    return round(
        (float(component.get("energy_score") or 0.0) * 0.45)
        + (channel_purity * 0.2)
        + ((1.0 if primary_parameter_match else 0.0) * 0.2)
        + (strength_score * 0.1)
        + (trait_score * 0.05)
        + loop_bonus,
        4,
    )


def _infer_base_action_polarity(
    *,
    component: dict[str, Any],
    channel_name: str,
) -> str:
    if channel_name == "breath":
        return "cyclical"

    value_profile = component.get("value_profile", {})
    baseline = float(value_profile.get("baseline") or 0.0)
    positive_delta = max(float(value_profile.get("max") or 0.0) - baseline, 0.0)
    negative_delta = max(baseline - float(value_profile.get("min") or 0.0), 0.0)

    if positive_delta <= 0.03 and negative_delta <= 0.03:
        return "neutral"
    if positive_delta >= max(negative_delta * 1.25, 0.04):
        return "positive"
    if negative_delta >= max(positive_delta * 1.25, 0.04):
        return "negative"
    return "balanced"


def _map_semantic_polarity(*, channel_name: str, polarity: str) -> str:
    if polarity in {"neutral", "balanced", "cyclical"}:
        return {
            "neutral": "neutral",
            "balanced": "balanced",
            "cyclical": "cycle",
        }[polarity]

    if channel_name.startswith("eye_open") or channel_name == "mouth_open":
        return "open_more" if polarity == "positive" else "close_more"
    if channel_name.startswith("eye_smile") or channel_name == "mouth_smile":
        return "smile_more" if polarity == "positive" else "smile_less"
    return polarity


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
