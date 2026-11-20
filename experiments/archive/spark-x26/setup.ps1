$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$factoryDir = Join-Path $projectRoot ".tooling\LlamaFactory"
$factoryCommit = "f56888d47dc5681e15b83ddbea01adddf2050adf"
$factoryUrl = "https://github.com/XHToken/LlamaFactory.git"

if (-not (Test-Path (Join-Path $factoryDir ".git"))) {
    New-Item -ItemType Directory -Force -Path (Split-Path $factoryDir) | Out-Null
    git clone --filter=blob:none --no-checkout $factoryUrl $factoryDir
    if ($LASTEXITCODE -ne 0) { throw "LLaMA-Factory clone failed." }
}

$currentCommit = git -C $factoryDir rev-parse HEAD 2>$null
if ($currentCommit -ne $factoryCommit) {
    git -C $factoryDir fetch --depth 1 origin $factoryCommit
    if ($LASTEXITCODE -ne 0) { throw "Pinned LLaMA-Factory commit fetch failed." }
    git -C $factoryDir checkout --detach $factoryCommit
    if ($LASTEXITCODE -ne 0) { throw "Pinned LLaMA-Factory checkout failed." }
}

$venvDir = Join-Path $projectRoot ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    uv venv --python 3.11 $venvDir
    if ($LASTEXITCODE -ne 0) { throw "Virtual environment creation failed." }
}

uv pip install --python $venvPython `
    --index-url https://download.pytorch.org/whl/cu128 `
    "torch==2.8.0" "torchvision==0.23.0" "torchaudio==2.8.0"
if ($LASTEXITCODE -ne 0) { throw "CUDA PyTorch installation failed." }

uv pip install --python $venvPython "transformers==4.57.6"
if ($LASTEXITCODE -ne 0) { throw "Transformers installation failed." }

uv pip install --python $venvPython "bitsandbytes==0.49.2"
if ($LASTEXITCODE -ne 0) { throw "bitsandbytes installation failed." }

uv pip install --python $venvPython -e $factoryDir
if ($LASTEXITCODE -ne 0) { throw "LLaMA-Factory installation failed." }

Write-Output "Experiment environment is ready: $venvPython"
