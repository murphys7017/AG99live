#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${PROJECT_ROOT}/.venv"
FACTORY_DIR="${PROJECT_ROOT}/.tooling/LlamaFactory"
FACTORY_COMMIT="f56888d47dc5681e15b83ddbea01adddf2050adf"
FACTORY_URL="https://github.com/XHToken/LlamaFactory.git"

cd "${PROJECT_ROOT}"

command -v nvidia-smi >/dev/null || {
  echo "nvidia-smi is required" >&2
  exit 1
}
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader

if [[ ! -d "${FACTORY_DIR}/.git" ]]; then
  mkdir -p "${PROJECT_ROOT}/.tooling"
  git clone --filter=blob:none --no-checkout "${FACTORY_URL}" "${FACTORY_DIR}"
fi
git -C "${FACTORY_DIR}" fetch --depth 1 origin "${FACTORY_COMMIT}"
git -C "${FACTORY_DIR}" checkout --detach "${FACTORY_COMMIT}"

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  python3 -m venv --system-site-packages "${VENV_DIR}"
fi

source "${VENV_DIR}/bin/activate"
python -m pip install --upgrade pip
if ! python - <<'PY'
import torch
assert torch.__version__.startswith("2.8."), torch.__version__
assert torch.version.cuda == "12.8", torch.version.cuda
PY
then
  python -m pip install "torch==2.8.0" "torchvision==0.23.0" "torchaudio==2.8.0"
fi
python -m pip install "transformers==4.57.6" "bitsandbytes==0.49.2"
python -m pip install -e "${FACTORY_DIR}"

python - <<'PY'
import torch
print({
    "torch": torch.__version__,
    "cuda_runtime": torch.version.cuda,
    "cuda_available": torch.cuda.is_available(),
    "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
})
PY

echo "AutoDL training environment is ready: ${VENV_DIR}"
