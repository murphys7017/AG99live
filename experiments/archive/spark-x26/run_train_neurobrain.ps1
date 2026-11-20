$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "run_train.ps1") @args
if ($LASTEXITCODE -ne 0) { throw "Continuous-action LLaMA-Factory training failed." }
