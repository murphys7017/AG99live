from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from astrbot.api import logger

LIVE2D_RUNTIME_CACHE_SCHEMA_VERSION = "live2d_runtime_cache.v1"
LIVE2D_MODEL_METADATA_DIRNAME = "ag99"


def build_live2d_directory_md5(live2ds_dir: Path) -> str:
    digest = hashlib.md5()
    digest.update(str(live2ds_dir.resolve()).encode("utf-8", errors="ignore"))

    if not live2ds_dir.exists():
        digest.update(b"<missing>")
        return digest.hexdigest()

    for entry in sorted(live2ds_dir.rglob("*")):
        relative_path = entry.relative_to(live2ds_dir).as_posix()
        if (
            f"/{LIVE2D_MODEL_METADATA_DIRNAME}/" in f"/{relative_path}/"
            or relative_path.endswith(f"/{LIVE2D_MODEL_METADATA_DIRNAME}")
        ):
            continue
        digest.update(relative_path.encode("utf-8", errors="ignore"))
        if entry.is_dir():
            digest.update(b"<dir>")
            continue
        if not entry.is_file():
            continue

        stat = entry.stat()
        digest.update(str(stat.st_size).encode("utf-8"))
        with entry.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)

    return digest.hexdigest()


def _normalize_expression_example_overrides(
    raw: Any,
) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise ValueError("expression_example_overrides_not_list")
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"expression_example_override_not_object:index={index}")
        model_name = str(item.get("model_name") or "").strip()
        if not model_name:
            raise ValueError(f"expression_example_override_model_name_required:index={index}")
        example_id = str(item.get("example_id") or "").strip()
        if not example_id:
            raise ValueError(f"expression_example_override_example_id_required:index={index}")
        enabled = item.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError(f"expression_example_override_enabled_must_be_boolean:index={index}")
        feedback = item.get("feedback", "")
        if not isinstance(feedback, str):
            raise ValueError(f"expression_example_override_feedback_must_be_string:index={index}")
        tags = item.get("tags", [])
        if not isinstance(tags, list):
            raise ValueError(f"expression_example_override_tags_must_be_list:index={index}")
        normalized_tags: list[str] = []
        for tag_index, tag in enumerate(tags):
            if not isinstance(tag, str):
                raise ValueError(
                    "expression_example_override_tag_must_be_string"
                    f":index={index}:tag_index={tag_index}"
                )
            normalized_tag = tag.strip()
            if normalized_tag:
                normalized_tags.append(normalized_tag)
        updated_at = item.get("updated_at", "")
        if not isinstance(updated_at, str):
            raise ValueError(f"expression_example_override_updated_at_must_be_string:index={index}")
        normalized.append({
            "model_name": model_name,
            "example_id": example_id,
            "enabled": enabled,
            "feedback": feedback.strip(),
            "tags": normalized_tags,
            "updated_at": updated_at.strip(),
        })
    return normalized


def load_live2d_runtime_cache(cache_path: Path) -> tuple[dict[str, Any], dict[str, str]]:
    if not cache_path.exists():
        return _build_empty_cache_payload(), {}

    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Failed to load Live2D runtime cache `%s`: %s", cache_path, exc)
        return _build_empty_cache_payload(), {
            "root": f"live2d_runtime_cache_load_failed: {exc}"
        }

    if not isinstance(payload, dict):
        return _build_empty_cache_payload(), {
            "root": "live2d_runtime_cache_invalid_payload"
        }
    if str(payload.get("schema_version") or "") != LIVE2D_RUNTIME_CACHE_SCHEMA_VERSION:
        return _build_empty_cache_payload(), {
            "root": "live2d_runtime_cache_schema_version_mismatch"
        }

    scan_cache = payload.get("scan_cache")
    action_filter_cache = payload.get("action_filter_cache")
    motion_tuning_samples = payload.get("motion_tuning_samples")
    expression_example_overrides_raw = payload.get("expression_example_overrides")

    errors: dict[str, str] = {}
    normalized_scan_cache = scan_cache if isinstance(scan_cache, dict) else {}
    normalized_action_filter_cache = action_filter_cache if isinstance(action_filter_cache, dict) else {}
    normalized_motion_tuning_samples = (
        motion_tuning_samples if isinstance(motion_tuning_samples, list) else []
    )
    normalized_expression_example_overrides: list[dict[str, Any]] = []
    if "expression_example_overrides" in payload:
        try:
            normalized_expression_example_overrides = _normalize_expression_example_overrides(
                expression_example_overrides_raw
            )
        except ValueError as exc:
            errors["expression_example_overrides"] = (
                "live2d_runtime_cache_expression_example_overrides_invalid"
                f": {exc}"
            )
    if not isinstance(scan_cache, dict):
        errors["scan_cache"] = "live2d_runtime_cache_scan_cache_invalid"
    if not isinstance(action_filter_cache, dict):
        errors["action_filter_cache"] = "live2d_runtime_cache_action_filter_cache_invalid"
    if "motion_tuning_samples" in payload and not isinstance(motion_tuning_samples, list):
        errors["motion_tuning_samples"] = "live2d_runtime_cache_motion_tuning_samples_invalid"
    return (
        {
            "schema_version": LIVE2D_RUNTIME_CACHE_SCHEMA_VERSION,
            "scan_cache": normalized_scan_cache,
            "action_filter_cache": normalized_action_filter_cache,
            "motion_tuning_samples": normalized_motion_tuning_samples,
            "expression_example_overrides": normalized_expression_example_overrides,
        },
        errors,
    )


def save_live2d_runtime_cache(cache_path: Path, payload: dict[str, Any]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    normalized_payload = {
        "schema_version": LIVE2D_RUNTIME_CACHE_SCHEMA_VERSION,
        "scan_cache": payload.get("scan_cache") if isinstance(payload.get("scan_cache"), dict) else {},
        "action_filter_cache": (
            payload.get("action_filter_cache")
            if isinstance(payload.get("action_filter_cache"), dict)
            else {}
        ),
        "motion_tuning_samples": (
            payload.get("motion_tuning_samples")
            if isinstance(payload.get("motion_tuning_samples"), list)
            else []
        ),
        "expression_example_overrides": _normalize_expression_example_overrides(
            payload.get("expression_example_overrides", [])
        ),
    }
    temp_path = cache_path.with_suffix(f"{cache_path.suffix}.tmp")
    temp_path.write_text(
        json.dumps(normalized_payload, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    temp_path.replace(cache_path)


def _build_empty_cache_payload() -> dict[str, Any]:
    return {
        "schema_version": LIVE2D_RUNTIME_CACHE_SCHEMA_VERSION,
        "scan_cache": {},
        "action_filter_cache": {},
        "motion_tuning_samples": [],
        "expression_example_overrides": [],
    }
