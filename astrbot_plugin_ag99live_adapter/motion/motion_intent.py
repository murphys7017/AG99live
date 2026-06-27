from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from typing import Any

from ..prompts.semantic_axis_prompt import profile_prompt_axes
from .performance_curve import normalize_performance_curve_hint

LOGGER = logging.getLogger(__name__)

MOTION_INTENT_SCHEMA_VERSION = "engine.motion_intent.v3"
MOTION_INTENT_V2_SCHEMA_VERSION = "engine.motion_intent.v2"
MOTION_INTENT_V3_SCHEMA_VERSION = "engine.motion_intent.v3"
PARAMETER_PLAN_V2_SCHEMA_VERSION = "engine.parameter_plan.v2"
DEFAULT_MOTION_INTENT_DURATION_MS = 1000
PARAMETER_PLAN_SOURCES = {
    "semantic_axis",
    "coupling",
    "speech_pose",
    "expression",
    "continuity",
    "manual",
}

_REPAIR_STATS_LOG_INTERVAL_SECONDS = 60.0
_MIN_EXPRESSIVE_MAX_DELTA = 24
_MIN_EXPRESSIVE_NONZERO_DELTA = 16


@dataclass(frozen=True, slots=True)
class MotionFallbackDecision:
    fallback_pose_id: str
    matched_candidate_id: str
    score: float
    fallback_missing: bool
    reasons: list[str]


_repair_stats: dict[str, int] = {}
_motion_outcome_stats: dict[str, int] = {}
_stats_revision = 0
_last_repair_stats_log_at = 0.0
_last_repair_stats_log_total = 0


def _bump_stats_revision() -> None:
    global _stats_revision
    _stats_revision += 1


def _incr_repair_stat(key: str) -> None:
    _repair_stats[key] = _repair_stats.get(key, 0) + 1
    _bump_stats_revision()


def _incr_motion_outcome_stat(key: str) -> None:
    _motion_outcome_stats[key] = _motion_outcome_stats.get(key, 0) + 1
    _bump_stats_revision()


def record_realtime_motion_attempt() -> None:
    _incr_motion_outcome_stat("attempt_total")


def record_realtime_motion_generated() -> None:
    _incr_motion_outcome_stat("generated_total")


def record_realtime_motion_fallback() -> None:
    _incr_motion_outcome_stat("fallback_total")


def get_repair_stats() -> dict[str, Any]:
    repair_event_total = sum(_repair_stats.values())
    attempt_total = _motion_outcome_stats.get("attempt_total", 0)
    fallback_total = _motion_outcome_stats.get("fallback_total", 0)
    return {
        "total": repair_event_total,
        "repair_event_total": repair_event_total,
        "counts": dict(_repair_stats),
        "motion_counts": dict(_motion_outcome_stats),
        "attempt_total": attempt_total,
        "generated_total": _motion_outcome_stats.get("generated_total", 0),
        "fallback_total": fallback_total,
        "stats_revision": _stats_revision,
        "fallback_rate": round(fallback_total / max(1, attempt_total), 3),
    }


def reset_repair_stats() -> None:
    global _last_repair_stats_log_at, _last_repair_stats_log_total, _stats_revision
    _repair_stats.clear()
    _motion_outcome_stats.clear()
    _stats_revision = 0
    _last_repair_stats_log_at = 0.0
    _last_repair_stats_log_total = 0


def maybe_log_repair_stats() -> None:
    global _last_repair_stats_log_at, _last_repair_stats_log_total
    stats = get_repair_stats()
    revision = int(stats.get("stats_revision") or 0)
    if revision <= 0 or revision == _last_repair_stats_log_total:
        return
    now = time.monotonic()
    if now - _last_repair_stats_log_at < _REPAIR_STATS_LOG_INTERVAL_SECONDS:
        return
    _last_repair_stats_log_at = now
    _last_repair_stats_log_total = revision
    LOGGER.info(
        "Motion intent stats: attempts=%s generated=%s fallback=%s fallback_rate=%s repair_events=%s repair_counts=%s",
        stats.get("attempt_total"),
        stats.get("generated_total"),
        stats.get("fallback_total"),
        stats.get("fallback_rate"),
        stats.get("repair_event_total"),
        stats.get("counts"),
    )


