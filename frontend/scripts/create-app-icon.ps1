param(
  [string]$SourcePath = "$(Join-Path $PSScriptRoot '..\..\astrbot_plugin_ag99live_adapter\live2ds\Mk6_1.0\icon_VB.png')",
  [string]$OutputPath = "$(Join-Path $PSScriptRoot '..\resources\app-icon.png')"
)

Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile($SourcePath)
try {
  $crop = [System.Drawing.Rectangle]::new(150, 200, 500, 500)
  $bitmap = [System.Drawing.Bitmap]::new(512, 512)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.DrawImage(
        $source,
        [System.Drawing.Rectangle]::new(0, 0, 512, 512),
        $crop,
        [System.Drawing.GraphicsUnit]::Pixel
      )
    } finally {
      $graphics.Dispose()
    }

    $outputDirectory = Split-Path -Parent $OutputPath
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bitmap.Dispose()
  }
} finally {
  $source.Dispose()
}
