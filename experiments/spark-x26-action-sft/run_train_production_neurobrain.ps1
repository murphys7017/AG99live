$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$cli = Join-Path $projectRoot ".venv\Scripts\llamafactory-cli.exe"
$dataset = Join-Path $projectRoot "data\production_neurobrain_v3\weak_sft.jsonl"
if (-not (Test-Path $cli)) { throw "Run setup.ps1 before training." }
if (-not (Test-Path $dataset)) {
    throw "Run prepare_dataset.py with --production-prompt --include-neurobrain --output-dir .\data\production_neurobrain_v3 first."
}

$env:HF_HOME = Join-Path $projectRoot ".cache\huggingface"
$env:DISABLE_VERSION_CHECK = "1"
$env:TOKENIZERS_PARALLELISM = "false"
Set-Location $projectRoot
& $cli train (Join-Path $projectRoot "train_lora_production_neurobrain.yaml")
if ($LASTEXITCODE -ne 0) { throw "Production-prompt NeuroBrain LLaMA-Factory training failed." }
