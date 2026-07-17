from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass
from typing import Any

from astrbot.api import logger

from ..protocol.schema_versions import PERFORMANCE_CURVE_HINT_SCHEMA_VERSION

from ..prompts.performance_curve import (
    PERFORMANCE_CURVE_SYSTEM_PROMPT,
    build_performance_curve_prompt,
)
from .observation import record_motion_observation

CURVE_FAMILIES = {
    "default",
    "quick_in_hold_soft_out",
    "slow_in_hold_quick_out",
    "pulse_then_settle",
    "soft_breathe",
}
ENTRIES = {"instant", "quick", "soft", "slow"}
HOLDS = {"short", "steady", "long", "breathing"}
EXITS = {"quick", "soft", "slow"}
EMPHASES = {"none", "early", "middle", "late", "punctuated"}
ENERGIES = {"low", "medium", "high", "teasing", "calm"}

_MAX_RETAINED_RESULTS = 64


@dataclass(slots=True)
class PerformanceCurveInput:
    turn_id: str
    message_id: str
    assistant_text: str
    assistant_reply_keywords: list[str]
    motion_intent_tags: list[str]
    motion_effect_summary: dict[str, Any] | None
    chat_context: list[dict[str, str]]


class PerformanceCurveRuntime:
    """Best-effort small-model runtime for symbolic performance curve hints."""

    def __init__(self, *, runtime_state: Any) -> None:
        self.runtime_state = runtime_state
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._results: dict[str, dict[str, Any]] = {}
        self._requests: dict[str, PerformanceCurveInput] = {}
        self._requested_keys: set[str] = set()

    def start(self, request: PerformanceCurveInput) -> bool:
        if not self._is_enabled():
            return False
        key = _build_curve_key(request.turn_id, request.message_id)
        if not key or not request.assistant_text.strip():
            return False
        if key in self._requested_keys:
            return False
        self._requested_keys.add(key)

        self._record_event(
            "performance_curve.requested",
            request=request,
            payload_kind=PERFORMANCE_CURVE_HINT_SCHEMA_VERSION,
            raw={
                "assistant_reply_keywords": request.assistant_reply_keywords,
                "motion_intent_tags": request.motion_intent_tags,
                "motion_effect_summary": request.motion_effect_summary or {},
            },
        )
        task = asyncio.create_task(self._run(key, request))
        self._tasks[key] = task
        self._requests[key] = request
        self._prune_retained_results()
        return True

    def get_ready(self, *, turn_id: str | None, message_id: str | None) -> dict[str, Any] | None:
        key = _build_curve_key(turn_id, message_id)
        if not key:
            return None
        task = self._tasks.get(key)
        if task is not None and not task.done():
            return None
        result = self._results.get(key)
        if not isinstance(result, dict):
            return None
        return dict(result)

    def clear(self, *, turn_id: str | None, message_id: str | None) -> None:
        key = _build_curve_key(turn_id, message_id)
        if not key:
            return
        task = self._tasks.get(key)
        if task is not None and not task.done():
            task.cancel()
        self._tasks.pop(key, None)
        self._results.pop(key, None)
        self._requests.pop(key, None)

    def fail_if_not_ready(
        self,
        *,
        turn_id: str | None,
        message_id: str | None,
        reason: str,
    ) -> bool:
        key = _build_curve_key(turn_id, message_id)
        if not key:
            return False
        task = self._tasks.get(key)
        if key in self._results:
            return False
        request = self._requests.get(key)
        if request is None:
            return False
        if task is not None and not task.done():
            task.cancel()
        self._record_failed(request, reason, latency_ms=0)
        self.clear(turn_id=turn_id, message_id=message_id)
        return True

    def cancel_turn(self, turn_id: str | None) -> None:
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            return
        prefix = f"{normalized_turn_id}:"
        for key, task in list(self._tasks.items()):
            if not key.startswith(prefix):
                continue
            if not task.done():
                task.cancel()
            self._tasks.pop(key, None)
            self._results.pop(key, None)
            self._requests.pop(key, None)
        self._requested_keys = {
            key for key in self._requested_keys if not key.startswith(prefix)
        }

    async def _run(self, key: str, request: PerformanceCurveInput) -> None:
        provider = getattr(self.runtime_state, "selected_performance_curve_provider", None)
        if provider is None:
            self._record_failed(request, "provider_unavailable", latency_ms=0)
            self._drop_cached_key(key)
            return

        prompt = build_performance_curve_prompt(
            turn_id=request.turn_id,
            message_id=request.message_id,
            assistant_text=request.assistant_text,
            assistant_reply_keywords=request.assistant_reply_keywords,
            motion_intent_tags=request.motion_intent_tags,
            motion_effect_summary=request.motion_effect_summary,
            chat_context=request.chat_context,
        )
        started_at = time.perf_counter()
        try:
            response = await provider.text_chat(
                prompt=prompt,
                system_prompt=PERFORMANCE_CURVE_SYSTEM_PROMPT,
            )
            latency_ms = int((time.perf_counter() - started_at) * 1000)
            completion_text = str(getattr(response, "completion_text", "") or "").strip()
            hint = normalize_performance_curve_hint(_extract_json_object(completion_text))
            self._results[key] = hint
            self._drop_current_task(key)
            self._record_event(
                "performance_curve.resolved",
                request=request,
                payload_kind=PERFORMANCE_CURVE_HINT_SCHEMA_VERSION,
                raw={
                    "provider_id": _get_provider_id(provider),
                    "assistant_reply_keywords": request.assistant_reply_keywords,
                    "motion_intent_tags": request.motion_intent_tags,
                    "curve_hint": hint,
                    "completion_text": completion_text,
                    "latency_ms": latency_ms,
                },
            )
        except asyncio.CancelledError:
            self._drop_current_task(key)
            raise
        except Exception as exc:  # noqa: BLE001
            latency_ms = int((time.perf_counter() - started_at) * 1000)
            self._record_failed(request, str(exc), latency_ms=latency_ms)
            self._drop_cached_key(key)

    def _record_failed(
        self,
        request: PerformanceCurveInput,
        failure_reason: str,
        *,
        latency_ms: int,
    ) -> None:
        self._record_event(
            "performance_curve.failed",
            request=request,
            payload_kind=PERFORMANCE_CURVE_HINT_SCHEMA_VERSION,
            raw={
                "failure_reason": str(failure_reason or "").strip(),
                "latency_ms": max(int(latency_ms), 0),
            },
        )

    def _record_event(
        self,
        event_type: str,
        *,
        request: PerformanceCurveInput,
        payload_kind: str,
        raw: dict[str, Any],
    ) -> bool:
        return record_motion_observation(
            getattr(self.runtime_state, "motion_lab_recorder", None),
            event_type=event_type,
            turn_id=request.turn_id,
            message_id=request.message_id,
            source_route="performance_curve_provider",
            phase="performance_curve",
            assistant_text=request.assistant_text,
            payload_kind=payload_kind,
            raw=raw,
        )

    def _is_enabled(self) -> bool:
        return bool(getattr(self.runtime_state, "enable_performance_curve", False))

    def _drop_current_task(self, key: str) -> None:
        current_task = asyncio.current_task()
        if current_task is not None and self._tasks.get(key) is current_task:
            self._tasks.pop(key, None)

    def _drop_cached_key(self, key: str) -> None:
        self._drop_current_task(key)
        self._results.pop(key, None)
        self._requests.pop(key, None)

    def _prune_retained_results(self) -> None:
        while len(self._results) > _MAX_RETAINED_RESULTS:
            key = next(iter(self._results))
            self._results.pop(key, None)
            self._requests.pop(key, None)


