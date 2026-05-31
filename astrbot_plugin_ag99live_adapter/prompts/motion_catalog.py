from __future__ import annotations

from typing import Any


def resolve_motion_catalog_options(
    *,
    runtime_state: Any,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    model_payload = _resolve_selected_model_payload(runtime_state)
    if model_payload is None:
        return []
    return build_motion_catalog_options(model_payload=model_payload, limit=limit)


def build_motion_catalog_options(
    *,
    model_payload: dict[str, Any],
    limit: int | None = None,
) -> list[dict[str, Any]]:
    constraints = model_payload.get("constraints")
    motions = constraints.get("motions") if isinstance(constraints, dict) else None
    if not isinstance(motions, list):
        return []

    options: list[dict[str, Any]] = []
    for motion in motions:
        if not isinstance(motion, dict):
            continue
        file_value = str(motion.get("file") or "").strip().replace("\\", "/")
        group = str(motion.get("group") or "").strip()
        if not file_value or not group:
            continue
        index = _resolve_motion_group_index(motions, group=group, file_value=file_value)
        if index is None:
            continue
        motion_id = _resolve_motion_id(motion, file_value=file_value)
        label = str(motion.get("catalog_label") or motion.get("name") or motion_id).strip()
        duration = motion.get("duration")
        duration_ms = int(round(float(duration) * 1000)) if isinstance(duration, (int, float)) else None
        options.append(
            {
                "id": motion_id,
                "file": file_value,
                "group": group,
                "index": index,
                "label": label,
                "description": str(motion.get("catalog_description") or "").strip(),
                "tags": _text_list(motion.get("catalog_tags"), limit=6),
                "emotion_bias": _text_list(motion.get("catalog_emotion_bias"), limit=6),
                "intensity": str(motion.get("catalog_intensity") or "").strip(),
                "exclusive_with": _text_list(motion.get("catalog_exclusive_with"), limit=6),
                "scenarios": _text_list(motion.get("recommended_scenarios"), limit=6),
                "duration_ms": duration_ms,
                "priority": _resolve_catalog_priority(str(motion.get("catalog_intensity") or "")),
            }
        )

    options.sort(
        key=lambda item: (
            _intensity_sort_rank(str(item.get("intensity") or "")),
            str(item.get("label") or item.get("id") or ""),
        )
    )
    if limit is None:
        return options
    return options[: max(0, limit)]


def format_motion_catalog_options(
    options: list[dict[str, Any]],
    *,
    truncate_text: Any,
    limit: int | None = None,
) -> str:
    normalized = [item for item in options if isinstance(item, dict)]
    if not normalized:
        return ""

    selected = normalized if limit is None else normalized[: max(0, limit)]
    lines = [
        "可复用的现成 motion3 动画（如果完全匹配本轮语气，可以选择它；否则生成单帧姿态轴）：",
        "- 这些是已经制作好的完整动画，不要把它们拆成轴数值，也不要混合多个 motion。",
        "- 只有当标签、说明和适用场景明确贴合本轮回复时才选 catalog；不确定时选择 generate 并输出 axes。",
        "- 选择 catalog 时只返回 motion_id，不要再输出 axes。",
    ]
    for option in selected:
        motion_id = truncate_text(str(option.get("id") or "").strip(), 48)
        label = truncate_text(str(option.get("label") or motion_id).strip(), 32)
        intensity = str(option.get("intensity") or "").strip()
        tags = ", ".join(_text_list(option.get("tags"), limit=4))
        emotions = ", ".join(_text_list(option.get("emotion_bias"), limit=4))
        scenarios = ", ".join(_text_list(option.get("scenarios"), limit=4))
        description = truncate_text(str(option.get("description") or "").strip(), 80)
        context_parts = []
        if tags:
            context_parts.append(f"标签={tags}")
        if emotions:
            context_parts.append(f"情绪={emotions}")
        if intensity:
            context_parts.append(f"强度={intensity}")
        if scenarios:
            context_parts.append(f"适用={scenarios}")
        if description:
            context_parts.append(f"说明={description}")
        context = f"；{'；'.join(context_parts)}" if context_parts else ""
        lines.append(f"- motion_id={motion_id}；名称={label}{context}")
    return "\n".join(lines)


def find_motion_catalog_option(
    *,
    options: list[dict[str, Any]],
    motion_id: str,
) -> dict[str, Any] | None:
    normalized_id = str(motion_id or "").strip()
    if not normalized_id:
        return None
    for option in options:
        if not isinstance(option, dict):
            continue
        if str(option.get("id") or "").strip() == normalized_id:
            return option
    return None


def build_catalog_motion_payload(
    *,
    option: dict[str, Any],
    model_id: str,
    emotion_label: str,
) -> dict[str, Any]:
    duration_ms = option.get("duration_ms")
    if not isinstance(duration_ms, int):
        duration_ms = None
    priority = option.get("priority")
    if not isinstance(priority, int):
        priority = 3
    return {
        "schema_version": "engine.catalog_motion.v1",
        "model_id": model_id,
        "motion_id": str(option.get("id") or "").strip(),
        "group": str(option.get("group") or "").strip(),
        "index": int(option.get("index") or 0),
        "file": str(option.get("file") or "").strip(),
        "label": str(option.get("label") or "").strip(),
        "emotion_label": str(emotion_label or option.get("label") or option.get("id") or "").strip(),
        "duration_ms": duration_ms,
        "priority": priority,
    }


def _resolve_selected_model_payload(runtime_state: Any) -> dict[str, Any] | None:
    model_info = getattr(runtime_state, "model_info", None)
    if not isinstance(model_info, dict):
        return None
    selected_model = str(model_info.get("selected_model") or "").strip()
    models = model_info.get("models")
    if not selected_model or not isinstance(models, list):
        return None
    for model in models:
        if not isinstance(model, dict):
            continue
        if str(model.get("name") or "").strip() == selected_model:
            return model
    return None


def _resolve_motion_id(motion: dict[str, Any], *, file_value: str) -> str:
    label = str(motion.get("catalog_label") or motion.get("name") or "").strip()
    if label:
        return _slugify_motion_id(label)
    return _slugify_motion_id(file_value.rsplit("/", 1)[-1].removesuffix(".motion3.json"))


def _resolve_motion_group_index(
    motions: list[Any],
    *,
    group: str,
    file_value: str,
) -> int | None:
    index = 0
    for item in motions:
        if not isinstance(item, dict):
            continue
        item_group = str(item.get("group") or "").strip()
        if item_group != group:
            continue
        item_file = str(item.get("file") or "").strip().replace("\\", "/")
        if item_file == file_value:
            return index
        index += 1
    return None


def _slugify_motion_id(value: str) -> str:
    normalized = str(value or "").strip()
    result = []
    for char in normalized:
        if char.isalnum():
            result.append(char.lower())
        elif char in {"-", "_", " ", "/", "."}:
            result.append("_")
    slug = "".join(result).strip("_")
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug or "motion"


def _resolve_catalog_priority(intensity: str) -> int:
    normalized = str(intensity or "").strip().lower()
    if normalized == "high":
        return 4
    if normalized == "low":
        return 2
    return 3


def _intensity_sort_rank(intensity: str) -> int:
    normalized = str(intensity or "").strip().lower()
    if normalized == "high":
        return 0
    if normalized == "medium":
        return 1
    if normalized == "low":
        return 2
    return 3


def _text_list(value: Any, *, limit: int | None = None) -> list[str]:
    if not isinstance(value, list):
        return []
    result = [str(item).strip() for item in value if str(item).strip()]
    if limit is None:
        return result
    return result[: max(0, limit)]
