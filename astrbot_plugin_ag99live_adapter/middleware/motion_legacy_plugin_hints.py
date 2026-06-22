from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any


def resolve_plugin_hints_motion_payload(
    event: Any,
    runtime_state: Any,
    *,
    view: Any = None,
    normalize_motion_arguments_payload,
    call_event_method,
    append_resolution_reason,
) -> dict[str, Any] | None:
    payload, _reason = resolve_plugin_hints_motion_payload_with_reason(
        event,
        runtime_state,
        view=view,
        normalize_motion_arguments_payload=normalize_motion_arguments_payload,
        call_event_method=call_event_method,
        append_resolution_reason=append_resolution_reason,
    )
    return payload


def resolve_plugin_hints_motion_payload_with_reason(
    event: Any,
    runtime_state: Any,
    *,
    view: Any = None,
    normalize_motion_arguments_payload,
    call_event_method,
    append_resolution_reason,
) -> tuple[dict[str, Any] | None, str]:
    hints = extract_plugin_hints_from_view(view) if view is not None else None
    if hints is None:
        hints = call_event_method(event, "get_extra", "_interaction_plugin_hints")
    hints, hints_reason = coerce_plugin_hints_mapping_with_reason(
        hints,
        append_resolution_reason=append_resolution_reason,
    )
    if not isinstance(hints, dict):
        return None, hints_reason

    raw_motion_hint = hints.get("ag99live_motion")
    if not isinstance(raw_motion_hint, dict):
        return None, append_resolution_reason(hints_reason, "ag99live_motion_missing")

    return normalize_motion_arguments_payload(
        raw_motion_hint,
        runtime_state,
        base_reason=hints_reason,
    )


def log_plugin_hints_motion_resolution(
    event: Any,
    *,
    phase: str,
    payload: dict[str, Any] | None,
    reason: str,
    view: Any = None,
    logger,
    call_event_method,
) -> None:
    hints = extract_plugin_hints_from_view(view) if view is not None else None
    if hints is None:
        hints = call_event_method(event, "get_extra", "_interaction_plugin_hints")
    hints = coerce_plugin_hints_mapping(hints)
    hint_keys: list[str] = []
    motion_axes_keys: list[str] = []
    if isinstance(hints, dict):
        hint_keys = sorted(str(key).strip() for key in hints.keys() if str(key).strip())
        motion_hint = hints.get("ag99live_motion")
        if isinstance(motion_hint, dict):
            axes = motion_hint.get("axes")
            if isinstance(axes, dict):
                motion_axes_keys = sorted(
                    str(key).strip() for key in axes.keys() if str(key).strip()
                )

    logger.info(
        "WIRING plugin_hints_motion phase=%s payload_present=%s reason=%s hint_keys=%s motion_axes=%s",
        phase or "",
        payload is not None,
        reason,
        ",".join(hint_keys),
        ",".join(motion_axes_keys),
    )


def coerce_plugin_hints_mapping(value: Any) -> dict[str, Any] | None:
    hints, _reason = coerce_plugin_hints_mapping_with_reason(
        value,
        append_resolution_reason=_append_resolution_reason_local,
    )
    return hints


def coerce_plugin_hints_mapping_with_reason(
    value: Any,
    *,
    append_resolution_reason,
) -> tuple[dict[str, Any] | None, str]:
    if isinstance(value, Mapping):
        return thaw_plugin_hints_value(value), "ok"
    if not isinstance(value, str):
        return None, "plugin_hints_missing"

    raw_value = value.strip()
    if not raw_value:
        return None, "plugin_hints_missing"
    return parse_json_mapping_lenient(
        raw_value,
        append_resolution_reason=append_resolution_reason,
    )


def thaw_plugin_hints_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): thaw_plugin_hints_value(item)
            for key, item in value.items()
        }
    if isinstance(value, tuple):
        return [thaw_plugin_hints_value(item) for item in value]
    if isinstance(value, list):
        return [thaw_plugin_hints_value(item) for item in value]
    return value


