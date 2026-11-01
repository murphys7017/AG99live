from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = PROJECT_ROOT.parents[1]
EXPERIMENT_SYSTEM_PROMPT = """You generate one AG99live motion-intent JSON object from the supplied dialogue context. Return only JSON, with no markdown or explanation. Include schema_version exactly as engine.motion_intent.v4, non-empty model_id and profile_id strings, positive integer profile_revision, mode, and a non-empty emotion_label string. intent_tags are optional metadata. Include exactly one motion field: axis_levels object, motion_steps array, or motion_resource_id string. When the user or reply clearly asks for repeated, back-and-forth, or ordered visible motion, prefer 2-4 motion_steps that express its key pose changes in playback order; use axis_levels for one stable pose. Do not split steps by words, pauses, or speech rhythm. duration_hint_ms and summary may also be included. Copy model/profile identifiers from the prompt and never omit emotion_label."""
EXPERIMENT_NEUROBRAIN_SYSTEM_PROMPT = """You generate one AG99live motion-intent JSON object from the supplied dialogue, Persona segment, and optional neurobrain_state. Treat neurobrain_state as continuous context, not as a motion command. Return only JSON, with no markdown or explanation. Include schema_version exactly as engine.motion_intent.v4, non-empty model_id and profile_id strings, positive integer profile_revision, mode, and a non-empty emotion_label string. intent_tags are optional metadata. Include exactly one motion field: axis_levels object, motion_steps array, or motion_resource_id string. When the user or reply clearly asks for repeated, back-and-forth, or ordered visible motion, prefer 2-4 motion_steps that express its key pose changes in playback order; use axis_levels for one stable pose. Do not split steps by words, pauses, or speech rhythm. duration_hint_ms and summary may also be included. Copy model/profile identifiers from the prompt and never omit emotion_label."""
PROVIDER_OUTPUT_FIELDS = (
    "axis_levels",
    "motion_steps",
    "duration_hint_ms",
    "expression_resource_id",
    "motion_resource_id",
)
TEACHER_PRIMARY_RESULT_BLOCKERS = frozenset(
    {
        "final_motion_payload_missing",
        "final_motion_failed",
        "final_motion_status_invalid",
        "provider_result_not_final",
        "motion_result_reason_conflict",
        "motion_provider_final_conflict",
        "motion_terminal_status_conflict",
        "final_motion_payload_conflict",
    }
)


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
    segment = payload.get("segment")
    speech = segment.get("speech") if isinstance(segment, dict) else None
    if not isinstance(speech, str) or not speech.strip():
        return None
    return payload


def _select_training_target(
    sample: dict[str, Any],
    *,
    teacher_provider_id: str | None = None,
    teacher_fallback_primary: bool = False,
) -> tuple[dict[str, Any] | None, str]:
    """Select the final primary target or an explicitly requested shadow teacher."""
    motion = sample.get("motion", {})
    if not isinstance(motion, dict):
        return None, "missing"

    if teacher_provider_id:
        candidates = motion.get("provider_candidates")
        if not isinstance(candidates, list):
            if teacher_fallback_primary:
                payload = motion.get("target_payload")
                if isinstance(payload, dict):
                    return payload, "primary_fallback"
            return None, "teacher_candidate_missing"
        for candidate in reversed(candidates):
            if not isinstance(candidate, dict):
                continue
            if (
                candidate.get("candidate_role") != "shadow"
                or str(candidate.get("provider_id") or "").strip()
                != teacher_provider_id
                or candidate.get("status") != "shadow_provider_normalized"
                or candidate.get("provider_final") is not False
            ):
                continue
            payload = candidate.get("accepted_payload")
            if isinstance(payload, dict):
                return payload, "shadow_teacher"
        if teacher_fallback_primary:
            payload = motion.get("target_payload")
            if isinstance(payload, dict):
                return payload, "primary_fallback"
        return None, "teacher_candidate_missing"

    payload = motion.get("target_payload")
    if isinstance(payload, dict):
        return payload, "primary_final"
    return None, "missing"