def resolve_selected_semantic_axis_profile(*, runtime_state: Any) -> dict[str, Any]:
    model_info = getattr(runtime_state, "model_info", {})
    if not isinstance(model_info, dict):
        raise RuntimeError("SemanticAxisProfile unavailable: runtime_state.model_info is not an object.")

    selected_model_name = str(model_info.get("selected_model") or "").strip()
    models = model_info.get("models")
    if not selected_model_name or not isinstance(models, list):
        raise RuntimeError("SemanticAxisProfile unavailable: selected model is not synchronized.")

    for model in models:
        if not isinstance(model, dict):
            continue
        if str(model.get("name") or "").strip() != selected_model_name:
            continue
        profile = model.get("semantic_axis_profile")
        if not isinstance(profile, dict):
            raise RuntimeError(
                f"SemanticAxisProfile unavailable for selected model `{selected_model_name}`."
            )
        schema_version = str(profile.get("schema_version") or "").strip()
        profile_id = str(profile.get("profile_id") or "").strip()
        model_id = str(profile.get("model_id") or "").strip()
        status = str(profile.get("status") or "").strip()
        revision = profile.get("revision")
        if schema_version != "ag99.semantic_axis_profile.v1":
            raise RuntimeError("SemanticAxisProfile invalid: unsupported schema_version.")
        if not profile_id or not model_id:
            raise RuntimeError("SemanticAxisProfile invalid: profile_id/model_id is empty.")
        if not isinstance(revision, int) or revision <= 0:
            raise RuntimeError("SemanticAxisProfile invalid: revision must be a positive integer.")
        if status == "stale":
            raise RuntimeError("SemanticAxisProfile is stale; rescan or save the profile before motion generation.")
        profile_prompt_axes(profile)
        return profile

    raise RuntimeError(
        f"SemanticAxisProfile unavailable: selected model `{selected_model_name}` is missing."
    )


def normalize_motion_intent_payload(intent: Any) -> dict[str, Any]:
    if not isinstance(intent, dict):
        raise ValueError("intent_not_object")

    schema_version = str(intent.get("schema_version") or "").strip()
    if schema_version == MOTION_INTENT_V2_SCHEMA_VERSION:
        return normalize_motion_intent_v2_payload(intent)
    if schema_version == MOTION_INTENT_V3_SCHEMA_VERSION:
        return normalize_motion_intent_v3_payload(intent)
    return normalize_motion_intent_v2_payload(intent)


def normalize_motion_intent_v2_payload(intent: Any) -> dict[str, Any]:
    if not isinstance(intent, dict):
        raise ValueError("intent_not_object")

    schema_version = str(intent.get("schema_version") or "").strip()
    if schema_version != MOTION_INTENT_V2_SCHEMA_VERSION:
        raise ValueError("invalid_schema_version")

    profile_id = str(intent.get("profile_id") or "").strip()
    model_id = str(intent.get("model_id") or "").strip()
    if not profile_id:
        raise ValueError("profile_id_empty")
    if not model_id:
        raise ValueError("model_id_empty")
    profile_revision_raw = intent.get("profile_revision")
    if not isinstance(profile_revision_raw, int) or profile_revision_raw <= 0:
        raise ValueError("profile_revision_invalid")

    mode = str(intent.get("mode") or "").strip().lower()
    if mode not in {"expressive", "idle"}:
        raise ValueError("invalid_mode")

    emotion_label = str(intent.get("emotion_label") or "").strip()
    if not emotion_label:
        raise ValueError("emotion_label_empty")

    axes = intent.get("axes")
    if not isinstance(axes, dict) or not axes:
        raise ValueError("axes_not_object")

    normalized_axes: dict[str, dict[str, float]] = {}
    for axis_id_raw, axis_payload in axes.items():
        axis_id = str(axis_id_raw or "").strip()
        if not axis_id:
            raise ValueError("axis_id_empty")
        if not isinstance(axis_payload, dict) or "value" not in axis_payload:
            raise ValueError(f"axis_payload_invalid:{axis_id}")
        value = axis_payload.get("value")
        if not isinstance(value, (int, float)):
            raise ValueError(f"axis_{axis_id}_value_not_number")
        if not float("-inf") < float(value) < float("inf"):
            raise ValueError(f"axis_{axis_id}_value_not_finite")
        normalized_axes[axis_id] = {"value": round(float(value), 4)}

    duration_hint_raw = intent.get("duration_hint_ms")
    duration_hint_ms: int | None = None
    if duration_hint_raw is not None:
        if not isinstance(duration_hint_raw, (int, float)):
            raise ValueError("duration_hint_ms_not_number")
        duration_hint_ms = int(round(float(duration_hint_raw)))
        if duration_hint_ms < 320 or duration_hint_ms > 15000:
            raise ValueError("duration_hint_ms_out_of_range")

    return {
        "schema_version": MOTION_INTENT_V2_SCHEMA_VERSION,
        "profile_id": profile_id,
        "profile_revision": profile_revision_raw,
        "model_id": model_id,
        "mode": mode,
        "emotion_label": emotion_label,
        "duration_hint_ms": duration_hint_ms,
        "axes": normalized_axes,
        "summary": {
            "axis_count": len(normalized_axes),
        },
    }


