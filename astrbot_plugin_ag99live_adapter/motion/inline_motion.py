from __future__ import annotations

import json
import re
from typing import Any

from astrbot.api import logger

from ..protocol import (
    TYPE_ENGINE_CATALOG_MOTION,
    TYPE_ENGINE_MOTION_INTENT,
)
from .catalog_motion import (
    normalize_catalog_motion_payload,
    summarize_catalog_motion_payload,
    validate_catalog_motion_payload,
)
from .motion_intent import (
    _apply_expressive_floor_v2,
    DEFAULT_MOTION_INTENT_DURATION_MS,
    MOTION_INTENT_V2_SCHEMA_VERSION,
    MOTION_INTENT_V3_SCHEMA_VERSION,
    derive_motion_emotion_label,
    derive_motion_fallback_decision,
    describe_motion_axes_for_fallback,
    normalize_motion_intent_payload,
    normalize_motion_intent_tags,
    normalize_motion_resource_id,
    resolve_selected_semantic_axis_profile,
    validate_motion_intent_payload,
)
from .fallback_pose import (
    DEFAULT_FALLBACK_POSE_ID,
    build_fallback_pose_candidates,
    build_default_neutral_pose_axes,
    repair_motion_axes_with_fallback_pose,
    resolve_fallback_pose,
    resolve_fallback_pose_axes,
)
from ..prompts.inline_motion_contract import build_inline_motion_contract
from ..prompts.main_reply import build_main_llm_user_text
from ..prompts.motion_selector import resolve_motion_prompt_instruction

INLINE_ANIM_TAG_PATTERN = re.compile(r"<@anim\s*\{[\s\S]*?\}>\s*", re.IGNORECASE)
INLINE_ANIM_START_PATTERN = re.compile(r"<@anim\b", re.IGNORECASE)


# ── Inline motion plan extraction ──────────────────────────────────

def extract_inline_motion_plan(
    text: str,
    *,
    runtime_state: Any | None = None,
) -> tuple[str, dict[str, Any] | None, str | None]:
    normalized = str(text or "")
    if not normalized:
        return "", None, None

    matches = list(INLINE_ANIM_TAG_PATTERN.finditer(normalized))
    cleaned_text = strip_inline_anim_tags(normalized)
    if not matches:
        return cleaned_text, None, None

    for match in reversed(matches):
        payload = _parse_inline_anim_tag(match.group(0))
        if not isinstance(payload, dict):
            continue
        plan, mode = normalize_inline_anim_payload(payload, runtime_state=runtime_state)
        if isinstance(plan, dict):
            return cleaned_text, plan, mode

    return cleaned_text, None, None