def _training_record(
    sample: dict[str, Any],
    reducer: Any,
    *,
    include_neurobrain: bool = False,
    teacher_provider_id: str | None = None,
    teacher_fallback_primary: bool = False,
    relaxed_quality: bool = False,
    all_delivery_modes: bool = False,
) -> dict[str, Any] | None:
    quality = sample.get("quality", {})
    request = sample.get("input", {}).get("motion_request")
    if not isinstance(request, dict):
        return None
    neurobrain_state = request.get("neurobrain_state")
    has_neurobrain_state = isinstance(neurobrain_state, dict) and bool(neurobrain_state)
    target, target_origin = _select_training_target(
        sample,
        teacher_provider_id=teacher_provider_id,
        teacher_fallback_primary=teacher_fallback_primary,
    )
    if target is None:
        return None
    using_shadow_teacher = target_origin == "shadow_teacher"
    if (
        (
            sample.get("collection_status") != "closed"
            and not using_shadow_teacher
        )
        or sample.get("source_route") != "independent_motion"
        or (
            not all_delivery_modes
            and sample.get("delivery_mode") != "M2_olv_incremental"
        )
        or (
            all_delivery_modes
            and sample.get("delivery_mode")
            not in {"M0_nonstreaming", "M2_olv_incremental"}
        )
    ):
        return None

    if relaxed_quality:
        pass
    elif include_neurobrain:
        if using_shadow_teacher:
            raw_blockers = quality.get("blockers")
            blockers = {
                str(blocker).strip()
                for blocker in (
                    raw_blockers
                    if isinstance(raw_blockers, (list, tuple, set))
                    else ()
                )
                if str(blocker).strip()
            }
            allowed_blockers = set(TEACHER_PRIMARY_RESULT_BLOCKERS)
            if has_neurobrain_state:
                allowed_blockers.add("neurobrain_state_present")
            if blockers - allowed_blockers:
                return None
            if quality.get("neurobrain_state_present") is not has_neurobrain_state:
                return None
        else:
            expected_blockers = ["neurobrain_state_present"] if has_neurobrain_state else []
            expected_quality_status = "blocked" if has_neurobrain_state else "reviewable"
            if (
                quality.get("status") != expected_quality_status
                or quality.get("blockers") != expected_blockers
                or quality.get("neurobrain_state_present") is not has_neurobrain_state
            ):
                return None
    elif (
        quality.get("status") != "reviewable"
        or quality.get("neurobrain_state_present") is not False
        or has_neurobrain_state
    ):
        return None

    prompt_payload = _parse_request_prompt(request)
    prompt = request.get("prompt")
    if prompt_payload is None or not isinstance(prompt, str):
        return None
    if include_neurobrain and has_neurobrain_state:
        if prompt_payload.get("neurobrain_state") != neurobrain_state:
            return None

    return {
        "messages": [
            {
                "role": "system",
                "content": (
                    EXPERIMENT_NEUROBRAIN_SYSTEM_PROMPT
                    if include_neurobrain
                    else EXPERIMENT_SYSTEM_PROMPT
                ),
            },
            {"role": "user", "content": prompt},
            {"role": "assistant", "content": reducer._stable_json(target)},
        ]
    }