def normalize_performance_curve_hint(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("performance_curve_hint_not_object")
    schema_version = str(value.get("schema_version") or "").strip()
    if schema_version != PERFORMANCE_CURVE_HINT_SCHEMA_VERSION:
        raise ValueError("performance_curve_hint_invalid_schema_version")

    return {
        "schema_version": PERFORMANCE_CURVE_HINT_SCHEMA_VERSION,
        "curve_family": _enum_value(value.get("curve_family"), CURVE_FAMILIES, "curve_family"),
        "entry": _enum_value(value.get("entry"), ENTRIES, "entry"),
        "hold": _enum_value(value.get("hold"), HOLDS, "hold"),
        "exit": _enum_value(value.get("exit"), EXITS, "exit"),
        "emphasis": _enum_value(value.get("emphasis"), EMPHASES, "emphasis"),
        "energy": _enum_value(value.get("energy"), ENERGIES, "energy"),
    }


def attach_performance_curve_hint(
    payload: dict[str, Any],
    hint: Any,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    try:
        normalized_hint = normalize_performance_curve_hint(hint)
    except ValueError:
        return payload, None
    next_payload = dict(payload)
    next_payload["performance_curve_hint"] = normalized_hint
    return next_payload, normalized_hint


def extract_assistant_reply_keywords(text: str, *, limit: int = 8) -> list[str]:
    raw_text = str(text or "").strip()
    if not raw_text:
        return []
    tokens = re.findall(r"[\w\u4e00-\u9fff]{2,}", raw_text, flags=re.UNICODE)
    seen: set[str] = set()
    keywords: list[str] = []
    for token in tokens:
        normalized = token.strip().lower()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        keywords.append(token.strip())
        if len(keywords) >= limit:
            break
    return keywords


def summarize_motion_for_curve(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    axes = payload.get("axis_levels")
    motion_steps = payload.get("motion_steps")
    if not isinstance(axes, dict) and isinstance(motion_steps, list):
        sequence_axis_ids: set[str] = set()
        for step in motion_steps:
            step_axes = step.get("axis_levels") if isinstance(step, dict) else None
            if not isinstance(step_axes, dict):
                continue
            sequence_axis_ids.update(
                str(axis_id).strip()
                for axis_id in step_axes
                if str(axis_id).strip()
            )
        axes = {axis_id: 0 for axis_id in sequence_axis_ids}
    if not isinstance(axes, dict):
        axes = payload.get("axes")
    return {
        "intent_tags": _normalize_string_list(payload.get("intent_tags"), limit=8),
        "axis_keys": sorted(str(key).strip() for key in (axes or {}).keys() if str(key).strip())
        if isinstance(axes, dict)
        else [],
        "motion_step_count": len(motion_steps) if isinstance(motion_steps, list) else 0,
        "expression_resource_id": str(
            payload.get("expression_resource_id") or ""
        ).strip(),
        "motion_resource_id": str(payload.get("motion_resource_id") or "").strip(),
        "resource_id": str(payload.get("resource_id") or "").strip(),
        "mode": str(payload.get("mode") or "").strip(),
    }


def _extract_json_object(text: str) -> dict[str, Any]:
    candidate = str(text or "").strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*", "", candidate, flags=re.IGNORECASE)
        candidate = re.sub(r"\s*```$", "", candidate)
    try:
        value = json.loads(candidate)
    except json.JSONDecodeError:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("performance_curve_completion_not_json") from None
        value = json.loads(candidate[start : end + 1])
    if not isinstance(value, dict):
        raise ValueError("performance_curve_completion_not_object")
    return value


def _enum_value(value: Any, allowed: set[str], field_name: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized not in allowed:
        raise ValueError(f"performance_curve_hint_invalid_{field_name}")
    return normalized


def _normalize_string_list(value: Any, *, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
        if len(result) >= limit:
            break
    return result


def _build_curve_key(turn_id: str | None, message_id: str | None) -> str:
    normalized_turn_id = str(turn_id or "").strip()
    normalized_message_id = str(message_id or "").strip() or "__default__"
    if not normalized_turn_id:
        return ""
    return f"{normalized_turn_id}:{normalized_message_id}"


def _get_provider_id(provider: Any) -> str:
    try:
        meta = provider.meta()
    except Exception:  # noqa: BLE001
        return ""
    return str(getattr(meta, "id", "") or "").strip()
