from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = PROJECT_ROOT.parents[1]

CONTINUOUS_TRAINING_SYSTEM_PROMPT = """You generate one AG99live training action JSON object from the supplied dialogue context. Return only JSON, with no markdown or explanation. The output must contain exactly two fields: motion_steps and duration_hint_ms. motion_steps must contain 1 to 4 steps in playback order, including one step even for a single stable pose. Every step must contain exactly axis_values and duration_weight. axis_values maps semantic axis IDs to concrete numeric values inside each axis value_range; do not use discrete levels or axis_levels. duration_weight is an integer from 1 to 3. duration_hint_ms is an integer from 320 to 15000 and is required. Keep steps sparse: write only axes that start or change in that step. Do not output motion_guidance, neurobrain_state, intent_tags, resource IDs, schema metadata, or any other field."""

# Historical labels used -4..4. These fractions approximate the old profile's
# semantic anchors when an old captured prompt does not contain the profile.
LEGACY_LEVEL_FRACTIONS = {0: 0.0, 1: 0.30, 2: 0.50, 3: 0.70, 4: 1.00}


def _load_reducer():
    sys.path.insert(0, str(REPOSITORY_ROOT))
    from tools import persona_motion_dataset

    return persona_motion_dataset


def _parse_request_prompt(request: dict[str, Any]) -> dict[str, Any] | None:
    prompt = request.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return None
    try:
        payload = json.loads(prompt)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    if not isinstance(payload.get("segment"), dict):
        return None
    return payload


def _select_training_target(
    sample: dict[str, Any],
    *,
    teacher_provider_id: str | None = None,
    teacher_fallback_primary: bool = False,
) -> tuple[dict[str, Any] | None, str]:
    motion = sample.get("motion", {})
    if not isinstance(motion, dict):
        return None, "missing"
    if teacher_provider_id:
        candidates = motion.get("provider_candidates")
        if isinstance(candidates, list):
            for candidate in reversed(candidates):
                if not isinstance(candidate, dict):
                    continue
                if (
                    candidate.get("candidate_role") == "shadow"
                    and str(candidate.get("provider_id") or "").strip()
                    == teacher_provider_id
                    and candidate.get("status") == "shadow_provider_normalized"
                    and candidate.get("provider_final") is False
                    and isinstance(candidate.get("accepted_payload"), dict)
                ):
                    return candidate["accepted_payload"], "shadow_teacher"
        if teacher_fallback_primary and isinstance(motion.get("target_payload"), dict):
            return motion["target_payload"], "primary_fallback"
        return None, "teacher_candidate_missing"
    payload = motion.get("target_payload")
    return (payload, "primary_final") if isinstance(payload, dict) else (None, "missing")


def _parse_capability(system_prompt: str) -> dict[str, Any]:
    marker = "Live2D 能力："
    if not isinstance(system_prompt, str) or marker not in system_prompt:
        return {}
    suffix = system_prompt.split(marker, 1)[1].lstrip()
    try:
        value, _ = json.JSONDecoder().raw_decode(suffix)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _axis_spec(axis: Any) -> dict[str, Any] | None:
    if not isinstance(axis, dict):
        return None
    axis_id = str(axis.get("id") or "").strip()
    if not axis_id:
        return None
    raw_range = axis.get("value_range")
    if (
        isinstance(raw_range, (list, tuple))
        and len(raw_range) == 2
        and _finite_number(raw_range[0]) is not None
        and _finite_number(raw_range[1]) is not None
        and float(raw_range[0]) < float(raw_range[1])
    ):
        low, high = float(raw_range[0]), float(raw_range[1])
    else:
        low, high = 0.0, 100.0
    neutral = _finite_number(axis.get("neutral"))
    if neutral is None:
        neutral = (low + high) / 2.0
    neutral = min(high, max(low, neutral))
    anchors: dict[int, float] = {}
    raw_anchors = axis.get("level_anchors")
    if isinstance(raw_anchors, dict):
        for raw_level, raw_value in raw_anchors.items():
            try:
                level = int(raw_level)
            except (TypeError, ValueError):
                continue
            number = _finite_number(raw_value)
            if number is not None and -4 <= level <= 4:
                anchors[level] = min(high, max(low, number))
    return {
        "id": axis_id,
        "label": str(axis.get("label") or axis_id).strip(),
        "value_range": [low, high],
        "neutral": neutral,
        "level_anchors": anchors,
    }


