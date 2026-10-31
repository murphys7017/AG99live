from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

ROOT = Path(__file__).resolve().parent
MODEL_ID = "XHToken/Spark-X2.6-1.7B-Base"


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge the production-prompt LoRA for local inference.")
    parser.add_argument("--adapter-dir", type=Path, default=ROOT / "output/spark-x26-1p7b-lora-production-neurobrain-v5")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "output/spark-x26-1p7b-production-neurobrain-v5-merged-bf16")
    args = parser.parse_args()
    if not args.adapter_dir.is_dir():
        raise SystemExit(f"Adapter not found: {args.adapter_dir}")
    if args.output_dir.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {args.output_dir}")

    base = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        trust_remote_code=True,
        dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
    )
    model = PeftModel.from_pretrained(base, args.adapter_dir).eval()
    merged = model.merge_and_unload(safe_merge=True)
    args.output_dir.mkdir(parents=True)
    merged.save_pretrained(args.output_dir, safe_serialization=True, max_shard_size="2GB")
    tokenizer = AutoTokenizer.from_pretrained(args.adapter_dir, trust_remote_code=True)
    tokenizer.save_pretrained(args.output_dir)
    print(json.dumps({"base_model": MODEL_ID, "adapter": str(args.adapter_dir.resolve()), "merged_model": str(args.output_dir.resolve()), "dtype": "bfloat16", "tokenizer_source": "trained_adapter"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
