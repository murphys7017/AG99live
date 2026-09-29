param(
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

$frontendRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $frontendRoot "native\spout"
$outputRoot = Join-Path $frontendRoot "resources\spout"
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"

if (-not (Test-Path $vsWhere)) {
  throw "Visual Studio Build Tools with the MSVC x64 compiler are required to build AG99liveSpoutSender.exe."
}

$installationPath = & $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installationPath) {
  throw "Visual Studio Build Tools with the MSVC x64 compiler are required to build AG99liveSpoutSender.exe."
}

$vsDevCmd = Join-Path $installationPath "Common7\Tools\VsDevCmd.bat"
$sourcePath = Join-Path $sourceRoot "AG99liveSpoutSender.cpp"
$outputPath = Join-Path $outputRoot "AG99liveSpoutSender.exe"
$licenseSourcePath = Join-Path $sourceRoot "LICENSE-Spout2.txt"
$licenseOutputPath = Join-Path $outputRoot "LICENSE-Spout2.txt"
$intermediateRoot = Join-Path $env:TEMP "ag99live-spout-build"
$objectPath = Join-Path $intermediateRoot "AG99liveSpoutSender.obj"
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
New-Item -ItemType Directory -Force -Path $intermediateRoot | Out-Null

$compile = '"{0}" -arch=x64 -host_arch=x64 >nul && cl /nologo /EHsc /std:c++20 /O2 /I "{1}" /Fo:"{2}" "{3}" /Fe:"{4}"' -f `
  $vsDevCmd, $sourceRoot, $objectPath, $sourcePath, $outputPath
Push-Location $intermediateRoot
try {
  cmd /c $compile
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to build AG99liveSpoutSender.exe."
  }
} finally {
  Pop-Location
}
Remove-Item -LiteralPath $objectPath -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $licenseSourcePath -Destination $licenseOutputPath -Force

Write-Host "Built $outputPath"