def _axis_specs_for_request(
    request: dict[str, Any],
    target_axis_ids: set[str],
) -> dict[str, dict[str, Any]]:
    capability = _parse_capability(str(request.get("system_prompt") or ""))
    specs: dict[str, dict[str, Any]] = {}
    for axis in capability.get("axes") or []:
        spec = _axis_spec(axis)
        if spec is not None:
            specs[spec["id"]] = spec
    for axis_id in sorted(target_axis_ids):
        if axis_id and axis_id not in specs:
            spec = _axis_spec({"id": axis_id})
            if spec is not None:
                specs[axis_id] = spec
    return specs


def _legacy_level_value(level: int, spec: dict[str, Any]) -> float:
    anchors = spec.get("level_anchors") or {}
    if level in anchors:
        return round(float(anchors[level]), 3)
    low, high = (float(value) for value in spec["value_range"])
    neutral = float(spec["neutral"])
    if level == 0:
        return round(neutral, 3)
    fraction = LEGACY_LEVEL_FRACTIONS[abs(level)]
    span = high - neutral if level > 0 else neutral - low
    return round(neutral + (span if level > 0 else -span) * fraction, 3)


def _normalize_axis_values(
    raw_values: Any,
    specs: dict[str, dict[str, Any]],
) -> dict[str, float] | None:
    if not isinstance(raw_values, dict) or not raw_values:
        return None
    values: dict[str, float] = {}
    for raw_axis_id, raw_value in raw_values.items():
        axis_id = str(raw_axis_id or "").strip()
        number = _finite_number(raw_value)
        if not axis_id or number is None:
            return None
        spec = specs.get(axis_id)
        if spec is None:
            spec = _axis_spec({"id": axis_id})
            if spec is None:
                return None
            specs[axis_id] = spec
        low, high = (float(value) for value in spec["value_range"])
        if number < low or number > high:
            return None
        values[axis_id] = round(number, 3)
    return values


def _convert_axis_levels(
    raw_levels: Any,
    specs: dict[str, dict[str, Any]],
) -> dict[str, float] | None:
    if not isinstance(raw_levels, dict) or not raw_levels:
        return None
    values: dict[str, float] = {}
    for raw_axis_id, raw_level in raw_levels.items():
        axis_id = str(raw_axis_id or "").strip()
        if not axis_id or type(raw_level) is not int or not -4 <= raw_level <= 4:
            return None
        spec = specs.get(axis_id)
        if spec is None:
            spec = _axis_spec({"id": axis_id})
            if spec is None:
                return None
            specs[axis_id] = spec
        values[axis_id] = _legacy_level_value(raw_level, spec)
    return values