def normalize_motion_intent_v3_payload(intent: Any) -> dict[str, Any]:
    if not isinstance(intent, dict):
        raise ValueError("intent_not_object")

    schema_version = str(intent.get("schema_version") or "").strip()
    if schema_version != MOTION_INTENT_V3_SCHEMA_VERSION:
        raise ValueError("invalid_schema_version")

    profile_id = str(intent.get("profile_id") or "").strip()
    model_id = str(intent.get("model_id") or "").strip()
    if not profile_id:
        raise ValueError("profile_id_empty")
    if not model_id:
        raise ValueError("model_id_empty")
    profile_revision_raw = intent.get("profile_revision")
    if not isinstance(profile_revision_raw, int) or profile_revision_raw <= 0:
        raise ValueError("profile_revision_invalid")

    mode = str(intent.get("mode") or "expressive").strip().lower()
    if mode not in {"expressive", "idle"}:
        raise ValueError("invalid_mode")

    intent_tags = normalize_motion_intent_tags(intent.get("intent_tags"))
    if not intent_tags:
        raise ValueError("intent_tags_empty")
    emotion_label = derive_motion_emotion_label(intent_tags)
    resource_id = normalize_motion_resource_id(intent.get("resource_id"))

    axes = intent.get("axes")
    if not isinstance(axes, dict) or not axes:
        raise ValueError("axes_not_object")

    normalized_axes: dict[str, float] = {}
    for axis_id_raw, axis_value in axes.items():
        axis_id = str(axis_id_raw or "").strip()
        if not axis_id:
            raise ValueError("axis_id_empty")
        if isinstance(axis_value, dict):
            raise ValueError(f"axis_payload_invalid:{axis_id}")
        value = _coerce_finite_number(axis_value)
        if value is None:
            raise ValueError(f"axis_{axis_id}_value_not_number")
        normalized_axes[axis_id] = round(value, 4)

    duration_hint_ms = _normalize_duration_hint_ms(intent.get("duration_hint_ms"))
    performance_curve_hint = None
    if "performance_curve_hint" in intent:
        try:
            performance_curve_hint = normalize_performance_curve_hint(
                intent.get("performance_curve_hint")
            )
        except ValueError:
            performance_curve_hint = None

    normalized_intent = {
        "schema_version": MOTION_INTENT_V3_SCHEMA_VERSION,
        "profile_id": profile_id,
        "profile_revision": profile_revision_raw,
        "model_id": model_id,
        "mode": mode,
        "intent_tags": intent_tags,
        "emotion_label": emotion_label,
        "duration_hint_ms": duration_hint_ms,
        "resource_id": resource_id,
        "fallback_pose_id": "",
        "axes": normalized_axes,
        "summary": {
            "axis_count": len(normalized_axes),
            "intent_tag_count": len(intent_tags),
        },
    }
    if performance_curve_hint is not None:
        normalized_intent["performance_curve_hint"] = performance_curve_hint
    return normalized_intent


