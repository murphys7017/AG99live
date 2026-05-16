from __future__ import annotations

import json
import re
from typing import Any

from astrbot.api import logger

from ..protocol import (
    TYPE_ENGINE_MOTION_INTENT,
    TYPE_ENGINE_PARAMETER_PLAN,
)
from .realtime_motion_plan import (
    normalize_motion_intent_payload,
    resolve_selected_semantic_axis_profile,
    validate_parameter_plan_payload,
    validate_motion_intent_payload,
)
from ..prompts.inline_motion_contract import build_inline_motion_contract
from ..prompts.main_reply import build_main_llm_user_text
from ..prompts.motion_selector import resolve_motion_prompt_instruction

INLINE_ANIM_TAG_PATTERN = re.compile(r"<@anim\s*\{[\s\S]*?\}>\s*", re.IGNORECASE)
INLINE_ANIM_START_PATTERN = re.compile(r"<@anim\b", re.IGNORECASE)


# ── Inline motion plan extraction ──────────────────────────────────

def extract_inline_motion_plan(text: str) -> tuple[str, dict[str, Any] | None, str | None]:
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
        plan, mode = normalize_inline_anim_payload(payload)
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
) -> tuple[dict[str, Any] | None, str | None]:
    mode_value = payload.get("mode")
    mode = str(mode_value).strip() if isinstance(mode_value, str) else "inline"
    mode = mode or "inline"

    if isinstance(payload.get("intent"), dict):
        try:
            plan = normalize_motion_intent_payload(payload["intent"])
        except ValueError as exc:
            logger.warning("WIRING inline_motion payload rejected: %s", exc)
            return None, None
    else:
        logger.warning("WIRING inline_motion payload rejected: missing_nested_intent")
        return None, None

    valid, failure_reason = validate_motion_payload(plan)
    if not valid:
        logger.warning("WIRING inline_motion payload rejected: %s", failure_reason)
        return None, None

    return plan, mode


# ── Motion payload validation ──────────────────────────────────────

def validate_motion_payload(payload: Any) -> tuple[bool, str]:
    schema_version = resolve_motion_payload_schema_version(payload)
    if schema_version == "engine.motion_intent.v2":
        return validate_motion_intent_payload(payload)
    if schema_version == "engine.parameter_plan.v2":
        return validate_parameter_plan_payload(payload)
    return False, "unsupported_schema_version"


# ── Motion schema helpers ──────────────────────────────────────────

def resolve_motion_payload_schema_version(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("schema_version") or "").strip()


def resolve_engine_motion_message_type(payload: Any) -> str:
    schema_version = resolve_motion_payload_schema_version(payload)
    if schema_version == "engine.motion_intent.v2":
        return TYPE_ENGINE_MOTION_INTENT
    if schema_version == "engine.parameter_plan.v2":
        return TYPE_ENGINE_PARAMETER_PLAN
    return ""


def resolve_inline_motion_source(payload: Any) -> str:
    return "engine.inline_motion_intent"


def resolve_realtime_motion_source(payload: Any) -> str:
    return "engine.realtime_motion_intent"


def summarize_motion_payload(plan: Any) -> tuple[str, str, int, int, str]:
    if not isinstance(plan, dict):
        return "", "", 0, 0, "plan_not_object"

    schema_version = str(plan.get("schema_version") or "").strip()
    mode = str(plan.get("mode") or "").strip().lower()
    key_axes = plan.get("key_axes") or plan.get("axes")
    supplementary = plan.get("supplementary_params")
    parameters = plan.get("parameters")
    key_axes_count = len(key_axes) if isinstance(key_axes, dict) else 0
    supplementary_count = len(supplementary) if isinstance(supplementary, list) else (
        len(parameters) if isinstance(parameters, list) else 0
    )
    valid, failure_reason = validate_motion_payload(plan)
    return schema_version, mode, key_axes_count, supplementary_count, "" if valid else failure_reason


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
    elif message_type == TYPE_ENGINE_PARAMETER_PLAN:
        motion_payload = payload.get("plan")
        if not isinstance(motion_payload, dict):
            return None, "missing_plan_object"
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