def _convert_motion_target(
    target: dict[str, Any],
    request: dict[str, Any],
) -> tuple[dict[str, Any] | None, str, str]:
    shapes = {
        key
        for key in ("axis_levels", "axis_values", "motion_steps", "motion_resource_id")
        if key in target
    }
    source_shape = next(iter(shapes), "missing") if len(shapes) == 1 else "conflict"
    if len(shapes) != 1 or "motion_resource_id" in shapes:
        return None, source_shape, "unsupported_motion_shape"
    duration = target.get("duration_hint_ms")
    if type(duration) is not int or not 320 <= duration <= 15000:
        return None, source_shape, "duration_hint_ms_required"

    if "motion_steps" in target:
        raw_steps = target.get("motion_steps")
        if isinstance(raw_steps, list):
            target_axis_ids = {
                str(axis_id).strip()
                for step in raw_steps
                if isinstance(step, dict)
                for axis_id in (step.get("axis_values") or step.get("axis_levels") or {})
                if str(axis_id).strip()
            }
        else:
            target_axis_ids = set()
    else:
        raw_values = target.get("axis_values") or target.get("axis_levels") or {}
        target_axis_ids = {str(axis_id).strip() for axis_id in raw_values if str(axis_id).strip()}
    specs = _axis_specs_for_request(request, target_axis_ids)

    converted_legacy = False
    if "motion_steps" in target:
        raw_steps = target.get("motion_steps")
        if not isinstance(raw_steps, list) or not 1 <= len(raw_steps) <= 4:
            return None, source_shape, "motion_steps_length"
        steps: list[dict[str, Any]] = []
        for raw_step in raw_steps:
            if not isinstance(raw_step, dict):
                return None, source_shape, "motion_step_shape"
            has_values = "axis_values" in raw_step
            has_levels = "axis_levels" in raw_step
            if has_values == has_levels:
                return None, source_shape, "motion_step_axis_shape"
            if has_values:
                values = _normalize_axis_values(raw_step.get("axis_values"), specs)
            else:
                values = _convert_axis_levels(raw_step.get("axis_levels"), specs)
                converted_legacy = True
            if values is None:
                return None, source_shape, "motion_step_axis_values"
            weight = raw_step.get("duration_weight", 1)
            if type(weight) is not int or not 1 <= weight <= 3:
                return None, source_shape, "duration_weight"
            steps.append({"axis_values": values, "duration_weight": weight})
    else:
        if "axis_values" in target:
            values = _normalize_axis_values(target.get("axis_values"), specs)
        else:
            values = _convert_axis_levels(target.get("axis_levels"), specs)
            converted_legacy = True
        if values is None:
            return None, source_shape, "axis_values"
        steps = [{"axis_values": values, "duration_weight": 1}]

    output = {"motion_steps": steps, "duration_hint_ms": duration}
    return output, source_shape, "converted_legacy" if converted_legacy else "native"


def _training_capability(
    request: dict[str, Any],
    target: dict[str, Any],
) -> dict[str, Any]:
    target_axis_ids = {
        str(axis_id).strip()
        for step in target.get("motion_steps") or []
        if isinstance(step, dict)
        for axis_id in (step.get("axis_values") or {})
        if str(axis_id).strip()
    }
    specs = _axis_specs_for_request(request, target_axis_ids)
    raw_capability = _parse_capability(str(request.get("system_prompt") or ""))
    raw_by_id = {
        str(axis.get("id") or "").strip(): axis
        for axis in raw_capability.get("axes") or []
        if isinstance(axis, dict) and str(axis.get("id") or "").strip()
    }
    axes = []
    for axis_id in sorted(specs):
        spec = specs[axis_id]
        item = {
            "id": axis_id,
            "label": spec["label"],
            "value_range": [
                round(float(spec["value_range"][0]), 3),
                round(float(spec["value_range"][1]), 3),
            ],
            "neutral": round(float(spec["neutral"]), 3),
        }
        raw = raw_by_id.get(axis_id, {})
        for key in ("negative_semantics", "positive_semantics", "usage_notes"):
            value = raw.get(key)
            if value not in (None, "", []):
                item[key] = value
        axes.append(item)
    return {
        "axis_value_format": "axis_values",
        "motion_plan_limits": {"min_motion_steps": 1, "max_motion_steps": 4},
        "axes": axes,
    }


