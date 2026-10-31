from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

PROJECT_ROOT = Path(__file__).resolve().parent
MODEL_ID = "XHToken/Spark-X2.6-1.7B-Base"
ADAPTER_DIR = PROJECT_ROOT / "output" / "spark-x26-1p7b-lora-schema2"
DATA_PATH = PROJECT_ROOT / "data" / "weak_sft.jsonl"
REPORT_PATH = PROJECT_ROOT / "reports" / "generation_smoke.json"
BASE_REPORT_PATH = PROJECT_ROOT / "reports" / "base_generation_smoke.json"
REQUIRED_KEYS = {
    "schema_version",
    "profile_id",
    "profile_revision",
    "model_id",
    "emotion_label",
}
MOTION_SHAPE_KEYS = {"axis_levels", "motion_steps", "motion_resource_id"}


def _valid_motion_shape(value: dict[str, Any]) -> bool:
    present = MOTION_SHAPE_KEYS.intersection(value)
    if len(present) != 1:
        return False
    key = next(iter(present))
    payload = value[key]
    if key == "axis_levels":
        return _valid_axis_levels(payload)
    if key == "motion_steps":
        if not isinstance(payload, list) or not 2 <= len(payload) <= 4:
            return False
        for step in payload:
            if not isinstance(step, dict) or set(step) - {"axis_levels", "duration_weight"}:
                return False
            weight = step.get("duration_weight")
            if type(weight) is not int or not 1 <= weight <= 3:
                return False
            if not _valid_axis_levels(step.get("axis_levels")):
                return False
        return True
    return isinstance(payload, str) and bool(payload.strip())


def _valid_axis_levels(value: Any) -> bool:
    return isinstance(value, dict) and bool(value) and all(
        isinstance(axis, str)
        and axis.strip()
        and type(level) is int
        and -4 <= level <= 4
        for axis, level in value.items()
    )


def _contract_valid(value: dict[str, Any]) -> bool:
    if not REQUIRED_KEYS.issubset(value) or not _valid_motion_shape(value):
        return False
    if value.get("schema_version") != "engine.motion_intent.v4":
        return False
    if (
        not isinstance(value.get("profile_id"), str)
        or not value["profile_id"].strip()
        or not isinstance(value.get("model_id"), str)
        or not value["model_id"].strip()
        or type(value.get("profile_revision")) is not int
        or value["profile_revision"] <= 0
    ):
        return False
    if not isinstance(value.get("emotion_label"), str) or not value["emotion_label"].strip():
        return False
    if value.get("mode", "expressive") not in {"expressive", "idle"}:
        return False
    duration = value.get("duration_hint_ms")
    return duration is None or (
        type(duration) in {int, float}
        and 320 <= duration <= 15000
    )


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
    for text in outputs:
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            value = None
        parsed.append(value if isinstance(value, dict) else None)

    report = {
        "model": MODEL_ID,
        "adapter": None if args.base_only else str(args.adapter_dir.resolve()),
        "adapter_loaded": not args.base_only,
        "runs": len(outputs),
        "input_scope": "first_training_sample",
        "data_path": str(args.data_path.resolve()),
        "prompt_projection": "compact_system_plus_provider_user_prompt",
        "model_load_latency_included": False,
        "valid_json_runs": sum(value is not None for value in parsed),
        "output_keys": [sorted(value) if value is not None else [] for value in parsed],
        "missing_required_keys": [
            sorted(REQUIRED_KEYS - set(value)) if value is not None else sorted(REQUIRED_KEYS)
            for value in parsed
        ],
        "contract_valid_runs": sum(value is not None and _contract_valid(value) for value in parsed),
        "valid_motion_shape_runs": sum(value is not None and _valid_motion_shape(value) for value in parsed),
        "generated_motion_shapes": [
            next(
                (
                    key
                    for key in ("motion_steps", "axis_levels", "motion_resource_id")
                    if key in value
                ),
                None,
            )
            if value is not None
            else None
            for value in parsed
        ],
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
    report_path = args.report_path or (
        BASE_REPORT_PATH if args.base_only else REPORT_PATH
    )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False))
    if args.base_only:
        return 0
    return 0 if report["valid_json_runs"] == 3 and report["contract_valid_runs"] == 3 else 2


if __name__ == "__main__":
    raise SystemExit(main())