def parse_json_mapping_lenient(
    raw_value: str,
    *,
    append_resolution_reason,
) -> tuple[dict[str, Any] | None, str]:
    attempts: list[tuple[str, str]] = [("ok", raw_value)]

    fenced = extract_fenced_json(raw_value)
    if fenced and fenced != raw_value:
        attempts.append(("plugin_hints_json_repaired:fenced_json", fenced))

    extracted = extract_first_json_object(raw_value)
    if extracted and extracted not in {raw_value, fenced}:
        attempts.append(("plugin_hints_json_repaired:extracted_object", extracted))

    expanded_attempts: list[tuple[str, str]] = []
    seen: set[str] = set()
    for reason, candidate in attempts:
        if candidate not in seen:
            expanded_attempts.append((reason, candidate))
            seen.add(candidate)
        trailing_fixed = strip_json_trailing_commas(candidate)
        if trailing_fixed != candidate and trailing_fixed not in seen:
            expanded_attempts.append(
                (
                    append_resolution_reason(
                        reason,
                        "plugin_hints_json_repaired:trailing_commas",
                    ),
                    trailing_fixed,
                )
            )
            seen.add(trailing_fixed)

    for reason, candidate in expanded_attempts:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        mapping = unwrap_plugin_hints_mapping(parsed)
        if isinstance(mapping, dict):
            return mapping, reason

    return None, "plugin_hints_json_rejected:json_decode_failed"


def extract_fenced_json(raw_value: str) -> str | None:
    match = re.search(
        r"```(?:json|JSON)?\s*([\s\S]*?)\s*```",
        raw_value,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    return match.group(1).strip() or None


def extract_first_json_object(raw_value: str) -> str | None:
    start = raw_value.find("{")
    if start < 0:
        return None
    in_string = False
    escaped = False
    depth = 0
    for index in range(start, len(raw_value)):
        char = raw_value[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            continue
        if char == "{":
            depth += 1
            continue
        if char == "}":
            depth -= 1
            if depth == 0:
                return raw_value[start : index + 1].strip()
    return None


def strip_json_trailing_commas(value: str) -> str:
    output: list[str] = []
    in_string = False
    escaped = False
    index = 0
    while index < len(value):
        char = value[index]
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
            index += 1
            continue
        if char == ",":
            next_index = index + 1
            while next_index < len(value) and value[next_index].isspace():
                next_index += 1
            if next_index < len(value) and value[next_index] in "}]":
                index += 1
                continue
        output.append(char)
        index += 1
    return "".join(output)


def unwrap_plugin_hints_mapping(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    if isinstance(value.get("ag99live_motion"), dict):
        return value
    plugin_hints = value.get("plugin_hints")
    if isinstance(plugin_hints, dict):
        if isinstance(plugin_hints.get("ag99live_motion"), dict):
            return plugin_hints
        nested = plugin_hints.get("plugin_hints")
        if isinstance(nested, dict) and isinstance(nested.get("ag99live_motion"), dict):
            return nested
    return value


def extract_plugin_hints_from_view(view: Any) -> Any:
    hints = getattr(view, "plugin_hints", None)
    if hints is not None:
        return hints

    metadata = getattr(view, "metadata", None)
    if isinstance(metadata, Mapping):
        hints = metadata.get("plugin_hints")
    elif callable(getattr(metadata, "get", None)):
        hints = metadata.get("plugin_hints")
    if hints is not None:
        return hints

    result = getattr(view, "result", None)
    if result is not None:
        hints = getattr(result, "plugin_hints", None)
        if hints is not None:
            return hints

    return None


def _append_resolution_reason_local(base: str | None, suffix: str) -> str:
    normalized_base = str(base or "").strip()
    normalized_suffix = str(suffix or "").strip()
    if not normalized_base:
        return normalized_suffix
    if not normalized_suffix:
        return normalized_base
    return f"{normalized_base}:{normalized_suffix}"