def normalize_motion_intent_tags(value: Any) -> list[str]:
    if value is None:
        return []
    raw_items: list[Any]
    if isinstance(value, (list, tuple)):
        raw_items = list(value)
    elif isinstance(value, set):
        raw_items = list(value)
    else:
        raw_items = [value]

    normalized: list[str] = []
    seen: set[str] = set()
    for raw_item in raw_items:
        if isinstance(raw_item, str):
            pieces = [
                part.strip()
                for part in re.split(r"[-,，、/|]+", raw_item)
            ]
        else:
            pieces = [str(raw_item).strip()]
        for piece in pieces:
            tag = str(piece or "").strip()
            if not tag or tag in seen:
                continue
            seen.add(tag)
            normalized.append(tag)
    return normalized


def normalize_motion_resource_id(value: Any) -> str:
    return str(value or "").strip()


def derive_motion_emotion_label(intent_tags: Any, *, fallback: str = "motion") -> str:
    tags = normalize_motion_intent_tags(intent_tags)
    if tags:
        return "-".join(tags)
    fallback_value = str(fallback or "").strip()
    return fallback_value or "motion"


def derive_motion_fallback_decision(
    *,
    candidates: list[dict[str, Any]],
    intent_tags: list[str],
    resource_id: str,
    axes: Any,
    describe_axes: Any,
) -> MotionFallbackDecision:
    if not candidates:
        return MotionFallbackDecision(
            fallback_pose_id="",
            matched_candidate_id="",
            score=0.0,
            fallback_missing=True,
            reasons=["candidate_pool_empty"],
        )

    normalized_axes = axes if isinstance(axes, dict) else {}
    current_descriptors = {
        str(item).strip().lower()
        for item in (describe_axes(normalized_axes) or [])
        if str(item).strip()
    }
    normalized_tags = {
        str(item).strip().lower()
        for item in intent_tags
        if str(item).strip()
    }
    normalized_resource_id = normalize_motion_resource_id(resource_id).lower()

    best_candidate_id = ""
    best_score = float("-inf")
    best_reasons: list[str] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        candidate_id = str(candidate.get("id") or "").strip()
        if not candidate_id:
            continue
        score = 0.0
        reasons: list[str] = []
        candidate_id_lower = candidate_id.lower()
        if normalized_resource_id and normalized_resource_id == candidate_id_lower:
            score += 120.0
            reasons.append("resource_id_exact_match")
        if candidate_id_lower in normalized_tags:
            score += 40.0
            reasons.append("candidate_id_matches_intent_tag")

        prompt_tag_pool = {
            str(item).strip().lower()
            for item in (
                list(candidate.get("tags") or [])
                + list(candidate.get("emotion_bias") or [])
                + list(candidate.get("recommended_scenarios") or [])
            )
            if str(item).strip()
        }
        tag_overlap = len(normalized_tags & prompt_tag_pool)
        score += 16.0 * tag_overlap
        if tag_overlap:
            reasons.append(f"tag_overlap:{tag_overlap}")

        descriptor_pool = {
            str(item).strip().lower()
            for item in (describe_axes(candidate.get("axes")) or [])
            if str(item).strip()
        }
        descriptor_overlap = len(current_descriptors & descriptor_pool)
        score += 12.0 * descriptor_overlap
        if descriptor_overlap:
            reasons.append(f"descriptor_overlap:{descriptor_overlap}")

        if str(candidate.get("source") or "").strip() == "motion_tuning_sample":
            score += 6.0
            reasons.append("prefer_motion_tuning_sample")

        if score > best_score:
            best_score = score
            best_candidate_id = candidate_id
            best_reasons = reasons

    if best_score > 0:
        return MotionFallbackDecision(
            fallback_pose_id=best_candidate_id,
            matched_candidate_id=best_candidate_id,
            score=round(best_score, 4),
            fallback_missing=False,
            reasons=best_reasons or ["candidate_selected"],
        )
    return MotionFallbackDecision(
        fallback_pose_id="",
        matched_candidate_id="",
        score=0.0,
        fallback_missing=True,
        reasons=["score_below_threshold"],
    )


