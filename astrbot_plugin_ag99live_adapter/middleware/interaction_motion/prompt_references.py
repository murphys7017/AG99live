from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from ...motion.payload_validation import (
    describe_axis_descriptors,
    build_prompt_axis_lookup,
)
from ...protocol.schema_versions import MOTION_INTENT_V4_SCHEMA_VERSION

def _project_reference_examples_for_prompt(
    examples: list[Any],
    *,
    allowed_axis_ids: set[str],
    available_levels_by_axis: dict[str, set[int]],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in examples:
        if not isinstance(item, dict):
            raise ValueError("motion_reference_example_shape_invalid")
        input_text = str(item.get("input") or "").strip()
        output = item.get("output")
        if not input_text or not isinstance(output, dict):
            raise ValueError("motion_reference_example_shape_invalid")
        raw_intent_tags = output.get("intent_tags")
        if not isinstance(raw_intent_tags, list):
            raise ValueError("motion_reference_example_intent_tags_invalid")
        if any(not isinstance(tag, str) for tag in raw_intent_tags):
            raise ValueError("motion_reference_example_intent_tags_invalid")
        intent_tags = [tag.strip() for tag in raw_intent_tags if tag.strip()]
        if (
            not 1 <= len(intent_tags) <= 6
            or len(set(intent_tags)) != len(intent_tags)
            or any(len(tag) > 48 for tag in intent_tags)
        ):
            raise ValueError("motion_reference_example_intent_tags_invalid")
        has_axis_levels = "axis_levels" in output
        has_motion_steps = "motion_steps" in output
        has_motion_resource = "motion_resource_id" in output
        if sum((has_axis_levels, has_motion_steps, has_motion_resource)) != 1:
            raise ValueError("motion_reference_example_motion_shape_invalid")
        projected_output: dict[str, Any] = {
            "intent_tags": intent_tags,
        }
        duration_hint_ms = output.get("duration_hint_ms")
        if (
            isinstance(duration_hint_ms, int)
            and not isinstance(duration_hint_ms, bool)
            and 320 <= duration_hint_ms <= 15000
        ):
            projected_output["duration_hint_ms"] = duration_hint_ms
        elif duration_hint_ms is not None:
            raise ValueError("motion_reference_example_duration_invalid")
        expression_resource_id = output.get("expression_resource_id")
        motion_resource_id = output.get("motion_resource_id")
        if expression_resource_id is not None and (
            not isinstance(expression_resource_id, str)
            or not expression_resource_id.strip()
            or len(expression_resource_id.strip()) > 160
        ):
            raise ValueError("motion_reference_example_expression_resource_invalid")
        if motion_resource_id is not None and (
            not isinstance(motion_resource_id, str)
            or not motion_resource_id.strip()
            or len(motion_resource_id.strip()) > 160
        ):
            raise ValueError("motion_reference_example_motion_resource_invalid")
        if expression_resource_id and motion_resource_id:
            raise ValueError("motion_reference_example_resource_conflict")
        if expression_resource_id:
            projected_output["expression_resource_id"] = expression_resource_id.strip()
        if motion_resource_id:
            projected_output["motion_resource_id"] = motion_resource_id.strip()
        if motion_resource_id:
            if expression_resource_id:
                raise ValueError("motion_reference_example_resource_conflict")
            result.append({"input": input_text, "output": projected_output})
            continue
        axis_levels = (
            _project_example_axis_levels(
                output.get("axis_levels"),
                allowed_axis_ids=allowed_axis_ids,
                available_levels_by_axis=available_levels_by_axis,
            )
            if has_axis_levels
            else {}
        )
        if axis_levels:
            projected_output["axis_levels"] = axis_levels
        else:
            motion_steps = output.get("motion_steps")
            projected_steps: list[dict[str, Any]] = []
            if isinstance(motion_steps, list) and 2 <= len(motion_steps) <= 4:
                for step in motion_steps:
                    if not isinstance(step, dict):
                        raise ValueError("motion_reference_example_step_invalid")
                    step_levels = _project_example_axis_levels(
                        step.get("axis_levels"),
                        allowed_axis_ids=allowed_axis_ids,
                        available_levels_by_axis=available_levels_by_axis,
                    )
                    if not step_levels:
                        projected_steps = []
                        break
                    duration_weight = step.get("duration_weight")
                    if (
                        not isinstance(duration_weight, int)
                        or isinstance(duration_weight, bool)
                        or not 1 <= duration_weight <= 3
                    ):
                        raise ValueError("motion_reference_example_step_invalid")
                    projected_steps.append(
                        {
                            "axis_levels": step_levels,
                            "duration_weight": duration_weight,
                        }
                    )
            elif motion_steps is not None:
                raise ValueError("motion_reference_example_steps_invalid")
            if projected_steps:
                projected_output["motion_steps"] = projected_steps
            else:
                continue
        result.append({"input": input_text, "output": projected_output})
    return result

def _project_example_axis_levels(
    value: Any,
    *,
    allowed_axis_ids: set[str],
    available_levels_by_axis: dict[str, set[int]],
) -> dict[str, int]:
    if not isinstance(value, dict):
        raise ValueError("motion_reference_example_axis_levels_invalid")
    result: dict[str, int] = {}
    for axis_id, level in value.items():
        normalized_axis_id = str(axis_id).strip()
        if normalized_axis_id not in allowed_axis_ids:
            continue
        if (
            not isinstance(level, int)
            or isinstance(level, bool)
            or not -4 <= level <= 4
        ):
            raise ValueError(
                f"motion_reference_example_axis_level_invalid:{normalized_axis_id}"
            )
        if level not in available_levels_by_axis.get(normalized_axis_id, set()):
            raise ValueError(
                "motion_reference_example_axis_level_unavailable:"
                f"{normalized_axis_id}:{level}"
            )
        result[normalized_axis_id] = level
    return result

def _select_prompt_resource_candidates(
    resources: list[Any],
    *,
    limit_per_type: int = 8,
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    counts = {"expression": 0, "motion": 0}
    for item in resources:
        if not isinstance(item, dict):
            continue
        resource_type = str(item.get("resource_type") or "").strip()
        if resource_type not in counts or counts[resource_type] >= limit_per_type:
            continue
        counts[resource_type] += 1
        selected.append(item)
    return selected

def _build_official_inline_motion_intent_example(
    capability_payload: dict[str, Any],
) -> dict[str, Any]:
    semantic_profile = capability_payload.get("semantic_profile")
    intent: dict[str, Any] = {
        "schema_version": MOTION_INTENT_V4_SCHEMA_VERSION,
        "profile_id": "",
        "profile_revision": 1,
        "model_id": "",
        "mode": "expressive",
        "intent_tags": ["语气关键词", "姿态关键词", "场景关键词"],
        "duration_hint_ms": 1000,
        "axis_levels": {},
    }
    if isinstance(semantic_profile, dict):
        intent["profile_id"] = str(semantic_profile.get("profile_id") or "")
        profile_revision = semantic_profile.get("profile_revision")
        if isinstance(profile_revision, int) and profile_revision > 0:
            intent["profile_revision"] = profile_revision
        intent["model_id"] = str(semantic_profile.get("model_id") or "")
    if isinstance(semantic_profile, dict):
        prompt_axes = semantic_profile.get("prompt_axes")
        if isinstance(prompt_axes, list):
            intent["axis_levels"] = {
                str(axis.get("id") or "").strip(): _resolve_axis_example_level(
                    axis,
                    index=index,
                )
                for index, axis in enumerate(
                    _select_motion_format_example_axes(prompt_axes, limit=5)
                )
                if isinstance(axis, dict) and str(axis.get("id") or "").strip()
            }
    return intent

def _resolve_axis_example_level(axis: dict[str, Any], *, index: int) -> int:
    raw_levels = axis.get("available_levels")
    available_levels = {
        level
        for level in raw_levels
        if isinstance(level, int) and not isinstance(level, bool) and -4 <= level <= 4
    } if isinstance(raw_levels, list) else set(range(-4, 5))
    preferred = (3, -3, 2, -2, 1, -1, 0) if index % 2 == 0 else (-3, 3, -2, 2, -1, 1, 0)
    for level in preferred:
        if level in available_levels:
            return level
    raise ValueError("official_inline_example_axis_has_no_available_level")

def _build_prompt_pose_reference_candidates(
    pose_reference_candidates: list[dict[str, Any]],
    *,
    semantic_profile: dict[str, Any] | None = None,
    limit: int,
) -> list[dict[str, Any]]:
    axis_by_id = build_prompt_axis_lookup(semantic_profile)
    selected_candidates = _select_representative_pose_reference_candidates(
        pose_reference_candidates,
        axis_by_id=axis_by_id,
        limit=limit,
    )
    result: list[dict[str, Any]] = []
    for item in selected_candidates:
        pose_id = str(item.get("id") or "").strip()
        source = str(item.get("source") or "").strip()
        result.append(
            {
                "id": pose_id,
                "label": str(item.get("label") or pose_id).strip(),
                "emotion_label": str(item.get("emotion_label") or "").strip(),
                "description": _truncate_text(
                    str(item.get("description") or "").strip(),
                    96,
                ),
                "emotion_bias": _normalize_axis_text_list(item.get("emotion_bias"))[:4],
                "intensity": str(item.get("intensity") or "").strip(),
                "recommended_scenarios": _normalize_axis_text_list(
                    item.get("recommended_scenarios")
                )[:4],
                "pose_descriptors": describe_axis_descriptors(
                    item.get("axes"),
                    axis_by_id=axis_by_id,
                )[:4],
                "key_axis_levels": _summarize_key_axis_levels(
                    item.get("axes"),
                    axis_by_id=axis_by_id,
                    limit=5,
                ),
                "source": source,
            }
        )
    return result

def _select_representative_pose_reference_candidates(
    pose_reference_candidates: list[dict[str, Any]],
    *,
    axis_by_id: Mapping[str, dict[str, Any]] | None = None,
    limit: int,
) -> list[dict[str, Any]]:
    max_items = max(0, limit)
    if max_items <= 0:
        return []

    candidates = [
        item
        for item in pose_reference_candidates
        if _is_prompt_pose_reference_candidate(item)
    ]
    if not candidates:
        return []

    by_signature: dict[str, list[dict[str, Any]]] = {}
    for item in candidates:
        signature = _classify_prompt_pose_reference_signature(item, axis_by_id=axis_by_id)
        by_signature.setdefault(signature, []).append(item)

    for signature_candidates in by_signature.values():
        signature_candidates.sort(
            key=_score_prompt_pose_reference_candidate,
            reverse=True,
        )

    selected: list[dict[str, Any]] = []
    selected_ids: set[str] = set()
    ranked_signatures = sorted(
        by_signature.items(),
        key=lambda entry: _score_prompt_pose_reference_signature(entry[0], entry[1]),
        reverse=True,
    )
    for _signature, signature_candidates in ranked_signatures:
        if len(selected) >= max_items:
            break
        item = signature_candidates[0]
        candidate_id = str(item.get("id") or "").strip()
        if candidate_id in selected_ids:
            continue
        selected.append(item)
        selected_ids.add(candidate_id)

    if len(selected) < min(2, max_items):
        ranked = sorted(
            candidates,
            key=_score_prompt_pose_reference_candidate,
            reverse=True,
        )
        for item in ranked:
            if len(selected) >= min(2, max_items):
                break
            candidate_id = str(item.get("id") or "").strip()
            if candidate_id in selected_ids:
                continue
            selected.append(item)
            selected_ids.add(candidate_id)

    return selected[:max_items]

def _is_prompt_pose_reference_candidate(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    pose_id = str(item.get("id") or "").strip()
    if not pose_id:
        return False
    axes = item.get("axes")
    return isinstance(axes, dict) and bool(axes)

def _classify_prompt_pose_reference_signature(
    item: dict[str, Any],
    *,
    axis_by_id: Mapping[str, dict[str, Any]] | None = None,
) -> str:
    descriptors = describe_axis_descriptors(item.get("axes"), axis_by_id=axis_by_id)
    if descriptors:
        return "+".join(descriptors[:3])
    return "metadata:" + _normalize_prompt_pose_reference_metadata_signature(item)

def _normalize_prompt_pose_reference_metadata_signature(item: dict[str, Any]) -> str:
    for key in ("label", "emotion_label", "id"):
        value = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff]+", "_", str(item.get(key) or "").strip())
        if value:
            return value[:48]
    return "unknown"

def _score_prompt_pose_reference_signature(
    signature: str,
    candidates: list[dict[str, Any]],
) -> tuple[int, int, str]:
    descriptors = [part for part in signature.split("+") if part]
    descriptor_score = min(len(descriptors), 3) * 20
    skeleton_score = 0
    if any(part.startswith(("look_", "tilt_", "gaze_")) for part in descriptors):
        skeleton_score += 12
    if any(part.startswith(("body_", "lean_")) for part in descriptors):
        skeleton_score += 10
    if any("eye" in part or "mouth" in part or "brow" in part for part in descriptors):
        skeleton_score += 5
    best_candidate_score = max(
        (_score_prompt_pose_reference_candidate(item)[0] for item in candidates),
        default=0,
    )
    return descriptor_score + skeleton_score, best_candidate_score, signature

def _score_prompt_pose_reference_candidate(item: dict[str, Any]) -> tuple[int, int, int, str]:
    source = str(item.get("source") or "").strip()
    source_score = {
        "motion_tuning_sample": 90,
        "motion_catalog_semantic_extract": 80,
        "expression_parameter_extract": 70,
        "profile_binding_parameter_extract": 45,
    }.get(source, 40)
    intensity = str(item.get("intensity") or "").strip().lower()
    intensity_score = {
        "high": 30,
        "medium": 20,
        "low": 10,
    }.get(intensity, 0)
    axes = item.get("axes")
    axis_score = min(len(axes), 5) if isinstance(axes, dict) else 0
    label = str(item.get("label") or item.get("id") or "").strip()
    metadata_score = 0
    if str(item.get("description") or "").strip():
        metadata_score += 3
    if _normalize_axis_text_list(item.get("recommended_scenarios")):
        metadata_score += 2
    if _normalize_axis_text_list(item.get("emotion_bias")):
        metadata_score += 2
    return source_score + intensity_score + metadata_score, axis_score, len(label), label

def _select_motion_format_example_axes(
    prompt_axes: list[dict[str, Any]],
    *,
    limit: int,
) -> list[dict[str, Any]]:
    primary_axes = [
        axis
        for axis in prompt_axes
        if isinstance(axis, dict)
        and str(axis.get("control_role") or "").strip() == "primary"
    ]
    other_axes = [
        axis
        for axis in prompt_axes
        if isinstance(axis, dict)
        and str(axis.get("control_role") or "").strip() != "primary"
    ]
    return (primary_axes + other_axes)[: max(0, limit)]

def _truncate_text(value: str, max_length: int) -> str:
    normalized = str(value or "").strip()
    if max_length <= 0 or len(normalized) <= max_length:
        return normalized
    return normalized[: max(0, max_length - 1)].rstrip() + "…"

def _normalize_axis_text_list(value: Any) -> list[str]:
    if isinstance(value, str):
        items = re.split(r"[-,，、/|]+", value)
    elif isinstance(value, list):
        items = value
    else:
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in items:
        normalized = _truncate_text(str(item).strip(), 48)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result

def _summarize_key_axis_levels(
    value: Any,
    *,
    axis_by_id: Mapping[str, dict[str, Any]],
    limit: int,
) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, int] = {}
    for axis_id, axis_value in value.items():
        if len(result) >= limit:
            break
        if not isinstance(axis_value, (int, float)) or isinstance(axis_value, bool):
            continue
        normalized_axis_id = str(axis_id or "").strip()
        if not normalized_axis_id:
            continue
        axis = axis_by_id.get(normalized_axis_id)
        anchors = axis.get("level_anchors") if isinstance(axis, dict) else None
        if not isinstance(anchors, dict):
            continue
        numeric_anchors: list[tuple[int, float]] = []
        for raw_level, raw_anchor in anchors.items():
            try:
                level = int(raw_level)
                anchor = float(raw_anchor)
            except (TypeError, ValueError):
                continue
            if -4 <= level <= 4:
                numeric_anchors.append((level, anchor))
        if len(numeric_anchors) != 9:
            continue
        level, _anchor = min(
            numeric_anchors,
            key=lambda item: (abs(item[1] - float(axis_value)), abs(item[0])),
        )
        result[normalized_axis_id] = level
    return result