def _compact_training_prompt(prompt_payload: dict[str, Any]) -> str:
    segment = prompt_payload.get("segment")
    segment = segment if isinstance(segment, dict) else {}
    compact_segment = {
        "speech": segment.get("speech", ""),
        "actions": segment.get("actions", []),
        "tendency": segment.get("tendency", {}),
    }
    return json.dumps(
        {"user": prompt_payload.get("user", ""), "segment": compact_segment},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _continuous_system_prompt(capability: dict[str, Any]) -> str:
    return (
        CONTINUOUS_TRAINING_SYSTEM_PROMPT
        + "\n\nLive2D 能力：\n"
        + json.dumps(capability, ensure_ascii=False, separators=(",", ":"))
    )


def _quality_allows_training(
    sample: dict[str, Any],
    request: dict[str, Any],
    *,
    relaxed_quality: bool,
) -> bool:
    # NeuroBrain is intentionally stripped from the new training input. A
    # sample blocked only because that state was recorded is still usable.
    neurobrain_state = request.get("neurobrain_state")
    has_neurobrain_state = isinstance(neurobrain_state, dict) and bool(neurobrain_state)
    if relaxed_quality:
        return True
    quality = sample.get("quality", {})
    raw_blockers = quality.get("blockers")
    blockers = {
        str(blocker).strip()
        for blocker in (raw_blockers if isinstance(raw_blockers, list) else [])
        if str(blocker).strip()
    }
    if has_neurobrain_state:
        return (
            quality.get("status") == "blocked"
            and blockers <= {"neurobrain_state_present"}
            and quality.get("neurobrain_state_present") is True
        )
    return (
        quality.get("status") == "reviewable"
        and not blockers
        and quality.get("neurobrain_state_present") is False
    )


def _continuous_training_record(
    sample: dict[str, Any],
    reducer: Any,
    *,
    teacher_provider_id: str | None = None,
    teacher_fallback_primary: bool = False,
    relaxed_quality: bool = False,
    all_delivery_modes: bool = False,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str, str]:
    request = sample.get("input", {}).get("motion_request")
    if not isinstance(request, dict):
        return None, None, "missing", "motion_request"
    target, target_origin = _select_training_target(
        sample,
        teacher_provider_id=teacher_provider_id,
        teacher_fallback_primary=teacher_fallback_primary,
    )
    if target is None:
        return None, None, target_origin, "target"
    if (
        sample.get("collection_status") != "closed"
        or sample.get("source_route") != "independent_motion"
        or (
            not all_delivery_modes
            and sample.get("delivery_mode") != "M2_olv_incremental"
        )
        or (
            all_delivery_modes
            and sample.get("delivery_mode") not in {"M0_nonstreaming", "M2_olv_incremental"}
        )
        or not _quality_allows_training(sample, request, relaxed_quality=relaxed_quality)
    ):
        return None, None, target_origin, "quality_or_scope"
    prompt_payload = _parse_request_prompt(request)
    if prompt_payload is None:
        return None, None, target_origin, "prompt"
    segment = prompt_payload.get("segment")
    if not isinstance(segment, dict):
        return None, None, target_origin, "prompt_segment"
    if not str(segment.get("speech") or "").strip():
        historical_speech = sample.get("persona_segment", {}).get("speech")
        if isinstance(historical_speech, str) and historical_speech.strip():
            segment["speech"] = historical_speech
        else:
            return None, None, target_origin, "prompt_speech"
    converted, source_shape, conversion_status = _convert_motion_target(target, request)
    if converted is None:
        return None, None, target_origin, conversion_status
    capability = _training_capability(request, converted)
    contexts = sample.get("input", {}).get("recent_context")
    if not isinstance(contexts, list):
        return None, None, target_origin, "contexts"
    conversation: list[dict[str, str]] = []
    for context in contexts:
        if (
            not isinstance(context, dict)
            or context.get("role") not in {"user", "assistant"}
            or not isinstance(context.get("content"), str)
        ):
            return None, None, target_origin, "context_message"
        message = {"role": context["role"], "content": context["content"]}
        if conversation and conversation[-1]["role"] == message["role"]:
            conversation[-1]["content"] += "\n\n" + message["content"]
        else:
            conversation.append(message)
    compact_prompt = _compact_training_prompt(prompt_payload)
    if conversation and conversation[-1]["role"] == "user":
        conversation[-1]["content"] += "\n\n" + compact_prompt
    else:
        conversation.append({"role": "user", "content": compact_prompt})
    messages = [
        {"role": "system", "content": _continuous_system_prompt(capability)},
        *conversation,
        {"role": "assistant", "content": reducer._stable_json(converted)},
    ]
    return {"messages": messages}, converted, source_shape, conversion_status


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build the destructive AG99live continuous-action SFT set."
    )
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument(
        "--output-dir", type=Path, default=PROJECT_ROOT / "data" / "continuous"
    )
    parser.add_argument(
        "--teacher-provider-id",
        help="use a successful normalized shadow candidate as the SFT target",
    )
    parser.add_argument(
        "--teacher-fallback-primary",
        action="store_true",
        help="use the primary final result when the requested shadow teacher is missing",
    )
    parser.add_argument(
        "--relaxed-quality",
        action="store_true",
        help="keep closed, parseable targets while ignoring review blockers",
    )
    parser.add_argument(
        "--all-delivery-modes",
        action="store_true",
        help="include both M0_nonstreaming and M2_olv_incremental samples",
    )
    args = parser.parse_args()
    teacher_provider_id = str(args.teacher_provider_id or "").strip() or None

    reducer = _load_reducer()
    samples, _, malformed = reducer._reduce_database(args.db)
    records: list[dict[str, Any]] = []
    source_shapes: Counter[str] = Counter()
    conversion_statuses: Counter[str] = Counter()
    skip_reasons: Counter[str] = Counter()
    target_origin_counts: Counter[str] = Counter()
    teacher_candidate_missing = 0
    for sample in samples:
        if teacher_provider_id:
            _, origin = _select_training_target(
                sample,
                teacher_provider_id=teacher_provider_id,
                teacher_fallback_primary=args.teacher_fallback_primary,
            )
            if origin == "teacher_candidate_missing":
                teacher_candidate_missing += 1
        record, target, source_shape, status = _continuous_training_record(
            sample,
            reducer,
            teacher_provider_id=teacher_provider_id,
            teacher_fallback_primary=args.teacher_fallback_primary,
            relaxed_quality=args.relaxed_quality,
            all_delivery_modes=args.all_delivery_modes,
        )
        if record is None or target is None:
            skip_reasons[status] += 1
            continue
        records.append(record)
        source_shapes[source_shape] += 1
        conversion_statuses[status] += 1
        _, target_origin = _select_training_target(
            sample,
            teacher_provider_id=teacher_provider_id,
            teacher_fallback_primary=args.teacher_fallback_primary,
        )
        target_origin_counts[target_origin] += 1
    if not records:
        raise SystemExit(
            "No eligible continuous-action samples found; "
            + json.dumps(dict(skip_reasons), ensure_ascii=False, sort_keys=True)
        )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    data_path = args.output_dir / "continuous_sft.jsonl"
    info_path = args.output_dir / "dataset_info.json"
    with data_path.open("w", encoding="utf-8", newline="\n") as stream:
        for record in records:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
    info_path.write_text(
        json.dumps(
            {
                "spark_x26_continuous": {
                    "file_name": data_path.name,
                    "formatting": "openai",
                    "columns": {"messages": "messages"},
                    "tags": {
                        "role_tag": "role",
                        "content_tag": "content",
                        "user_tag": "user",
                        "assistant_tag": "assistant",
                        "system_tag": "system",
                        "observation_tag": "tool",
                        "function_tag": "function",
                    },
                }
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "dataset": str(data_path.resolve()),
                "samples": len(records),
                "output_fields": ["motion_steps", "duration_hint_ms"],
                "motion_steps_required": True,
                "duration_hint_ms_required": True,
                "source_motion_shapes": dict(source_shapes),
                "conversion_statuses": dict(conversion_statuses),
                "skipped": dict(skip_reasons),
                "teacher_provider_id": teacher_provider_id,
                "teacher_fallback_primary": args.teacher_fallback_primary,
                "relaxed_quality": args.relaxed_quality,
                "all_delivery_modes": args.all_delivery_modes,
                "target_origins": dict(target_origin_counts),
                "teacher_candidate_missing": teacher_candidate_missing,
                "malformed_raw_events": len(malformed),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
