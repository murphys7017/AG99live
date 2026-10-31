from __future__ import annotations

import argparse
import json
import sys
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


def _training_record(
    sample: dict[str, Any], reducer: Any, *, include_neurobrain: bool = False
) -> dict[str, Any] | None:
    quality = sample.get("quality", {})
    request = sample.get("input", {}).get("motion_request")
    if not isinstance(request, dict):
        return None
    neurobrain_state = request.get("neurobrain_state")
    has_neurobrain_state = isinstance(neurobrain_state, dict) and bool(neurobrain_state)
    if (
        sample.get("collection_status") != "closed"
        or sample.get("source_route") != "independent_motion"
        or sample.get("delivery_mode") != "M2_olv_incremental"
    ):
        return None

    if include_neurobrain:
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

    target = sample.get("motion", {}).get("target_payload")
    if not isinstance(target, dict):
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
    sample: dict[str, Any], reducer: Any
) -> dict[str, Any] | None:
    if _training_record(sample, reducer, include_neurobrain=True) is None:
        return None

    motion_request = sample["input"]["motion_request"]
    system_prompt = motion_request.get("system_prompt")
    prompt = motion_request.get("prompt")
    contexts = sample["input"].get("recent_context")
    target = sample.get("motion", {}).get("target_payload")
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
    args = parser.parse_args()

    reducer = _load_reducer()
    samples, _, malformed = reducer._reduce_database(args.db)
    missing_prompt_speech = sum(
        1
        for sample in samples
        if sample.get("source_route") == "independent_motion"
        and sample.get("delivery_mode") == "M2_olv_incremental"
        and _parse_request_prompt(
            sample.get("input", {}).get("motion_request", {})
            if isinstance(sample.get("input", {}).get("motion_request"), dict)
            else {}
        )
        is None
    )
    eligible = []
    for sample in samples:
        record = (
            _production_training_record(sample, reducer)
            if args.production_prompt
            else _training_record(
                sample, reducer, include_neurobrain=args.include_neurobrain
            )
        )
        if record is not None:
            eligible.append((sample, record))
    records = [record for _, record in eligible]
    if not records:
        raise SystemExit(
            "No eligible closed M2 samples found; "
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
        target = sample.get("motion", {}).get("target_payload")
        if not isinstance(target, dict):
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
                "production_targets_exclude_intent_tags": args.production_prompt,
                "malformed_raw_events": len(malformed),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
