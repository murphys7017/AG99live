from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from transformers import AutoTokenizer

ROOT = Path(__file__).resolve().parent


def generate(
    *, endpoint: str, model: str, prompt: str, num_ctx: int, num_predict: int
) -> dict[str, Any]:
    body = json.dumps(
        {
            "model": model,
            "prompt": prompt,
            "raw": True,
            "stream": True,
            "keep_alive": "2m",
            "options": {
                "num_ctx": num_ctx,
                "num_predict": num_predict,
                "temperature": 0,
                "seed": 7,
            },
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{endpoint.rstrip('/')}/api/generate",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    first_token_ms = None
    text_parts: list[str] = []
    final: dict[str, Any] = {}
    with urllib.request.urlopen(request, timeout=600) as response:
        for line in response:
            if not line.strip():
                continue
            chunk = json.loads(line)
            part = chunk.get("response") or ""
            if part and first_token_ms is None:
                first_token_ms = round((time.perf_counter() - started) * 1000, 1)
            text_parts.append(part)
            if chunk.get("done"):
                final = chunk
    elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
    generated = "".join(text_parts).strip()
    try:
        json.loads(generated)
        json_valid = True
    except json.JSONDecodeError:
        json_valid = False
    return {
        "request_ms": elapsed_ms,
        "time_to_first_text_ms": first_token_ms,
        "prompt_tokens": final.get("prompt_eval_count"),
        "generated_tokens": final.get("eval_count"),
        "prompt_eval_ms": round(final.get("prompt_eval_duration", 0) / 1_000_000, 1),
        "decode_ms": round(final.get("eval_duration", 0) / 1_000_000, 1),
        "json_valid": json_valid,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark Ollama using complete captured production prompts."
    )
    parser.add_argument("--model", default="ag99-spark-x26-action-lora:q8_0")
    parser.add_argument("--adapter-version", default="existing Q8 action adapter")
    parser.add_argument("--endpoint", default="http://127.0.0.1:11434")
    parser.add_argument("--adapter-dir", type=Path, default=ROOT / "output/spark-x26-1p7b-lora-production-neurobrain-v5")
    parser.add_argument("--data-path", type=Path, default=ROOT / "data/production_neurobrain_v2/weak_sft.jsonl")
    parser.add_argument("--report-path", type=Path, required=True)
    parser.add_argument("--num-ctx", type=int, default=6144)
    parser.add_argument("--num-predict", type=int, default=128)
    parser.add_argument("--indices", type=int, nargs="+", default=[0, 116, 233])
    args = parser.parse_args()

    records = [
        json.loads(line)
        for line in args.data_path.read_text(encoding="utf-8").splitlines()
    ]
    tokenizer = AutoTokenizer.from_pretrained(args.adapter_dir, trust_remote_code=True)
    prompts = []
    for index in args.indices:
        if not 0 <= index < len(records):
            raise ValueError(f"sample index out of range: {index}")
        messages = records[index]["messages"][:-1]
        prompt = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        ) + "</think>"
        token_count = len(tokenizer.encode(prompt, add_special_tokens=False))
        prompts.append((index, prompt, token_count))

    warm_index, warm_prompt, warm_tokens = prompts[0]
    warmup = generate(
        endpoint=args.endpoint,
        model=args.model,
        prompt=warm_prompt,
        num_ctx=args.num_ctx,
        num_predict=args.num_predict,
    )
    print(json.dumps({"warmup_index": warm_index, "tokenizer_prompt_tokens": warm_tokens, **warmup}), flush=True)

    results = []
    for index, prompt, token_count in prompts:
        result = generate(
            endpoint=args.endpoint,
            model=args.model,
            prompt=prompt,
            num_ctx=args.num_ctx,
            num_predict=args.num_predict,
        )
        item = {"index": index, "tokenizer_prompt_tokens": token_count, **result}
        results.append(item)
        print(json.dumps(item), flush=True)

    report = {
        "model": args.model,
        "adapter_version": args.adapter_version,
        "backend": "Ollama raw prompt, num_ctx configured per request",
        "full_production_prompt": True,
        "warmup": {"index": warm_index, **warmup},
        "results": results,
        "limitations": "Warm Ollama raw-prompt timing and JSON parsing only; no Provider runtime, JSON recovery, axis/resource runtime validation, or Live2D playback.",
    }
    args.report_path.parent.mkdir(parents=True, exist_ok=True)
    args.report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
