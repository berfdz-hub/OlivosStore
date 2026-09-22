Add-Type -AssemblyName System.Drawing

$dir = Join-Path $PSScriptRoot "icons"
$sourcePath = Join-Path $dir "olivos-store-brand.png"

if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "No se encontró la imagen maestra: $sourcePath"
}

function New-Icon([int]$size, [string]$path) {
  $source = [System.Drawing.Image]::FromFile($sourcePath)
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($source, 0, 0, $size, $size)
  $g.Dispose()
  $source.Dispose()
  $tempPath = "$path.new.png"
  $bmp.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Copy-Item -LiteralPath $tempPath -Destination $path -Force
  Remove-Item -LiteralPath $tempPath
  Write-Host "Guardado: $path ($size x $size)"
}

New-Icon -size 512 -path (Join-Path $dir "icon-512.png")
New-Icon -size 192 -path (Join-Path $dir "icon-192.png")
New-Icon -size 180 -path (Join-Path $dir "apple-touch-icon.png")
New-Icon -size 32  -path (Join-Path $dir "favicon-32.png")
