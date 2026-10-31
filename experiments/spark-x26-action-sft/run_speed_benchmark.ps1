$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$python = Join-Path $projectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "Run setup.ps1 before the speed benchmark." }

$env:HF_HOME = Join-Path $projectRoot ".cache\huggingface"
$env:TOKENIZERS_PARALLELISM = "false"
Set-Location $projectRoot
& $python (Join-Path $projectRoot "speed_benchmark.py") @args
if ($LASTEXITCODE -ne 0) { throw "Speed benchmark failed." }