def _parse_inline_anim_tag(tag_text: str) -> dict[str, Any] | None:
    text = str(tag_text or "")
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    payload_text = text[start : end + 1]
    try:
        payload = json.loads(payload_text)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def normalize_inline_anim_payload(
    payload: dict[str, Any],
    *,
    runtime_state: Any | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    mode_value = payload.get("mode")
    mode = str(mode_value).strip() if isinstance(mode_value, str) else "inline"
    mode = mode or "inline"

    if isinstance(payload.get("intent"), dict):
        raw_intent = payload["intent"]
        raw_schema_version = str(raw_intent.get("schema_version") or "").strip()
        forbidden_field = _find_inline_forbidden_field(raw_intent)
        if raw_schema_version == MOTION_INTENT_V3_SCHEMA_VERSION and forbidden_field:
            logger.warning("WIRING inline_motion payload rejected: forbidden_field:%s", forbidden_field)
            return _build_inline_fallback_motion_payload(
                raw_intent,
                runtime_state=runtime_state,
                fallback_reason=f"forbidden_field:{forbidden_field}",
                mode=mode,
            )
        try:
            plan = normalize_motion_intent_payload(raw_intent)
        except ValueError as exc:
            logger.warning("WIRING inline_motion payload rejected: %s", exc)
            return _build_inline_fallback_motion_payload(
                raw_intent,
                runtime_state=runtime_state,
                fallback_reason=str(exc),
                mode=mode,
            )
    else:
        logger.warning("WIRING inline_motion payload rejected: missing_nested_intent")
        return None, None

    valid, failure_reason = validate_motion_payload(plan)
    if not valid:
        logger.warning("WIRING inline_motion payload rejected: %s", failure_reason)
        return _build_inline_fallback_motion_payload(
            plan,
            runtime_state=runtime_state,
            fallback_reason=failure_reason,
            mode=mode,
        )

    plan = _repair_inline_motion_payload_with_fallback(
        plan,
        runtime_state=runtime_state,
    )

    return plan, mode


def _find_inline_forbidden_field(raw_intent: Any) -> str:
    if not isinstance(raw_intent, dict):
        return ""
    for field in (
        "choice",
        "mode",
        "motion_id",
        "catalog_motion",
        "motion3",
        "exp3",
        "kind",
        "emotion",
        "emotion_label",
        "fallback_pose_id",
        "summary",
    ):
        if field in raw_intent:
            return field
    return ""


def _repair_inline_motion_payload_with_fallback(
    plan: dict[str, Any],
    *,
    runtime_state: Any | None,
) -> dict[str, Any]:
    if runtime_state is None:
        return plan
    if str(plan.get("schema_version") or "").strip() != MOTION_INTENT_V3_SCHEMA_VERSION:
        return plan
    axes = plan.get("axes")
    if not isinstance(axes, dict) or not axes:
        return plan
    try:
        semantic_profile = resolve_selected_semantic_axis_profile(runtime_state=runtime_state)
    except RuntimeError:
        return plan
    fallback_candidates = build_fallback_pose_candidates(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
        limit=None,
    )
    resource_id = _validate_inline_motion_resource_id(
        normalize_motion_resource_id(plan.get("resource_id")),
        candidates=fallback_candidates,
    )
    fallback_decision = derive_motion_fallback_decision(
        candidates=fallback_candidates,
        intent_tags=normalize_motion_intent_tags(plan.get("intent_tags")),
        resource_id=resource_id,
        axes=axes,
        describe_axes=lambda value: describe_motion_axes_for_fallback(
            value,
            semantic_profile=semantic_profile,
        ),
    )
    fallback_pose_id = fallback_decision.fallback_pose_id
    fallback_axes = resolve_fallback_pose_axes(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
        fallback_pose_id=fallback_pose_id,
    )
    repaired_axes, added_axes, replaced_axes = repair_motion_axes_with_fallback_pose(
        axes=dict(axes),
        semantic_profile=semantic_profile,
        fallback_axes=fallback_axes,
    )
    floored_axes = _apply_expressive_floor_v2(
        axes=repaired_axes,
        emotion=str(plan.get("emotion_label") or ""),
        semantic_profile=semantic_profile,
    )
    changed_by_floor = floored_axes != repaired_axes
    if not added_axes and not replaced_axes and not changed_by_floor:
        if resource_id == normalize_motion_resource_id(plan.get("resource_id")):
            return plan
        repaired = dict(plan)
        repaired["resource_id"] = resource_id
        summary = dict(repaired.get("summary") or {})
        if not resource_id:
            summary["resource_id_rejected"] = True
        repaired["summary"] = summary
        return repaired
    repaired = dict(plan)
    summary = dict(repaired.get("summary") or {})
    summary["axis_count"] = len(floored_axes)
    summary["fallback_pose_id"] = fallback_pose_id
    summary["fallback_score"] = fallback_decision.score
    summary["fallback_used"] = fallback_decision.used_default_neutral
    summary["fallback_reasons"] = fallback_decision.reasons
    summary["skeleton_repair_added_axes"] = added_axes
    summary["skeleton_repair_replaced_axes"] = replaced_axes
    if changed_by_floor:
        summary["expressive_floor_applied"] = True
    if not resource_id and normalize_motion_resource_id(plan.get("resource_id")):
        summary["resource_id_rejected"] = True
    repaired["resource_id"] = resource_id
    repaired["axes"] = floored_axes
    repaired["fallback_pose_id"] = fallback_pose_id
    repaired["summary"] = summary
    return repaired


def _build_inline_fallback_motion_payload(
    raw_intent: Any,
    *,
    runtime_state: Any | None,
    fallback_reason: str,
    mode: str,
) -> tuple[dict[str, Any] | None, str | None]:
    if runtime_state is None:
        return None, None
    try:
        semantic_profile = resolve_selected_semantic_axis_profile(runtime_state=runtime_state)
    except RuntimeError as exc:
        logger.warning("WIRING inline_motion fallback disabled: %s", exc)
        return None, None

    intent_tags: list[str] = []
    resource_id = ""
    if isinstance(raw_intent, dict):
        if _find_inline_forbidden_field(raw_intent):
            return None, None
        intent_tags = normalize_motion_intent_tags(raw_intent.get("intent_tags"))
        resource_id = normalize_motion_resource_id(raw_intent.get("resource_id"))
    if not intent_tags:
        return None, None
    emotion_label = derive_motion_emotion_label(intent_tags)
    fallback_candidates = build_fallback_pose_candidates(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
        limit=None,
    )
    raw_resource_id = resource_id
    resource_id = _validate_inline_motion_resource_id(
        resource_id,
        candidates=fallback_candidates,
    )
    fallback_decision = derive_motion_fallback_decision(
        candidates=fallback_candidates,
        intent_tags=intent_tags,
        resource_id=resource_id,
        axes=raw_intent.get("axes") if isinstance(raw_intent, dict) else {},
        describe_axes=lambda value: describe_motion_axes_for_fallback(
            value,
            semantic_profile=semantic_profile,
        ),
    )
    fallback_pose_id = fallback_decision.fallback_pose_id

    fallback_resolution = resolve_fallback_pose(
        runtime_state=runtime_state,
        semantic_profile=semantic_profile,
        fallback_pose_id=fallback_pose_id,
    )
    expressive_floor_emotion = emotion_label
    apply_expressive_floor = True
    if fallback_resolution is not None:
        axes = fallback_resolution.axes
        if fallback_resolution.is_default_neutral:
            expressive_floor_emotion = "neutral"
            apply_expressive_floor = False
    else:
        axes = None
    if fallback_resolution is None and fallback_pose_id == DEFAULT_FALLBACK_POSE_ID:
        expressive_floor_emotion = "neutral"
        apply_expressive_floor = False
    if not axes:
        axes = build_default_neutral_pose_axes(semantic_profile)
        fallback_pose_id = DEFAULT_FALLBACK_POSE_ID
        expressive_floor_emotion = "neutral"
        apply_expressive_floor = False
    if not axes:
        return None, None
    if apply_expressive_floor:
        axes = _apply_expressive_floor_v2(
            axes=axes,
            emotion=expressive_floor_emotion,
            semantic_profile=semantic_profile,
        )

    try:
        profile_revision = int(semantic_profile.get("revision") or 0)
    except (TypeError, ValueError):
        return None, None
    if profile_revision <= 0:
        return None, None

    payload = {
        "schema_version": MOTION_INTENT_V3_SCHEMA_VERSION,
        "profile_id": str(semantic_profile.get("profile_id") or "").strip(),
        "profile_revision": profile_revision,
        "model_id": str(semantic_profile.get("model_id") or "").strip(),
        "mode": "expressive",
        "intent_tags": intent_tags,
        "emotion_label": emotion_label,
        "duration_hint_ms": DEFAULT_MOTION_INTENT_DURATION_MS,
        "resource_id": resource_id,
        "fallback_pose_id": fallback_pose_id,
        "axes": axes,
        "summary": {
            "axis_count": len(axes),
            "intent_tag_count": len(intent_tags),
            "fallback_pose_id": fallback_pose_id,
            "fallback_used": fallback_decision.used_default_neutral,
            "fallback_score": fallback_decision.score,
            "fallback_reasons": fallback_decision.reasons,
            "fallback_reason": str(fallback_reason or "").strip(),
            "resource_id_rejected": bool(raw_resource_id and not resource_id),
        },
    }
    valid, failure_reason = validate_motion_intent_payload(payload)
    if not valid:
        logger.warning("WIRING inline_motion fallback rejected: %s", failure_reason)
        return None, None
    return payload, mode or "inline"


def _validate_inline_motion_resource_id(
    resource_id: Any,
    *,
    candidates: list[dict[str, Any]],
) -> str:
    normalized = normalize_motion_resource_id(resource_id)
    if not normalized:
        return ""
    candidate_ids = {
        normalize_motion_resource_id(candidate.get("id")).lower()
        for candidate in candidates
        if isinstance(candidate, dict)
    }
    if normalized.lower() in candidate_ids:
        return normalized
    return ""


# ── Motion payload validation ──────────────────────────────────────

def validate_motion_payload(payload: Any) -> tuple[bool, str]:
    schema_version = resolve_motion_payload_schema_version(payload)
    if schema_version in {MOTION_INTENT_V2_SCHEMA_VERSION, MOTION_INTENT_V3_SCHEMA_VERSION}:
        return validate_motion_intent_payload(payload)
    if schema_version == "engine.catalog_motion.v1":
        return validate_catalog_motion_payload(payload)
    return False, "unsupported_schema_version"


# ── Motion schema helpers ──────────────────────────────────────────

def resolve_motion_payload_schema_version(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("schema_version") or "").strip()


def resolve_engine_motion_message_type(payload: Any) -> str:
    schema_version = resolve_motion_payload_schema_version(payload)
    if schema_version in {MOTION_INTENT_V2_SCHEMA_VERSION, MOTION_INTENT_V3_SCHEMA_VERSION}:
        return TYPE_ENGINE_MOTION_INTENT
    if schema_version == "engine.catalog_motion.v1":
        return TYPE_ENGINE_CATALOG_MOTION
    return ""


def resolve_inline_motion_source(payload: Any) -> str:
    return "engine.inline_motion_intent"


def resolve_realtime_motion_source(payload: Any) -> str:
    return "engine.realtime_motion_intent"


def summarize_motion_payload(plan: Any) -> tuple[str, str, int, int, str]:
    if not isinstance(plan, dict):
        return "", "", 0, 0, "plan_not_object"

    schema_version = str(plan.get("schema_version") or "").strip()
    if schema_version == "engine.catalog_motion.v1":
        catalog_schema, motion_id, emotion_label, failure_reason = summarize_catalog_motion_payload(plan)
        return catalog_schema, motion_id or emotion_label, 0, 0, failure_reason

    mode = str(plan.get("mode") or "").strip().lower()
    if schema_version == MOTION_INTENT_V3_SCHEMA_VERSION and not mode:
        mode = "expressive"
    axes = plan.get("axes")
    if axes is None:
        axes = plan.get("key_axes")
    supplementary = plan.get("supplementary_params")
    parameters = plan.get("parameters")
    axis_count = len(axes) if isinstance(axes, dict) else 0
    supplementary_count = len(supplementary) if isinstance(supplementary, list) else (
        len(parameters) if isinstance(parameters, list) else 0
    )
    valid, failure_reason = validate_motion_payload(plan)
    return schema_version, mode, axis_count, supplementary_count, "" if valid else failure_reason


def extract_message_motion_payload(
    message_type: str,
    payload: Any,
) -> tuple[dict[str, Any] | None, str]:
    if not isinstance(payload, dict):
        return None, "payload_not_object"

    if message_type == TYPE_ENGINE_MOTION_INTENT:
        motion_payload = payload.get("intent")
        if not isinstance(motion_payload, dict):
            return None, "missing_intent_object"
        try:
            motion_payload = normalize_motion_intent_payload(motion_payload)
        except ValueError as exc:
            return None, str(exc)
    elif message_type == TYPE_ENGINE_CATALOG_MOTION:
        motion_payload = payload.get("motion")
        if not isinstance(motion_payload, dict):
            return None, "missing_motion_object"
        try:
            motion_payload = normalize_catalog_motion_payload(motion_payload)
        except ValueError as exc:
            return None, str(exc)
    else:
        return None, "unsupported_message_type"

    resolved_message_type = resolve_engine_motion_message_type(motion_payload)
    if resolved_message_type != message_type:
        return None, "message_type_payload_schema_mismatch"

    return motion_payload, ""


# ── Inline motion contract ─────────────────────────────────────────

def build_inline_motion_contract_for_runtime(*, runtime_state: Any) -> str:
    try:
        semantic_profile = resolve_selected_semantic_axis_profile(runtime_state=runtime_state)
    except RuntimeError as exc:
        logger.warning("Inline motion contract disabled because semantic profile is unavailable: %s", exc)
        return ""

    motion_instruction = resolve_motion_prompt_instruction(runtime_state=runtime_state)
    return build_inline_motion_contract(
        semantic_profile=semantic_profile,
        motion_instruction=motion_instruction,
    )


def build_model_visible_user_text(user_text: str, *, runtime_state: Any) -> str:
    base_text = build_main_llm_user_text(user_text)
    if resolve_motion_generation_mode(runtime_state) != "inline_first":
        return base_text
    if not bool(getattr(runtime_state, "enable_inline_motion_contract", True)):
        return base_text

    contract = build_inline_motion_contract_for_runtime(runtime_state=runtime_state)
    if not contract:
        return base_text

    if base_text:
        return f"{base_text}\n\n<system_reminder>\n{contract}\n</system_reminder>"
    return f"<system_reminder>\n{contract}\n</system_reminder>"


def resolve_motion_generation_mode(runtime_state: Any) -> str:
    if runtime_state is None:
        return "split_after_reply"
    mode = str(getattr(runtime_state, "motion_generation_mode", "split_after_reply") or "").strip()
    if mode in {"inline_first", "split_after_reply"}:
        return mode
    return "split_after_reply"


def strip_inline_anim_tags(text: str) -> str:
    cleaned = INLINE_ANIM_TAG_PATTERN.sub("", str(text or ""))

    while True:
        marker = INLINE_ANIM_START_PATTERN.search(cleaned)
        if marker is None:
            break

        start = marker.start()
        end_gt = cleaned.find(">", start)
        end_newline = cleaned.find("\n", start)

        if end_gt != -1 and (end_newline == -1 or end_gt < end_newline):
            end = end_gt + 1
        elif end_newline != -1:
            end = end_newline
        else:
            end = len(cleaned)

        cleaned = cleaned[:start] + cleaned[end:]

    return cleaned.strip()
