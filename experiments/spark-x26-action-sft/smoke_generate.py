from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path
from typing import Any

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

PROJECT_ROOT = Path(__file__).resolve().parent
MODEL_ID = "XHToken/Spark-X2.6-1.7B-Base"
ADAPTER_DIR = PROJECT_ROOT / "output" / "spark-x26-1p7b-lora-continuous"
DATA_PATH = PROJECT_ROOT / "data" / "continuous" / "continuous_sft.jsonl"
REPORT_PATH = PROJECT_ROOT / "reports" / "continuous_generation_smoke.json"
BASE_REPORT_PATH = PROJECT_ROOT / "reports" / "base_continuous_generation_smoke.json"
REQUIRED_KEYS = {"motion_steps", "duration_hint_ms"}


def _capability(messages: list[dict[str, str]]) -> dict[str, Any]:
    content = messages[0]["content"] if messages else ""
    marker = "Live2D 能力："
    if marker not in content:
        return {}
    try:
        value, _ = json.JSONDecoder().raw_decode(content.split(marker, 1)[1].lstrip())
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _valid_motion_shape(value: dict[str, Any], capability: dict[str, Any]) -> bool:
    if set(value) != REQUIRED_KEYS:
        return False
    duration = value.get("duration_hint_ms")
    if type(duration) is not int or not 320 <= duration <= 15000:
        return False
    axes = {
        str(axis.get("id")): axis
        for axis in capability.get("axes", [])
        if isinstance(axis, dict) and str(axis.get("id") or "").strip()
    }
    steps = value.get("motion_steps")
    if not isinstance(steps, list) or not 1 <= len(steps) <= 4:
        return False
    for step in steps:
        if not isinstance(step, dict) or set(step) != {"axis_values", "duration_weight"}:
            return False
        weight = step.get("duration_weight")
        if type(weight) is not int or not 1 <= weight <= 3:
            return False
        values = step.get("axis_values")
        if not isinstance(values, dict) or not values:
            return False
        for axis_id, raw_value in values.items():
            axis = axes.get(str(axis_id))
            if (
                axis is None
                or isinstance(raw_value, bool)
                or not isinstance(raw_value, (int, float))
                or not math.isfinite(float(raw_value))
            ):
                return False
            value_range = axis.get("value_range")
            if (
                not isinstance(value_range, list)
                or len(value_range) != 2
                or float(raw_value) < float(value_range[0])
                or float(raw_value) > float(value_range[1])
            ):
                return False
    return True


def _motion_shape(value: Any) -> str | None:
    return "motion_steps" if isinstance(value, dict) and "motion_steps" in value else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-only", action="store_true")
    parser.add_argument("--adapter-dir", type=Path, default=ADAPTER_DIR)
    parser.add_argument("--data-path", type=Path, default=DATA_PATH)
    parser.add_argument("--report-path", type=Path)
    args = parser.parse_args()
    if not args.base_only and not args.adapter_dir.exists():
        raise SystemExit("Trained LoRA adapter not found; run training first.")
    with args.data_path.open("r", encoding="utf-8") as stream:
        record = json.loads(next(stream))
    messages = record["messages"][:-1]
    capability = _capability(messages)
    target = json.loads(record["messages"][-1]["content"])
    free_gpu_gib = (
        torch.cuda.mem_get_info(0)[0] / 1024**3
        if torch.cuda.is_available()
        else 0.0
    )
    use_gpu = free_gpu_gib >= 5.0
    device_map = "auto" if use_gpu else {"": "cpu"}
    inference_device = "cuda" if use_gpu else "cpu"
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        trust_remote_code=True,
        dtype=torch.bfloat16,
        device_map=device_map,
    )
    if not args.base_only:
        model = PeftModel.from_pretrained(model, args.adapter_dir)
    model.eval()
    model.generation_config.do_sample = False
    model.generation_config.top_p = None
    model.generation_config.top_k = None
    encoded = tokenizer.apply_chat_template(
        messages,
        tokenize=True,
        add_generation_prompt=True,
        enable_thinking=False,
        return_tensors="pt",
    ).to(model.device)
    outputs: list[str] = []
    latencies_ms: list[int] = []
    generated_token_counts: list[int] = []
    for _ in range(3):
        if use_gpu:
            torch.cuda.synchronize()
        started = time.perf_counter()
        with torch.inference_mode():
            generated = model.generate(
                encoded,
                max_new_tokens=256,
                do_sample=False,
                use_cache=True,
            )
        if use_gpu:
            torch.cuda.synchronize()
        latencies_ms.append(round((time.perf_counter() - started) * 1000))
        new_tokens = generated[0, encoded.shape[1] :]
        generated_token_counts.append(int(new_tokens.shape[0]))
        outputs.append(tokenizer.decode(new_tokens, skip_special_tokens=True).strip())

    parsed: list[dict[str, Any] | None] = []
    errors: list[list[str]] = []
    for text in outputs:
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            value = None
        if not isinstance(value, dict):
            parsed.append(None)
            errors.append(["invalid_json"])
        else:
            parsed.append(value)
            errors.append([] if _valid_motion_shape(value, capability) else ["contract_invalid"])

    report = {
        "model": MODEL_ID,
        "adapter": None if args.base_only else str(args.adapter_dir.resolve()),
        "adapter_loaded": not args.base_only,
        "runs": len(outputs),
        "input_scope": "first_training_sample",
        "data_path": str(args.data_path.resolve()),
        "output_protocol": "motion_steps_axis_values_duration_required",
        "model_load_latency_included": False,
        "valid_json_runs": sum(value is not None for value in parsed),
        "output_keys": [sorted(value) if value is not None else [] for value in parsed],
        "contract_valid_runs": sum(not error for error in errors),
        "contract_errors": errors,
        "target_contract_valid": isinstance(target, dict) and _valid_motion_shape(target, capability),
        "generated_motion_shapes": [_motion_shape(value) for value in parsed],
        "generated_motion_steps_counts": [
            len(value["motion_steps"])
            if value is not None and isinstance(value.get("motion_steps"), list)
            else 0
            for value in parsed
        ],
        "exact_repeat_stability": len(set(outputs)) == 1,
        "latency_ms": latencies_ms,
        "generated_tokens": generated_token_counts,
        "inference_device": inference_device,
        "free_gpu_gib_before_load": round(free_gpu_gib, 2),
        "thinking_disabled": True,
    }
    report_path = args.report_path or (BASE_REPORT_PATH if args.base_only else REPORT_PATH)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    if args.base_only:
        return 0
    return 0 if report["valid_json_runs"] == 3 and report["contract_valid_runs"] == 3 else 2


if __name__ == "__main__":
    raise SystemExit(main())