def derive_motion_fallback_pose_id(
    *,
    candidates: list[dict[str, Any]],
    intent_tags: list[str],
    resource_id: str,
    axes: Any,
    describe_axes: Any,
) -> str:
    return derive_motion_fallback_decision(
        candidates=candidates,
        intent_tags=intent_tags,
        resource_id=resource_id,
        axes=axes,
        describe_axes=describe_axes,
    ).fallback_pose_id


def describe_motion_axes_for_fallback(
    axes: Any,
    *,
    semantic_profile: dict[str, Any],
) -> list[str]:
    if not isinstance(axes, dict) or not axes:
        return []
    axis_by_id = {
        str(axis.get("id") or "").strip(): axis
        for axis in profile_prompt_axes(semantic_profile)
        if str(axis.get("id") or "").strip()
    }
    descriptors: list[str] = []
    for axis_id, axis_value in sorted(axes.items()):
        if not isinstance(axis_value, (int, float)) or isinstance(axis_value, bool):
            continue
        axis_name = str(axis_id or "").strip()
        if not axis_name:
            continue
        descriptor = _describe_fallback_pose_axis_value(
            axis_name,
            float(axis_value),
            axis=axis_by_id.get(axis_name),
        )
        if descriptor and descriptor not in descriptors:
            descriptors.append(descriptor)
    return descriptors


def _describe_fallback_pose_axis_value(
    axis_id: str,
    value: float,
    *,
    axis: dict[str, Any] | None = None,
) -> str:
    normalized_axis = axis_id.strip().lower()
    if not float("-inf") < value < float("inf"):
        return ""
    delta = _resolve_axis_neutral_delta(value, axis)
    threshold = _resolve_axis_descriptor_threshold(axis)
    if abs(delta) < threshold:
        return ""

    axis_descriptors = {
        "head_yaw": ("look_left", "look_right"),
        "body_yaw": ("body_turn_left", "body_turn_right"),
        "gaze_x": ("gaze_left", "gaze_right"),
        "gaze_y": ("gaze_down", "gaze_up"),
        "head_pitch": ("look_down", "look_up"),
        "body_pitch": ("lean_forward", "lean_back"),
        "head_roll": ("tilt_left", "tilt_right"),
        "body_roll": ("body_lean_left", "body_lean_right"),
        "eye_open_left": ("left_eye_narrow", "left_eye_open"),
        "eye_open_right": ("right_eye_narrow", "right_eye_open"),
        "eye_smile_left": ("left_eye_relaxed", "left_eye_smile"),
        "eye_smile_right": ("right_eye_relaxed", "right_eye_smile"),
        "mouth_smile": ("mouth_frown", "mouth_smile"),
        "brow_bias": ("brow_down", "brow_raise"),
        "mouth_open": ("mouth_closed", "mouth_open"),
    }
    negative, positive = axis_descriptors.get(
        normalized_axis,
        (f"{normalized_axis}_low", f"{normalized_axis}_high"),
    )
    return positive if delta > 0 else negative


def _resolve_axis_neutral_delta(value: float, axis: dict[str, Any] | None) -> float:
    neutral = _coerce_finite_number((axis or {}).get("neutral"))
    if neutral is None:
        neutral = 50.0
    return float(value) - neutral


def _resolve_axis_descriptor_threshold(axis: dict[str, Any] | None) -> float:
    if not isinstance(axis, dict):
        return 6.0
    soft_range = axis.get("soft_range")
    if isinstance(soft_range, (list, tuple)) and len(soft_range) >= 2:
        try:
            soft_min = float(soft_range[0])
            soft_max = float(soft_range[1])
            neutral = _coerce_finite_number(axis.get("neutral"))
            if neutral is None:
                neutral = 50.0
            soft_delta = max(abs(soft_max - neutral), abs(neutral - soft_min))
            if soft_delta > 0:
                return max(soft_delta * 0.6, 2.0)
        except (TypeError, ValueError):
            pass
    return 6.0


