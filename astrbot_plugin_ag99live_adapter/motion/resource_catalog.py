from __future__ import annotations

import re
from typing import Any


def build_motion_resource_candidates(
    *,
    runtime_state: Any,
) -> list[dict[str, Any]]:
    model = _resolve_selected_model_payload(runtime_state)
    constraints = model.get("constraints") if isinstance(model, dict) else None
    if not isinstance(constraints, dict):
        return []

    candidates: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for item in constraints.get("motions") or []:
        _append_catalog_resource_candidate(
            candidates,
            seen_ids,
            item,
            resource_type="motion",
        )
    for item in constraints.get("expressions") or []:
        _append_catalog_resource_candidate(
            candidates,
            seen_ids,
            item,
            resource_type="expression",
        )

    candidates.sort(key=_score_resource_candidate)
    return candidates


def validate_motion_resource_id(
    resource_id: Any,
    *,
    candidates: list[dict[str, Any]],
) -> str:
    normalized = normalize_resource_id(resource_id)
    if not normalized:
        return ""
    candidate_ids = {
        normalize_resource_id(candidate.get("resource_id")).lower()
        for candidate in candidates
        if isinstance(candidate, dict)
    }
    if normalized.lower() in candidate_ids:
        return normalized
    return ""


def normalize_resource_id(value: Any) -> str:
    return str(value or "").strip()


def _append_catalog_resource_candidate(
    candidates: list[dict[str, Any]],
    seen_ids: set[str],
    item: Any,
    *,
    resource_type: str,
) -> None:
    if not isinstance(item, dict):
        return
    if not _is_exposed_resource(item):
        return
    resource_id = _normalize_catalog_id(
        item.get("catalog_id")
        or item.get("id")
        or item.get("catalog_label")
        or item.get("name")
        or item.get("file")
    )
    if not resource_id or resource_id in seen_ids:
        return
    seen_ids.add(resource_id)
    candidates.append(
        {
            "resource_id": resource_id,
            "resource_type": resource_type,
            "label": str(
                item.get("catalog_label") or item.get("label") or item.get("name") or resource_id
            ).strip(),
            "description": str(
                item.get("catalog_description") or item.get("description") or ""
            ).strip(),
            "tags": _text_list(item.get("catalog_tags") or item.get("tags"), limit=8),
            "emotion_bias": _text_list(
                item.get("catalog_emotion_bias") or item.get("emotion_bias"),
                limit=6,
            ),
            "recommended_scenarios": _text_list(
                item.get("recommended_scenarios"),
                limit=6,
            ),
            "intensity": str(
                item.get("catalog_intensity") or item.get("intensity") or ""
            ).strip(),
            "file": str(item.get("file") or "").strip().replace("\\", "/"),
        }
    )


def _is_exposed_resource(item: dict[str, Any]) -> bool:
    return bool(
        item.get("catalog_expose_as_resource")
        or item.get("expose_as_resource")
        or item.get("is_resource")
    )


def _score_resource_candidate(item: dict[str, Any]) -> tuple[int, int, str]:
    metadata_score = 0
    if str(item.get("description") or "").strip():
        metadata_score += 3
    if _text_list(item.get("recommended_scenarios"), limit=1):
        metadata_score += 2
    if _text_list(item.get("tags"), limit=1):
        metadata_score += 2
    if _text_list(item.get("emotion_bias"), limit=1):
        metadata_score += 1
    type_score = 0 if item.get("resource_type") == "expression" else 1
    return (-metadata_score, type_score, str(item.get("resource_id") or ""))


def _text_list(value: Any, *, limit: int) -> list[str]:
    if isinstance(value, str):
        raw_items: list[Any] = [value]
    elif isinstance(value, list):
        raw_items = value
    else:
        raw_items = []
    result: list[str] = []
    seen: set[str] = set()
    for raw_item in raw_items:
        text = str(raw_item or "").strip()
        if not text:
            continue
        for piece in re.split(r"[,，、/|]+", text):
            normalized = piece.strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            result.append(normalized)
            if len(result) >= limit:
                return result
    return result


def _normalize_catalog_id(value: Any) -> str:
    normalized = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff]+", "_", str(value or "").strip())
    return normalized.strip("_")[:64]


def _resolve_selected_model_payload(runtime_state: Any) -> dict[str, Any]:
    model_info = getattr(runtime_state, "model_info", None)
    if not isinstance(model_info, dict):
        return {}
    selected_model = str(model_info.get("selected_model") or "").strip()
    models = model_info.get("models")
    if not isinstance(models, list):
        return {}
    for model in models:
        if not isinstance(model, dict):
            continue
        if selected_model and str(model.get("name") or "").strip() != selected_model:
            continue
        return model
    return {}
