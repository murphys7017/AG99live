from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from ..prompts.motion_selector import (
    AXIS_NAMES,
    DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES,
    MOTION_SELECTOR_SYSTEM_PROMPT,
    build_selector_context,
    build_selector_platform_context,
    build_selector_user_prompt,
    resolve_motion_prompt_instruction,
)
from ..prompts.semantic_axis_prompt import profile_prompt_axes
from .motion_intent import (
    DEFAULT_MOTION_INTENT_DURATION_MS,
    MOTION_INTENT_SCHEMA_VERSION,
    MOTION_INTENT_V2_SCHEMA_VERSION,
    MOTION_INTENT_V3_SCHEMA_VERSION,
    PARAMETER_PLAN_SOURCES,
    PARAMETER_PLAN_V2_SCHEMA_VERSION,
    _apply_expressive_floor_v2,
    _coerce_finite_number,
    _normalize_duration_hint_ms,
    clamp_axis_value,
    derive_motion_emotion_label,
    normalize_motion_intent_payload,
    normalize_motion_intent_tags,
    normalize_motion_resource_id,
    resolve_selected_semantic_axis_profile,
    validate_motion_intent_payload,
    validate_parameter_plan_payload,
    validate_parameter_plan_v2_payload,
)

LOGGER = logging.getLogger(__name__)
_SYSTEM_PROMPT = MOTION_SELECTOR_SYSTEM_PROMPT
_IDLE_DEADZONE_MIN = 42
_IDLE_DEADZONE_MAX = 58
_MAX_AXIS_ERROR_RATE = 0.30
_DEFAULT_SELECTOR_FEW_SHOT_SIGNATURES = {
    json.dumps(
        item,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    for item in DEFAULT_SELECTOR_FEW_SHOT_EXAMPLES
}


class RealtimeMotionPlanGenerator:
    def __init__(self, *, runtime_state: Any) -> None:
        self.runtime_state = runtime_state

    async def generate(
        self,
        *,
        user_text: str,
        assistant_text: str,
    ) -> dict[str, Any] | None:
        if not bool(getattr(self.runtime_state, "enable_realtime_motion_plan", True)):
            return None

        context_text = build_selector_context(
            user_text=user_text,
            assistant_text=assistant_text,
            platform_context=build_selector_platform_context(runtime_state=self.runtime_state),
        )
        semantic_profile = resolve_selected_semantic_axis_profile(runtime_state=self.runtime_state)
        selector_raw = await self._call_astrbot_selector(
            context_text,
            few_shot_examples=self._resolve_prompt_few_shot_examples(
                motion_reference_templates=[],
            ),
            style_prompt=self.runtime_state.build_motion_tuning_style_prompt(),
            motion_instruction=resolve_motion_prompt_instruction(runtime_state=self.runtime_state),
            semantic_profile=semantic_profile,
        )
        selector = normalize_selector_output(selector_raw, semantic_profile=semantic_profile)
        intent = build_intent_from_selector(selector, semantic_profile=semantic_profile)
        valid, failure_reason = validate_motion_intent_payload(intent)
        if not valid:
            LOGGER.warning(
                "Realtime motion intent rejected after selector normalization: %s",
                failure_reason,
            )
            return None
        return intent

    def _resolve_prompt_few_shot_examples(
        self,
        *,
        motion_reference_templates: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        examples = [
            item
            for item in self.runtime_state.list_effective_motion_tuning_examples()
            if isinstance(item, dict)
        ]
        if not examples:
            return []

        if not motion_reference_templates:
            return examples

        keep_fixed = bool(
            getattr(
                self.runtime_state,
                "realtime_motion_fixed_fewshot_with_reference_templates",
                False,
            )
        )
        if keep_fixed:
            return examples

        return [
            item
            for item in examples
            if not _is_default_selector_few_shot_example(item)
        ]

    async def _call_astrbot_selector(
        self,
        context_text: str,
        *,
        few_shot_examples: list[dict[str, Any]],
        style_prompt: str,
        motion_instruction: str,
        semantic_profile: dict[str, Any],
    ) -> dict[str, Any]:
        provider = getattr(self.runtime_state, "selected_motion_analysis_provider", None)
        if provider is None:
            raise RuntimeError(
                "AstrBot motion provider is unavailable. "
                "Configure `motion_analysis_provider_id` or set a current chat provider."
            )

        timeout = _resolve_motion_provider_timeout(self.runtime_state)
        try:
            response = await asyncio.wait_for(
                provider.text_chat(
                    prompt=build_selector_user_prompt(
                        context_text,
                        few_shot_examples=few_shot_examples,
                        style_prompt=style_prompt,
                        motion_instruction=motion_instruction,
                        semantic_profile=semantic_profile,
                    ),
                    system_prompt=_SYSTEM_PROMPT,
                ),
                timeout=timeout,
            )
        except asyncio.TimeoutError as exc:
            raise TimeoutError(f"AstrBot motion provider timed out after {timeout:g}s.") from exc
        completion_text = str(getattr(response, "completion_text", "") or "").strip()
        if not completion_text:
            raise RuntimeError("AstrBot motion provider returned empty completion_text.")
        return _extract_json_object(completion_text)


def _resolve_motion_provider_timeout(runtime_state: Any) -> float:
    raw_timeout = getattr(runtime_state, "realtime_motion_timeout_seconds", 20.0)
    try:
        timeout = float(raw_timeout)
    except (TypeError, ValueError):
        timeout = 20.0
    if not float("-inf") < timeout < float("inf"):
        return 20.0
    return max(20.0, timeout)


def _is_default_selector_few_shot_example(example: dict[str, Any]) -> bool:
    return (
        json.dumps(
            example,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        in _DEFAULT_SELECTOR_FEW_SHOT_SIGNATURES
    )


def _max_axis_error_count(axis_count: int) -> int:
    return max(0, int(axis_count * _MAX_AXIS_ERROR_RATE))


def normalize_selector_output(
    payload: dict[str, Any],
    *,
    semantic_profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if semantic_profile is not None:
        return normalize_selector_output_v3(payload, semantic_profile=semantic_profile)
    raise ValueError("semantic_profile_required")


def normalize_selector_output_v2(
    payload: dict[str, Any],
    *,
    semantic_profile: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("selector_payload_not_object")

    choice = str(payload.get("choice") or "generate").strip().lower()
    if choice not in {"generate", ""}:
        raise ValueError(f"selector_choice_not_generate:{choice}")

    emotion_raw = payload.get("emotion")
    emotion = str(emotion_raw).strip() if isinstance(emotion_raw, str) else ""
    if not emotion:
        raise ValueError("selector_emotion_empty")

    if "mode" not in payload:
        raise ValueError("selector_mode_missing")
    mode = str(payload.get("mode") or "").strip().lower()
    if mode not in {"idle", "expressive"}:
        raise ValueError("selector_mode_invalid")

    duration_ms_raw = payload.get("duration_ms")
    if not isinstance(duration_ms_raw, (int, float)):
        raise ValueError("selector_duration_ms_not_number")
    duration_ms = int(round(float(duration_ms_raw)))
    if duration_ms < 320 or duration_ms > 15000:
        raise ValueError("selector_duration_ms_out_of_range")

    raw_axes = payload.get("axes")
    if not isinstance(raw_axes, dict):
        raise ValueError("selector_axes_not_object")
    if not raw_axes:
        raise ValueError("selector_axes_empty")

    prompt_axes = profile_prompt_axes(semantic_profile)
    allowed_axes = {str(axis.get("id") or "").strip(): axis for axis in prompt_axes}
    allowed_axis_count = len(allowed_axes)
    max_axis_errors = _max_axis_error_count(allowed_axis_count)
    normalized_axes: dict[str, float] = {}
    axis_errors: list[str] = []
    axis_warnings: list[str] = []
    for raw_axis_id, raw_value in raw_axes.items():
        axis_id = str(raw_axis_id or "").strip()
        if axis_id not in allowed_axes:
            axis_errors.append(f"selector_axis_not_allowed:{axis_id}")
            continue
        if not isinstance(raw_value, (int, float)):
            axis_errors.append(f"selector_axis_not_number:{axis_id}")
            continue
        axis = allowed_axes[axis_id]
        value_range = axis.get("value_range")
        min_value = 0.0
        max_value = 100.0
        if (
            isinstance(value_range, list)
            and len(value_range) == 2
            and isinstance(value_range[0], (int, float))
            and isinstance(value_range[1], (int, float))
        ):
            min_value = float(value_range[0])
            max_value = float(value_range[1])
        value = float(raw_value)
        if value < min_value or value > max_value:
            clamped_value = min_value if value < min_value else max_value
            axis_warnings.append(
                f"selector_axis_clamped:{axis_id}:{value:g}->{clamped_value:g}"
            )
            value = clamped_value
        normalized_axes[axis_id] = round(value, 4)

    if len(axis_errors) > max_axis_errors:
        raise ValueError(
            "selector_axis_error_rate_exceeded:"
            f"{len(axis_errors)}/{allowed_axis_count}:{','.join(axis_errors)}"
        )
    if axis_errors:
        LOGGER.warning(
            "Realtime motion selector ignored invalid semantic axes within threshold. errors=%s threshold=%s/%s",
            ",".join(axis_errors),
            max_axis_errors,
            allowed_axis_count,
        )
    if axis_warnings:
        LOGGER.warning(
            "Realtime motion selector clamped semantic axis values. warnings=%s",
            ",".join(axis_warnings),
        )
    if not normalized_axes:
        raise ValueError("selector_axes_empty_after_error_filter")

    if mode == "expressive":
        normalized_axes = _apply_expressive_floor_v2(
            axes=normalized_axes,
            emotion=emotion,
            semantic_profile=semantic_profile,
        )

    return {
        "emotion": emotion,
        "mode": mode,
        "duration_ms": duration_ms,
        "axes": normalized_axes,
        "warnings": axis_warnings + axis_errors,
    }


def normalize_selector_output_v3(
    payload: dict[str, Any],
    *,
    semantic_profile: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("selector_payload_not_object")
    for forbidden_key in (
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
        if forbidden_key in payload:
            raise ValueError(f"selector_forbidden_field:{forbidden_key}")

    intent_tags = normalize_motion_intent_tags(payload.get("intent_tags"))
    if not intent_tags:
        raise ValueError("selector_intent_tags_empty")
    emotion = derive_motion_emotion_label(intent_tags)

    duration_ms = _normalize_duration_hint_ms(payload.get("duration_hint_ms", payload.get("duration_ms")))

    raw_axes = payload.get("axes")
    if not isinstance(raw_axes, dict):
        raise ValueError("selector_axes_not_object")
    if not raw_axes:
        raise ValueError("selector_axes_empty")

    prompt_axes = profile_prompt_axes(semantic_profile)
    allowed_axes = {str(axis.get("id") or "").strip(): axis for axis in prompt_axes}
    allowed_axis_count = len(allowed_axes)
    max_axis_errors = _max_axis_error_count(allowed_axis_count)
    normalized_axes: dict[str, float] = {}
    axis_errors: list[str] = []
    axis_warnings: list[str] = []
    for raw_axis_id, raw_value in raw_axes.items():
        axis_id = str(raw_axis_id or "").strip()
        if axis_id not in allowed_axes:
            axis_errors.append(f"selector_axis_not_allowed:{axis_id}")
            continue
        if isinstance(raw_value, dict):
            raise ValueError(f"selector_axis_payload_invalid:{axis_id}")
        value = _coerce_finite_number(raw_value)
        if value is None:
            axis_errors.append(f"selector_axis_not_number:{axis_id}")
            continue
        axis = allowed_axes[axis_id]
        value_range = axis.get("value_range")
        min_value = 0.0
        max_value = 100.0
        if (
            isinstance(value_range, list)
            and len(value_range) == 2
            and isinstance(value_range[0], (int, float))
            and isinstance(value_range[1], (int, float))
        ):
            min_value = float(value_range[0])
            max_value = float(value_range[1])
        if value < min_value or value > max_value:
            clamped_value = min_value if value < min_value else max_value
            axis_warnings.append(
                f"selector_axis_clamped:{axis_id}:{value:g}->{clamped_value:g}"
            )
            value = clamped_value
        normalized_axes[axis_id] = round(value, 4)

    if len(axis_errors) > max_axis_errors:
        raise ValueError(
            "selector_axis_error_rate_exceeded:"
            f"{len(axis_errors)}/{allowed_axis_count}:{','.join(axis_errors)}"
        )
    if axis_errors:
        LOGGER.warning(
            "Realtime motion selector ignored invalid semantic axes within threshold. errors=%s threshold=%s/%s",
            ",".join(axis_errors),
            max_axis_errors,
            allowed_axis_count,
        )
    if axis_warnings:
        LOGGER.warning(
            "Realtime motion selector clamped semantic axis values. warnings=%s",
            ",".join(axis_warnings),
        )
    if not normalized_axes:
        raise ValueError("selector_axes_empty_after_error_filter")

    normalized_axes = _apply_expressive_floor_v2(
        axes=normalized_axes,
        emotion=emotion,
        semantic_profile=semantic_profile,
    )

    return {
        "intent_tags": intent_tags,
        "emotion": emotion,
        "duration_ms": duration_ms,
        "resource_id": normalize_motion_resource_id(payload.get("resource_id")),
        "fallback_pose_id": "",
        "axes": normalized_axes,
        "warnings": axis_warnings + axis_errors,
    }


def build_intent_from_selector(
    selector_output: dict[str, Any],
    *,
    semantic_profile: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if semantic_profile is not None:
        return build_intent_from_selector_v3(selector_output, semantic_profile=semantic_profile)
    raise ValueError("semantic_profile_required")


def build_intent_from_selector_v2(
    selector_output: dict[str, Any],
    *,
    semantic_profile: dict[str, Any],
) -> dict[str, Any]:
    axes = selector_output.get("axes")
    if not isinstance(axes, dict) or not axes:
        raise ValueError("selector_axes_not_object")

    requested_mode = str(selector_output.get("mode") or "").strip().lower()
    if requested_mode not in {"idle", "expressive"}:
        raise ValueError("selector_mode_invalid")
    mode = requested_mode

    duration_ms_raw = selector_output.get("duration_ms")
    if not isinstance(duration_ms_raw, (int, float)):
        raise ValueError("selector_duration_ms_not_number")
    duration_hint_ms = int(round(float(duration_ms_raw)))
    if duration_hint_ms < 320 or duration_hint_ms > 15000:
        raise ValueError("selector_duration_ms_out_of_range")

    emotion_label = str(selector_output.get("emotion") or "").strip()
    if not emotion_label:
        raise ValueError("selector_emotion_empty")

    profile_revision_raw = semantic_profile.get("revision")
    try:
        profile_revision = int(profile_revision_raw)
    except (TypeError, ValueError):
        raise ValueError("semantic_profile_revision_invalid") from None

    return {
        "schema_version": MOTION_INTENT_V2_SCHEMA_VERSION,
        "profile_id": str(semantic_profile.get("profile_id") or "").strip(),
        "profile_revision": profile_revision,
        "model_id": str(semantic_profile.get("model_id") or "").strip(),
        "mode": mode,
        "emotion_label": emotion_label,
        "duration_hint_ms": duration_hint_ms,
        "axes": {
            str(axis_id): {"value": value}
            for axis_id, value in axes.items()
        },
        "summary": {
            "axis_count": len(axes),
        },
    }


def build_intent_from_selector_v3(
    selector_output: dict[str, Any],
    *,
    semantic_profile: dict[str, Any],
) -> dict[str, Any]:
    axes = selector_output.get("axes")
    if not isinstance(axes, dict) or not axes:
        raise ValueError("selector_axes_not_object")

    duration_ms_raw = selector_output.get("duration_ms")
    duration_hint_ms = _normalize_duration_hint_ms(duration_ms_raw)

    intent_tags = normalize_motion_intent_tags(selector_output.get("intent_tags"))
    if not intent_tags:
        raise ValueError("selector_intent_tags_empty")
    emotion_label = derive_motion_emotion_label(intent_tags)

    profile_revision_raw = semantic_profile.get("revision")
    try:
        profile_revision = int(profile_revision_raw)
    except (TypeError, ValueError):
        raise ValueError("semantic_profile_revision_invalid") from None

    return {
        "schema_version": MOTION_INTENT_V3_SCHEMA_VERSION,
        "profile_id": str(semantic_profile.get("profile_id") or "").strip(),
        "profile_revision": profile_revision,
        "model_id": str(semantic_profile.get("model_id") or "").strip(),
        "mode": "expressive",
        "intent_tags": intent_tags,
        "emotion_label": emotion_label,
        "duration_hint_ms": duration_hint_ms,
        "resource_id": normalize_motion_resource_id(selector_output.get("resource_id")),
        "fallback_pose_id": "",
        "axes": {
            str(axis_id): round(float(value), 4)
            for axis_id, value in axes.items()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        },
        "summary": {
            "axis_count": len(axes),
            "intent_tag_count": len(intent_tags),
        },
    }


def _extract_json_object(text: str) -> dict[str, Any]:
    normalized = str(text or "").strip()
    if not normalized:
        raise ValueError("Selector response is empty.")

    try:
        payload = json.loads(normalized)
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", normalized, flags=re.DOTALL)
    if not match:
        raise ValueError("Selector response does not contain a JSON object.")

    payload = json.loads(match.group(0))
    if not isinstance(payload, dict):
        raise ValueError("Selector payload is not a JSON object.")
    return payload
