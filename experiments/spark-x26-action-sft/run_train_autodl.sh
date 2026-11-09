#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${PROJECT_ROOT}/.venv"

if [[ ! -x "${VENV_DIR}/bin/llamafactory-cli" ]]; then
  echo "Run setup_autodl.sh first." >&2
  exit 1
fi
if [[ ! -f "${PROJECT_ROOT}/data/continuous/continuous_sft.jsonl" ]]; then
  echo "Merged continuous dataset is missing." >&2
  exit 1
fi

export HF_HOME="${PROJECT_ROOT}/.cache/huggingface"
export DISABLE_VERSION_CHECK=1
export TOKENIZERS_PARALLELISM=false
mkdir -p "${HF_HOME}" "${PROJECT_ROOT}/output"
cd "${PROJECT_ROOT}"

exec "${VENV_DIR}/bin/llamafactory-cli" train train_lora_autodl.yaml "$@"
