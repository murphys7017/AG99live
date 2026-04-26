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


def load_live2d_runtime_cache(cache_path: Path) -> dict[str, Any]:
    if not cache_path.exists():
        return _build_empty_cache_payload()

    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Failed to load Live2D runtime cache `%s`: %s", cache_path, exc)
        return _build_empty_cache_payload()

    if not isinstance(payload, dict):
        return _build_empty_cache_payload()
    if str(payload.get("schema_version") or "") != LIVE2D_RUNTIME_CACHE_SCHEMA_VERSION:
        return _build_empty_cache_payload()

    scan_cache = payload.get("scan_cache")
    action_filter_cache = payload.get("action_filter_cache")
    return {
        "schema_version": LIVE2D_RUNTIME_CACHE_SCHEMA_VERSION,
        "scan_cache": scan_cache if isinstance(scan_cache, dict) else {},
        "action_filter_cache": action_filter_cache if isinstance(action_filter_cache, dict) else {},
    }


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
    }
