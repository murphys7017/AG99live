$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$cli = Join-Path $projectRoot ".venv\Scripts\llamafactory-cli.exe"
if (-not (Test-Path $cli)) { throw "Run setup.ps1 before training." }
if (-not (Test-Path (Join-Path $projectRoot "data\weak_sft.jsonl"))) {
    throw "Run prepare_dataset.py before training."
}

$env:HF_HOME = Join-Path $projectRoot ".cache\huggingface"
$env:DISABLE_VERSION_CHECK = "1"
$env:TOKENIZERS_PARALLELISM = "false"
Set-Location $projectRoot
& $cli train (Join-Path $projectRoot "train_lora.yaml")
if ($LASTEXITCODE -ne 0) { throw "LLaMA-Factory training failed." }
