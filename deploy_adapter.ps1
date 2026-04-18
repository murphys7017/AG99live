param(
    [string]$PluginsRoot = "C:\Users\Administrator\Downloads\AstrBot\data\plugins",
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-MetadataValue {
    param(
        [string]$MetadataPath,
        [string]$Key
    )

    $pattern = "^\s*" + [Regex]::Escape($Key) + ":\s*(.+?)\s*$"
    foreach ($line in Get-Content -LiteralPath $MetadataPath -Encoding UTF8) {
        if ($line -match $pattern) {
            return $Matches[1].Trim()
        }
    }
    return $null
}

function Test-ShouldSkipRelativePath {
    param(
        [string]$RelativePath,
        [string[]]$PreserveDirectories
    )

    $normalized = $RelativePath -replace "/", "\"
    foreach ($preserve in $PreserveDirectories) {
        $prefix = $preserve.Trim("\")
        if (-not $prefix) {
            continue
        }
        if ($normalized -eq $prefix -or $normalized.StartsWith($prefix + "\")) {
            return $true
        }
    }
    return $false
}

function Get-RelativePathCompat {
    param(
        [string]$BasePath,
        [string]$TargetPath
    )

    $baseUri = New-Object System.Uri(($BasePath.TrimEnd('\') + '\'))
    $targetUri = New-Object System.Uri($TargetPath)
    $relativeUri = $baseUri.MakeRelativeUri($targetUri)
    return [System.Uri]::UnescapeDataString($relativeUri.ToString()).Replace('/', '\')
}

function Invoke-LoggedAction {
    param(
        [string]$Description,
        [scriptblock]$Action,
        [switch]$DryRun
    )

    if ($DryRun) {
        Write-Host "[DryRun] $Description"
        return
    }

    Write-Host $Description
    & $Action
}

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourcePluginRoot = Join-Path $RepoRoot "adapter"
$MetadataPath = Join-Path $SourcePluginRoot "metadata.yaml"

if (-not (Test-Path -LiteralPath $SourcePluginRoot -PathType Container)) {
    throw "Source plugin directory not found: $SourcePluginRoot"
}
if (-not (Test-Path -LiteralPath $MetadataPath -PathType Leaf)) {
    throw "metadata.yaml not found: $MetadataPath"
}

$PluginName = Get-MetadataValue -MetadataPath $MetadataPath -Key "name"
if ([string]::IsNullOrWhiteSpace($PluginName)) {
    throw "Failed to resolve plugin name from metadata.yaml"
}
if ($PluginName -notlike "astrbot_plugin_*") {
    throw "Refusing to deploy plugin with unexpected name: $PluginName"
}

$ResolvedPluginsRoot = (Resolve-Path -LiteralPath $PluginsRoot).Path
$TargetPluginRoot = Join-Path $ResolvedPluginsRoot $PluginName
$ResolvedTargetPluginRoot = [System.IO.Path]::GetFullPath($TargetPluginRoot)

if (-not $ResolvedTargetPluginRoot.StartsWith($ResolvedPluginsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Resolved target path escapes plugins root: $ResolvedTargetPluginRoot"
}

$PreserveDirectories = @("live2ds")
$SkipDirectoryNames = @("__pycache__", ".git", ".venv")
$SkipFilePatterns = @("*.pyc")
$ManagedRelativeFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

Invoke-LoggedAction -Description "Ensure target plugin directory exists: $ResolvedTargetPluginRoot" -DryRun:$DryRun -Action {
    New-Item -ItemType Directory -Path $ResolvedTargetPluginRoot -Force | Out-Null
}

$sourceFiles = Get-ChildItem -LiteralPath $SourcePluginRoot -Recurse -File | Where-Object {
    $relativePath = Get-RelativePathCompat -BasePath $SourcePluginRoot -TargetPath $_.FullName
    if (Test-ShouldSkipRelativePath -RelativePath $relativePath -PreserveDirectories $PreserveDirectories) {
        return $false
    }
    if ($SkipDirectoryNames -contains $_.Directory.Name) {
        return $false
    }
    foreach ($pattern in $SkipFilePatterns) {
        if ($_.Name -like $pattern) {
            return $false
        }
    }
    return $true
}

foreach ($file in $sourceFiles) {
    $relativePath = Get-RelativePathCompat -BasePath $SourcePluginRoot -TargetPath $file.FullName
    [void]$ManagedRelativeFiles.Add($relativePath)
    $targetPath = Join-Path $ResolvedTargetPluginRoot $relativePath
    $targetParent = Split-Path -Parent $targetPath

    Invoke-LoggedAction -Description "Ensure directory: $targetParent" -DryRun:$DryRun -Action {
        New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    }

    Invoke-LoggedAction -Description "Copy file: $relativePath" -DryRun:$DryRun -Action {
        Copy-Item -LiteralPath $file.FullName -Destination $targetPath -Force
    }
}

if (Test-Path -LiteralPath $ResolvedTargetPluginRoot -PathType Container) {
    $targetFiles = Get-ChildItem -LiteralPath $ResolvedTargetPluginRoot -Recurse -File | Where-Object {
        $relativePath = Get-RelativePathCompat -BasePath $ResolvedTargetPluginRoot -TargetPath $_.FullName
        if (Test-ShouldSkipRelativePath -RelativePath $relativePath -PreserveDirectories $PreserveDirectories) {
            return $false
        }
        foreach ($pattern in $SkipFilePatterns) {
            if ($_.Name -like $pattern) {
                return $false
            }
        }
        return $true
    }

    foreach ($file in $targetFiles) {
        $relativePath = Get-RelativePathCompat -BasePath $ResolvedTargetPluginRoot -TargetPath $file.FullName
        if ($ManagedRelativeFiles.Contains($relativePath)) {
            continue
        }

        Invoke-LoggedAction -Description "Remove stale file: $relativePath" -DryRun:$DryRun -Action {
            Remove-Item -LiteralPath $file.FullName -Force
        }
    }

    $targetDirectories = Get-ChildItem -LiteralPath $ResolvedTargetPluginRoot -Recurse -Directory |
        Sort-Object FullName -Descending

    foreach ($directory in $targetDirectories) {
        $relativePath = Get-RelativePathCompat -BasePath $ResolvedTargetPluginRoot -TargetPath $directory.FullName
        if (Test-ShouldSkipRelativePath -RelativePath $relativePath -PreserveDirectories $PreserveDirectories) {
            continue
        }
        if ($SkipDirectoryNames -contains $directory.Name) {
            Invoke-LoggedAction -Description "Remove skipped directory: $relativePath" -DryRun:$DryRun -Action {
                Remove-Item -LiteralPath $directory.FullName -Recurse -Force
            }
            continue
        }

        $hasChildren = @(Get-ChildItem -LiteralPath $directory.FullName -Force).Count -gt 0
        if (-not $hasChildren) {
            Invoke-LoggedAction -Description "Remove empty directory: $relativePath" -DryRun:$DryRun -Action {
                Remove-Item -LiteralPath $directory.FullName -Force
            }
        }
    }
}

Write-Host ""
Write-Host "Deploy source : $SourcePluginRoot"
Write-Host "Deploy target : $ResolvedTargetPluginRoot"
Write-Host "Plugin name   : $PluginName"
if ($DryRun) {
    Write-Host "Mode          : DryRun"
} else {
    Write-Host "Mode          : Apply"
}
