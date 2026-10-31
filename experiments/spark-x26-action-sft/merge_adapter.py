from __future__ import annotations

import json
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

PROJECT_ROOT = Path(__file__).resolve().parent
MODEL_ID = "XHToken/Spark-X2.6-1.7B-Base"
ADAPTER_DIR = PROJECT_ROOT / "output" / "spark-x26-1p7b-lora-schema2"
MERGED_DIR = PROJECT_ROOT / "output" / "spark-x26-1p7b-lora-merged-bf16"


def main() -> int:
    if not ADAPTER_DIR.is_dir():
        raise SystemExit(f"LoRA adapter not found: {ADAPTER_DIR}")
    if MERGED_DIR.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {MERGED_DIR}")

    base_model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        trust_remote_code=True,
        dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
    )
    model = PeftModel.from_pretrained(base_model, ADAPTER_DIR)
    model.eval()
    merged_model = model.merge_and_unload(safe_merge=True)

    MERGED_DIR.mkdir(parents=True)
    merged_model.save_pretrained(
        MERGED_DIR,
        safe_serialization=True,
        max_shard_size="2GB",
    )
    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        trust_remote_code=True,
        fix_mistral_regex=False,
    )
    tokenizer.save_pretrained(MERGED_DIR)
    print(
        json.dumps(
            {
                "base_model": MODEL_ID,
                "adapter": str(ADAPTER_DIR),
                "merged_model": str(MERGED_DIR),
                "dtype": "bfloat16",
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
