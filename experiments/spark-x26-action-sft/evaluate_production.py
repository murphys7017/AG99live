from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
MODEL = "XHToken/Spark-X2.6-1.7B-Base"
FIELDS = {
    "intent_tags",
    "axis_levels",
    "motion_steps",
    "duration_hint_ms",
    "expression_resource_id",
    "motion_resource_id",
}
SHAPES = {"axis_levels", "motion_steps", "motion_resource_id"}


def _evenly_spaced_indices(candidates: list[int], count: int) -> list[int]:
    if count <= 0:
        return []
    if count >= len(candidates):
        return candidates
    if count == 1:
        return [candidates[len(candidates) // 2]]
    return [
        candidates[round(i * (len(candidates) - 1) / (count - 1))]
        for i in range(count)
    ]


def validate(value: Any, capability: dict[str, Any]) -> list[str]:
    if not isinstance(value, dict):
        return ["not_object"]
    errors = []
    if set(value) - FIELDS:
        errors.append("unknown_fields")
    shapes = SHAPES.intersection(value)
    if len(shapes) != 1:
        errors.append("execution_shape")
    axes = {a["id"]: a.get("available_levels", []) for a in capability.get("axes", [])}
    resources = {(r.get("resource_type"), r.get("resource_id")): r for r in capability.get("resources", [])}
    used_axes: set[str] = set()

    def check_levels(levels: Any) -> None:
        if not isinstance(levels, dict) or not levels:
            errors.append("axis_levels_shape")
            return
        for axis, level in levels.items():
            used_axes.add(axis)
            if axis not in axes:
                errors.append("unknown_axis")
            elif type(level) is not int or level not in axes[axis]:
                errors.append("unavailable_level")

    if "axis_levels" in value:
        check_levels(value["axis_levels"])
    if "motion_steps" in value:
        steps = value["motion_steps"]
        if not isinstance(steps, list) or not 2 <= len(steps) <= 4:
            errors.append("motion_steps_shape")
        else:
            for step in steps:
                if not isinstance(step, dict) or set(step) != {"axis_levels", "duration_weight"}:
                    errors.append("motion_step_fields")
                    continue
                check_levels(step["axis_levels"])
                if type(step["duration_weight"]) is not int or not 1 <= step["duration_weight"] <= 3:
                    errors.append("duration_weight")
    duration = value.get("duration_hint_ms")
    if "duration_hint_ms" in value and (type(duration) is not int or not 320 <= duration <= 15000):
        errors.append("duration_hint_ms")
    for kind in ("motion", "expression"):
        key = f"{kind}_resource_id"
        if key in value:
            resource_id = value[key]
            resource = resources.get((kind, resource_id)) if isinstance(resource_id, str) else None
            if resource is None:
                errors.append(f"{kind}_resource_unknown")
            elif kind == "expression" and used_axes.intersection(set(resource.get("conflicting_axis_ids") or []) | set(resource.get("conflicting_prompt_axis_ids") or [])):
                errors.append("expression_axis_conflict")
    if "motion_resource_id" in value and ("duration_hint_ms" in value or "expression_resource_id" in value):
        errors.append("motion_resource_conflict")
    return sorted(set(errors))


def motion_shape(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    shapes = SHAPES.intersection(value)
    return next(iter(shapes)) if len(shapes) == 1 else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter-dir", type=Path, required=True)
    parser.add_argument("--data-path", type=Path, default=ROOT / "data/production_neurobrain_v3/weak_sft.jsonl")
    parser.add_argument("--report-path", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--indices", type=int, nargs="+")
    args = parser.parse_args()
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    records = [json.loads(line) for line in args.data_path.read_text(encoding="utf-8").splitlines()]
    if not 1 <= args.samples <= len(records):
        raise ValueError("samples must be between 1 and dataset size")
    if args.indices:
        indices = args.indices
    else:
        step_indices = [
            index
            for index, record in enumerate(records)
            if motion_shape(json.loads(record["messages"][-1]["content"]))
            == "motion_steps"
        ]
        step_index_set = set(step_indices)
        other_indices = [
            index for index in range(len(records)) if index not in step_index_set
        ]
        step_count = min(len(step_indices), (args.samples + 1) // 2)
        other_count = min(len(other_indices), args.samples - step_count)
        remaining = args.samples - step_count - other_count
        extra_steps = min(remaining, len(step_indices) - step_count)
        step_count += extra_steps
        remaining -= extra_steps
        other_count += min(remaining, len(other_indices) - other_count)
        indices = sorted(
            _evenly_spaced_indices(step_indices, step_count)
            + _evenly_spaced_indices(other_indices, other_count)
        )
    if any(i < 0 or i >= len(records) for i in indices):
        raise ValueError("sample index out of range")
    tokenizer = AutoTokenizer.from_pretrained(args.adapter_dir, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL, trust_remote_code=True, device_map="auto", dtype=torch.bfloat16,
    )
    model = PeftModel.from_pretrained(model, args.adapter_dir).eval()
    model.generation_config.do_sample = False
    model.generation_config.top_p = None
    model.generation_config.top_k = None
    results = []
    for index in indices:
        messages = records[index]["messages"][:-1]
        target = json.loads(records[index]["messages"][-1]["content"])
        capability = json.JSONDecoder().raw_decode(messages[0]["content"].split("Live2D 能力：\n", 1)[1])[0]
        encoded = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, enable_thinking=False, return_tensors="pt").to(model.device)
        # SparkReasoningTemplate adds this masked prefix when thinking is disabled.
        prefix = tokenizer.encode("</think>", add_special_tokens=False, return_tensors="pt").to(model.device)
        encoded = torch.cat((encoded, prefix), dim=1)
        started = time.perf_counter()
        with torch.inference_mode():
            output = model.generate(encoded, max_new_tokens=512, do_sample=False, use_cache=True)
        text = tokenizer.decode(output[0, encoded.shape[1]:], skip_special_tokens=True).strip()
        value = None
        try:
            value = json.loads(text)
            errors = validate(value, capability)
            json_valid = True
        except json.JSONDecodeError as exc:
            errors = ["invalid_json"]
            json_valid = False
            print(json.dumps({"index": index, "decode_error": exc.msg, "position": exc.pos}, ensure_ascii=False), flush=True)
        generated_shape = motion_shape(value)
        target_shape = motion_shape(target)
        generated_steps = value.get("motion_steps") if isinstance(value, dict) else None
        target_steps = target.get("motion_steps") if isinstance(target, dict) else None
        target_steps_count = len(target_steps) if isinstance(target_steps, list) else 0
        generated_steps_count = len(generated_steps) if isinstance(generated_steps, list) else 0
        motion_steps_count_match = (
            generated_shape == "motion_steps"
            and generated_steps_count == target_steps_count
            if target_shape == "motion_steps"
            else None
        )
        results.append(
            {
                "index": index,
                "json_valid": json_valid,
                "errors": errors,
                "target_motion_shape": target_shape,
                "generated_motion_shape": generated_shape,
                "motion_shape_match": generated_shape == target_shape,
                "target_motion_steps_count": target_steps_count,
                "generated_motion_steps_count": generated_steps_count,
                "motion_steps_count_match": motion_steps_count_match,
                "generated_tokens": int(output.shape[1] - encoded.shape[1]),
                "elapsed_ms": round((time.perf_counter() - started) * 1000),
            }
        )
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    report = {
        "adapter": str(args.adapter_dir.resolve()),
        "input_scope": "training_samples",
        "samples": len(results),
        "strict_json_valid": sum(r["json_valid"] for r in results),
        "contract_valid": sum(not r["errors"] for r in results),
        "motion_shape_matches": sum(r["motion_shape_match"] for r in results),
        "motion_steps_count_matches": sum(
            r["motion_steps_count_match"] is True for r in results
        ),
        "target_motion_steps_samples": sum(
            r["target_motion_shape"] == "motion_steps" for r in results
        ),
        "generated_motion_steps_samples": sum(
            r["generated_motion_shape"] == "motion_steps" for r in results
        ),
        "error_counts": dict(Counter(e for r in results for e in r["errors"])),
        "results": results,
        "limitations": "Seen training samples and captured capability checks only; semantic motion quality and held-out behavior require human review.",
    }
    args.report_path.parent.mkdir(parents=True, exist_ok=True)
    args.report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