def _normalize_duration_hint_ms(value: Any) -> int:
    if value is None:
        _incr_repair_stat("duration_hint_defaulted")
        return DEFAULT_MOTION_INTENT_DURATION_MS
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        try:
            number = float(value)
        except (TypeError, ValueError):
            _incr_repair_stat("duration_hint_defaulted")
            return DEFAULT_MOTION_INTENT_DURATION_MS
    else:
        number = float(value)
    if not float("-inf") < number < float("inf"):
        _incr_repair_stat("duration_hint_defaulted")
        return DEFAULT_MOTION_INTENT_DURATION_MS
    duration_hint_ms = int(round(number))
    clamped = max(320, min(15000, duration_hint_ms))
    if clamped != duration_hint_ms:
        _incr_repair_stat("duration_hint_clamped")
    return clamped


def _coerce_finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    if not float("-inf") < number < float("inf"):
        return None
    return number


def _apply_expressive_floor_v2(
    *,
    axes: dict[str, float],
    emotion: str,
    semantic_profile: dict[str, Any],
) -> dict[str, float]:
    """Boost near-neutral expressive motions to be clearly visible in semantic axes."""
    del emotion
    if not axes:
        return axes

    profile_axes: dict[str, dict[str, Any]] = {}
    for axis in semantic_profile.get("axes") or []:
        if isinstance(axis, dict):
            axis_id = str(axis.get("id") or "").strip()
            if axis_id:
                profile_axes[axis_id] = axis

    if not profile_axes:
        return axes

    AxisEntry = tuple[str, float, float, float, float, float, float, float, float]
    axis_entries: list[AxisEntry] = []
    has_outside_soft = False
    for axis_id, value in axes.items():
        axis = profile_axes.get(axis_id)
        if not axis:
            continue
        neutral = float(axis.get("neutral", 0))
        soft_range = axis.get("soft_range")
        if isinstance(soft_range, list) and len(soft_range) == 2:
            soft_min = float(soft_range[0])
            soft_max = float(soft_range[1])
        else:
            span = 10.0
            soft_min = neutral - span
            soft_max = neutral + span
        value_range = axis.get("value_range")
        if isinstance(value_range, list) and len(value_range) == 2:
            vmin = float(value_range[0])
            vmax = float(value_range[1])
        else:
            vmin = 0.0
            vmax = 100.0
        if value < soft_min or value > soft_max:
            has_outside_soft = True
        delta = value - neutral
        soft_half_span = max(soft_max - neutral, neutral - soft_min, 1.0)
        axis_entries.append((axis_id, value, neutral, soft_min, soft_max, soft_half_span, vmin, vmax, delta))

    if has_outside_soft:
        return axes

    max_abs_delta = max((abs(entry[8]) for entry in axis_entries), default=0)

    boosted: dict[str, float] = {}
    for entry in axis_entries:
        axis_id, value, neutral, soft_min, soft_max, soft_half_span, vmin, vmax, delta = entry

        if max_abs_delta < 0.001:
            positive_soft_span = max(soft_max - neutral, 0.0)
            positive_candidate = min(vmax, soft_max + max(positive_soft_span * 0.3, 0.001))
            if positive_candidate > soft_max:
                candidate = positive_candidate
            else:
                negative_soft_span = max(neutral - soft_min, 0.0)
                negative_candidate = max(vmin, soft_min - max(negative_soft_span * 0.3, 0.001))
                candidate = negative_candidate if negative_candidate < soft_min else neutral
        else:
            scale = (soft_half_span + soft_half_span * 0.3) / max_abs_delta
            candidate = neutral + delta * scale

        boosted[axis_id] = round(max(vmin, min(vmax, candidate)), 4)

    return boosted


def clamp_axis_value(value: Any) -> int:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        number = 50
    return max(0, min(100, number))


