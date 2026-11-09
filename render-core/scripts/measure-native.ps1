param(
  [string]$BuildDirectory = (Join-Path $PSScriptRoot "..\build"),
  [string]$ModelPath = (Join-Path $PSScriptRoot "..\..\astrbot_plugin_ag99live_adapter\live2ds\Mk6_1.0\Mk6.model3.json"),
  [int]$WarmupSeconds = 10,
  [int]$SampleSeconds = 30,
  [int]$IntervalSeconds = 5
)

$ErrorActionPreference = "Stop"

if ($WarmupSeconds -lt 0 -or $SampleSeconds -le 0 -or $IntervalSeconds -le 0) {
  throw "WarmupSeconds must be non-negative; SampleSeconds and IntervalSeconds must be positive."
}

$executable = Join-Path $BuildDirectory "Release\ag99-render-host.exe"
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "Native executable was not found: $executable"
}
if (-not (Test-Path -LiteralPath $ModelPath -PathType Leaf)) {
  throw "Model file was not found: $ModelPath"
}

$process = $null
try {
  $process = Start-Process -FilePath $executable -ArgumentList @($ModelPath) -WindowStyle Hidden -PassThru
  if ($WarmupSeconds -gt 0) {
    Start-Sleep -Seconds $WarmupSeconds
  }

  $process.Refresh()
  $baselineCpuSeconds = [double]$process.CPU
  $startedAt = Get-Date
  $samples = [System.Collections.Generic.List[object]]::new()
  while ($true) {
    $beforeSleepElapsed = ((Get-Date) - $startedAt).TotalSeconds
    if ($beforeSleepElapsed -ge $SampleSeconds) {
      break
    }
    $remainingSeconds = [Math]::Max(1, [int][Math]::Ceiling(
        $SampleSeconds - $beforeSleepElapsed))
    Start-Sleep -Seconds ([Math]::Min($IntervalSeconds, $remainingSeconds))
    $process.Refresh()
    if ($process.HasExited) {
      throw "Native process exited during sampling with code $($process.ExitCode)."
    }
    $elapsed = ((Get-Date) - $startedAt).TotalSeconds
    $cpuSeconds = [double]$process.CPU - $baselineCpuSeconds
    $samples.Add([pscustomobject]@{
        elapsed_seconds = [Math]::Round($elapsed, 1)
        cpu_seconds = [Math]::Round($cpuSeconds, 3)
        cpu_percent_one_core = [Math]::Round(($cpuSeconds / [Math]::Max(0.001, $elapsed)) * 100, 1)
        working_set_mb = [Math]::Round($process.WorkingSet64 / 1MB, 1)
        private_mb = [Math]::Round($process.PrivateMemorySize64 / 1MB, 1)
        threads = $process.Threads.Count
      })
  }

  [pscustomobject]@{
    executable = $executable
    model = $ModelPath
    warmup_seconds = $WarmupSeconds
    sample_seconds = $SampleSeconds
    interval_seconds = $IntervalSeconds
    samples = $samples
  } | ConvertTo-Json -Depth 5
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
    $process.WaitForExit()
  }
}
