$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$python = Join-Path $projectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "Run setup.ps1 before generation." }

$env:HF_HOME = Join-Path $projectRoot ".cache\huggingface"
$env:TOKENIZERS_PARALLELISM = "false"
$baseOnlyArgs = @()
if ($args -contains "--base-only") {
    $baseOnlyArgs = @("--base-only")
}
Set-Location $projectRoot
& $python (Join-Path $projectRoot "smoke_generate.py") @baseOnlyArgs
if ($LASTEXITCODE -ne 0) { throw "Generation smoke check failed." }