def _production_training_record(
    sample: dict[str, Any],
    reducer: Any,
    *,
    teacher_provider_id: str | None = None,
    teacher_fallback_primary: bool = False,
    relaxed_quality: bool = False,
    all_delivery_modes: bool = False,
) -> dict[str, Any] | None:
    if (
        _training_record(
            sample,
            reducer,
            include_neurobrain=True,
            teacher_provider_id=teacher_provider_id,
            teacher_fallback_primary=teacher_fallback_primary,
            relaxed_quality=relaxed_quality,
            all_delivery_modes=all_delivery_modes,
        )
        is None
    ):
        return None

    motion_request = sample["input"]["motion_request"]
    system_prompt = motion_request.get("system_prompt")
    prompt = motion_request.get("prompt")
    contexts = sample["input"].get("recent_context")
    target, _ = _select_training_target(
        sample,
        teacher_provider_id=teacher_provider_id,
        teacher_fallback_primary=teacher_fallback_primary,
    )
    if (
        not isinstance(system_prompt, str)
        or not system_prompt.strip()
        or not isinstance(prompt, str)
        or not prompt.strip()
        or not isinstance(contexts, list)
        or not isinstance(target, dict)
    ):
        return None

    conversation: list[dict[str, str]] = []
    for context in contexts:
        if (
            not isinstance(context, dict)
            or context.get("role") not in {"user", "assistant"}
            or not isinstance(context.get("content"), str)
        ):
            return None
        message = {"role": context["role"], "content": context["content"]}
        if conversation and conversation[-1]["role"] == message["role"]:
            conversation[-1]["content"] += "\n\n" + message["content"]
        else:
            conversation.append(message)
    current_message = {"role": "user", "content": prompt}
    if conversation and conversation[-1]["role"] == "user":
        conversation[-1]["content"] += "\n\n" + prompt
    else:
        conversation.append(current_message)
    messages = [{"role": "system", "content": system_prompt}, *conversation]

    target_fields = {
        key: target[key] for key in PROVIDER_OUTPUT_FIELDS if key in target
    }
    motion_shapes = {
        "axis_levels",
        "motion_steps",
        "motion_resource_id",
    }.intersection(target_fields)
    if len(motion_shapes) != 1:
        return None

    messages.append(
        {"role": "assistant", "content": reducer._stable_json(target_fields)}
    )
    return {"messages": messages}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build the local weak-label SFT set from AG99live Motion Lab."
    )
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=PROJECT_ROOT / "data")
    parser.add_argument(
        "--include-neurobrain",
        action="store_true",
        help="include closed M2 samples blocked only by their NeuroBrain state",
    )
    parser.add_argument(
        "--production-prompt",
        action="store_true",
        help=(
            "use the captured production system prompt, contexts, and user prompt, "
            "with Provider-shaped action targets"
        ),
    )
    parser.add_argument(
        "--teacher-provider-id",
        help=(
            "use a successful shadow candidate from this Provider as the SFT target; "
            "without this option the primary final result remains the target"
        ),
    )
    parser.add_argument(
        "--teacher-fallback-primary",
        action="store_true",
        help="use the primary final result when the requested shadow teacher is missing",
    )
    parser.add_argument(
        "--relaxed-quality",
        action="store_true",
        help="keep any parseable target/prompt sample and ignore review blockers",
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
    missing_prompt_speech = sum(
        1
        for sample in samples
        if sample.get("source_route") == "independent_motion"
        and (
            args.all_delivery_modes
            or sample.get("delivery_mode") == "M2_olv_incremental"
        )
        and _parse_request_prompt(
            sample.get("input", {}).get("motion_request", {})
            if isinstance(sample.get("input", {}).get("motion_request"), dict)
            else {}
        )
        is None
    )
    eligible = []
    target_origin_counts: Counter[str] = Counter()
    teacher_candidate_missing = 0
    for sample in samples:
        if (
            teacher_provider_id
            and sample.get("source_route") == "independent_motion"
            and (
                args.all_delivery_modes
                or sample.get("delivery_mode") == "M2_olv_incremental"
            )
        ):
            _, target_origin = _select_training_target(
                sample,
                teacher_provider_id=teacher_provider_id,
                teacher_fallback_primary=args.teacher_fallback_primary,
            )
            if target_origin == "teacher_candidate_missing":
                teacher_candidate_missing += 1
        record = (
            _production_training_record(
                sample,
                reducer,
                teacher_provider_id=teacher_provider_id,
                teacher_fallback_primary=args.teacher_fallback_primary,
                relaxed_quality=args.relaxed_quality,
                all_delivery_modes=args.all_delivery_modes,
            )
            if args.production_prompt
            else _training_record(
                sample,
                reducer,
                include_neurobrain=args.include_neurobrain,
                teacher_provider_id=teacher_provider_id,
                teacher_fallback_primary=args.teacher_fallback_primary,
                relaxed_quality=args.relaxed_quality,
                all_delivery_modes=args.all_delivery_modes,
            )
        )
        if record is not None:
            eligible.append((sample, record))
            _, target_origin = _select_training_target(
                sample,
                teacher_provider_id=teacher_provider_id,
                teacher_fallback_primary=args.teacher_fallback_primary,
            )
            target_origin_counts[target_origin] += 1
    records = [record for _, record in eligible]
    if not records:
        raise SystemExit(
            "No eligible motion samples found; "
            f"{missing_prompt_speech} M2 samples have missing or invalid prompt segment speech."
        )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    data_path = args.output_dir / "weak_sft.jsonl"
    info_path = args.output_dir / "dataset_info.json"
    with data_path.open("w", encoding="utf-8", newline="\n") as stream:
        for record in records:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")

    dataset_name = (
        "spark_x26_production_neurobrain"
        if args.production_prompt
        else "spark_x26_weak"
    )
    dataset_info = {
        dataset_name: {
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
    }
    info_path.write_text(
        json.dumps(dataset_info, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    shape_counts: dict[str, int] = {}
    for sample, _ in eligible:
        target, _ = _select_training_target(
            sample,
            teacher_provider_id=teacher_provider_id,
            teacher_fallback_primary=args.teacher_fallback_primary,
        )
        if target is None:
            continue
        shape = next(
            (
                key
                for key in ("motion_steps", "axis_levels", "motion_resource_id")
                if key in target
            ),
            "unknown",
        )
        shape_counts[shape] = shape_counts.get(shape, 0) + 1
    print(
        json.dumps(
            {
                "dataset": str(data_path.resolve()),
                "samples": len(records),
                "weak_labels": True,
                "neurobrain_samples_included": sum(
                    1
                    for sample, _ in eligible
                    if sample.get("quality", {}).get("neurobrain_state_present")
                ),
                "m2_samples_with_missing_or_invalid_prompt_segment_speech": missing_prompt_speech,
                "target_motion_shapes": shape_counts,
                "teacher_provider_id": teacher_provider_id,
                "teacher_fallback_primary": args.teacher_fallback_primary,
                "relaxed_quality": args.relaxed_quality,
                "all_delivery_modes": args.all_delivery_modes,
                "target_origins": dict(target_origin_counts),
                "teacher_candidate_missing": teacher_candidate_missing,
                "production_targets_exclude_intent_tags": args.production_prompt,
                "malformed_raw_events": len(malformed),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
