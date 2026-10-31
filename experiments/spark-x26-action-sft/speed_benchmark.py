from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path
from typing import Any

import torch
import transformers
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer
from transformers.generation.streamers import BaseStreamer

PROJECT_ROOT = Path(__file__).resolve().parent
MODEL_ID = "XHToken/Spark-X2.6-1.7B-Base"
ADAPTER_DIR = PROJECT_ROOT / "output" / "spark-x26-1p7b-lora-schema2"
DATA_PATH = PROJECT_ROOT / "data" / "weak_sft.jsonl"
REPORT_PATH = PROJECT_ROOT / "reports" / "speed_benchmark.json"


class _TokenClockStreamer(BaseStreamer):
    def __init__(self, device: torch.device) -> None:
        self.device = device
        self.prompt_skipped = False
        self.generated_tokens = 0
        self.first_token_at: float | None = None

    def put(self, value: torch.Tensor) -> None:
        if not self.prompt_skipped:
            self.prompt_skipped = True
            return

        self.generated_tokens += int(value.shape[-1])
        if self.first_token_at is None:
            torch.cuda.synchronize(self.device)
            self.first_token_at = time.perf_counter()

    def end(self) -> None:
        return


def _load_first_messages() -> list[dict[str, Any]]:
    with DATA_PATH.open("r", encoding="utf-8") as stream:
        record = json.loads(next(stream))
    return record["messages"][:-1]


def _run_once(
    model: Any,
    encoded: torch.Tensor,
    new_tokens: int,
    device: torch.device,
) -> dict[str, float | int]:
    streamer = _TokenClockStreamer(device)
    torch.cuda.synchronize(device)
    started = time.perf_counter()
    with torch.inference_mode():
        generated = model.generate(
            encoded,
            max_new_tokens=new_tokens,
            min_new_tokens=new_tokens,
            do_sample=False,
            use_cache=True,
            streamer=streamer,
        )
    torch.cuda.synchronize(device)
    completed = time.perf_counter()

    output_tokens = int(generated.shape[1] - encoded.shape[1])
    if streamer.first_token_at is None or streamer.generated_tokens != output_tokens:
        raise RuntimeError(
            "Streaming token count did not match the generated sequence length."
        )

    total_seconds = completed - started
    ttft_seconds = streamer.first_token_at - started
    decode_seconds = completed - streamer.first_token_at
    return {
        "ttft_ms": round(ttft_seconds * 1000, 1),
        "total_generation_ms": round(total_seconds * 1000, 1),
        "output_tokens": output_tokens,
        "end_to_end_tokens_per_second": round(output_tokens / total_seconds, 2),
        "decode_tokens_per_second": round(
            max(output_tokens - 1, 0) / decode_seconds, 2
        ),
    }


def _run_unstreamed_once(
    model: Any,
    encoded: torch.Tensor,
    new_tokens: int,
    device: torch.device,
) -> dict[str, float | int]:
    torch.cuda.synchronize(device)
    started = time.perf_counter()
    with torch.inference_mode():
        generated = model.generate(
            encoded,
            max_new_tokens=new_tokens,
            min_new_tokens=new_tokens,
            do_sample=False,
            use_cache=True,
        )
    torch.cuda.synchronize(device)
    elapsed = time.perf_counter() - started
    output_tokens = int(generated.shape[1] - encoded.shape[1])
    return {
        "total_generation_ms": round(elapsed * 1000, 1),
        "output_tokens": output_tokens,
        "tokens_per_second": round(output_tokens / elapsed, 2),
    }


def _median_and_range(values: list[float]) -> dict[str, float]:
    return {
        "median": round(statistics.median(values), 2),
        "min": round(min(values), 2),
        "max": round(max(values), 2),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure Spark-X2.6 LoRA decode speed.")
    parser.add_argument("--warmup-runs", type=int, default=1)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--new-tokens", type=int, default=128)
    args = parser.parse_args()
    if args.warmup_runs < 0 or args.runs < 1 or args.new_tokens < 2:
        parser.error("Use warmup-runs >= 0, runs >= 1, and new-tokens >= 2.")
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required for this GPU speed benchmark.")
    if not ADAPTER_DIR.exists():
        raise SystemExit("Trained LoRA adapter not found; run training first.")

    device = torch.device("cuda:0")
    free_bytes, total_bytes = torch.cuda.mem_get_info(device)
    if free_bytes < 5 * 1024**3:
        raise SystemExit(
            f"Need at least 5 GiB free GPU memory; currently {free_bytes / 1024**3:.2f} GiB."
        )

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        trust_remote_code=True,
        dtype=torch.bfloat16,
        device_map={"": device.index},
    )
    model = PeftModel.from_pretrained(model, ADAPTER_DIR)
    model.eval()
    model.generation_config.do_sample = False
    model.generation_config.top_p = None
    model.generation_config.top_k = None

    messages = _load_first_messages()
    encoded = tokenizer.apply_chat_template(
        messages,
        tokenize=True,
        add_generation_prompt=True,
        enable_thinking=False,
        return_tensors="pt",
    ).to(device)

    for _ in range(args.warmup_runs):
        _run_once(model, encoded, args.new_tokens, device)
        _run_unstreamed_once(model, encoded, args.new_tokens, device)

    streamed_runs = []
    unstreamed_runs = []
    for _ in range(args.runs):
        streamed_runs.append(_run_once(model, encoded, args.new_tokens, device))
        unstreamed_runs.append(
            _run_unstreamed_once(model, encoded, args.new_tokens, device)
        )

    streamed_median_ms = statistics.median(
        float(run["total_generation_ms"]) for run in streamed_runs
    )
    unstreamed_median_ms = statistics.median(
        float(run["total_generation_ms"]) for run in unstreamed_runs
    )
    report = {
        "model": MODEL_ID,
        "adapter": str(ADAPTER_DIR),
        "gpu": torch.cuda.get_device_name(device),
        "torch_version": torch.__version__,
        "transformers_version": transformers.__version__,
        "dtype": "bfloat16",
        "thinking_disabled": True,
        "decoding": "greedy",
        "prompt_tokens": int(encoded.shape[1]),
        "requested_new_tokens": args.new_tokens,
        "warmup_runs": args.warmup_runs,
        "measured_runs": args.runs,
        "model_load_latency_included": False,
        "tokenization_latency_included": False,
        "ttft_includes_prompt_prefill": True,
        "free_gpu_gib_before_load": round(free_bytes / 1024**3, 2),
        "total_gpu_gib": round(total_bytes / 1024**3, 2),
        "streamed_runs": streamed_runs,
        "unstreamed_runs": unstreamed_runs,
        "summary": {
            "streamed": {
                "ttft_ms": _median_and_range(
                    [float(run["ttft_ms"]) for run in streamed_runs]
                ),
                "total_generation_ms": _median_and_range(
                    [float(run["total_generation_ms"]) for run in streamed_runs]
                ),
                "end_to_end_tokens_per_second": _median_and_range(
                    [float(run["end_to_end_tokens_per_second"]) for run in streamed_runs]
                ),
                "decode_tokens_per_second": _median_and_range(
                    [float(run["decode_tokens_per_second"]) for run in streamed_runs]
                ),
            },
            "unstreamed": {
                "total_generation_ms": _median_and_range(
                    [float(run["total_generation_ms"]) for run in unstreamed_runs]
                ),
                "tokens_per_second": _median_and_range(
                    [float(run["tokens_per_second"]) for run in unstreamed_runs]
                ),
            },
            "streamed_generation_overhead_percent": round(
                (streamed_median_ms / unstreamed_median_ms - 1) * 100, 2
            ),
        },
    }
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