def _apply_expressive_floor(
    *,
    axes: dict[str, int],
    emotion: str,
) -> dict[str, int]:
    del emotion
    deltas = {
        axis_name: clamp_axis_value(value) - 50
        for axis_name, value in axes.items()
    }
    nonzero_deltas = [abs(delta) for delta in deltas.values() if delta != 0]
    max_abs_delta = max(nonzero_deltas) if nonzero_deltas else 0
    if max_abs_delta >= _MIN_EXPRESSIVE_MAX_DELTA:
        return axes

    if max_abs_delta == 0:
        return dict(axes)

    scale = _MIN_EXPRESSIVE_MAX_DELTA / float(max_abs_delta)
    boosted: dict[str, int] = {}
    for axis_name, base_value in axes.items():
        delta = deltas.get(axis_name, 0)
        if delta == 0:
            boosted[axis_name] = clamp_axis_value(base_value)
            continue
        candidate_delta = int(round(delta * scale))
        if abs(candidate_delta) < _MIN_EXPRESSIVE_NONZERO_DELTA:
            candidate_delta = _MIN_EXPRESSIVE_NONZERO_DELTA if delta > 0 else -_MIN_EXPRESSIVE_NONZERO_DELTA
        boosted[axis_name] = clamp_axis_value(50 + candidate_delta)

    return boosted


def validate_motion_intent_payload(intent: Any) -> tuple[bool, str]:
    try:
        normalize_motion_intent_payload(intent)
    except ValueError as exc:
        return False, str(exc)
    return True, ""


def validate_parameter_plan_payload(plan: Any) -> tuple[bool, str]:
    return validate_parameter_plan_v2_payload(plan)


def validate_parameter_plan_v2_payload(plan: Any) -> tuple[bool, str]:
    if not isinstance(plan, dict):
        return False, "plan_not_object"

    schema_version = str(plan.get("schema_version") or "").strip()
    if schema_version != PARAMETER_PLAN_V2_SCHEMA_VERSION:
        return False, "invalid_schema_version"

    mode = str(plan.get("mode") or "").strip().lower()
    if mode not in {"expressive", "idle"}:
        return False, "invalid_mode"

    for key in ("profile_id", "model_id", "emotion_label"):
        value = str(plan.get(key) or "").strip()
        if not value:
            return False, f"{key}_empty"
    profile_revision = plan.get("profile_revision")
    if not isinstance(profile_revision, int) or profile_revision <= 0:
        return False, "profile_revision_invalid"

    timing = plan.get("timing")
    if not isinstance(timing, dict):
        return False, "timing_not_object"
    for key in ("duration_ms", "blend_in_ms", "hold_ms", "blend_out_ms"):
        value = timing.get(key)
        if not isinstance(value, (int, float)):
            return False, f"timing_{key}_not_number"
        if float(value) < 0:
            return False, f"timing_{key}_negative"

    parameters = plan.get("parameters")
    if not isinstance(parameters, list) or not parameters:
        return False, "parameters_not_list"
    seen_parameter_ids: set[str] = set()
    for item in parameters:
        if not isinstance(item, dict):
            return False, "parameter_item_not_object"
        axis_id = str(item.get("axis_id") or "").strip()
        parameter_id = str(item.get("parameter_id") or "").strip()
        if not axis_id:
            return False, "parameter_axis_id_empty"
        if not parameter_id:
            return False, "parameter_id_empty"
        if parameter_id in seen_parameter_ids:
            return False, f"duplicate_parameter_id:{parameter_id}"
        seen_parameter_ids.add(parameter_id)
        for key in ("target_value", "weight"):
            value = item.get(key)
            if not isinstance(value, (int, float)):
                return False, f"parameter_{key}_not_number"
            if not float("-inf") < float(value) < float("inf"):
                return False, f"parameter_{key}_not_finite"
        weight = float(item.get("weight"))
        if weight < 0.0 or weight > 1.0:
            return False, "parameter_weight_out_of_range"
        source = item.get("source")
        if source is not None and source not in PARAMETER_PLAN_SOURCES:
            return False, f"parameter_source_invalid:{source}"

    return True, ""
