Add-Type -AssemblyName System.Drawing

function New-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  # fondo: degradado verde oscuro -> verde marca
  $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
  $c1 = [System.Drawing.Color]::FromArgb(255, 15, 51, 37)   # #0F3325
  $c2 = [System.Drawing.Color]::FromArgb(255, 30, 91, 62)   # #1E5B3E
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45)
  $g.FillRectangle($brush, $rect)

  # punto/acento ámbar arriba (como el '.' de la marca en la app)
  $amber = [System.Drawing.Color]::FromArgb(255, 217, 139, 31) # #D98B1F
  $amberBrush = New-Object System.Drawing.SolidBrush($amber)
  $dotR = $size * 0.052
  $g.FillEllipse($amberBrush, ($size/2 - $dotR), ($size*0.155 - $dotR), $dotR*2, $dotR*2)

  # OLIVOS
  $fontBig = New-Object System.Drawing.Font("Segoe UI", ($size*0.175), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 234, 244, 236))
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $cx = [single]($size/2)
  $cyBig = [single]($size*0.46)
  $ptBig = New-Object System.Drawing.PointF $cx, $cyBig
  $g.DrawString("OLIVOS", $fontBig, $whiteBrush, $ptBig, $sf)

  # STORE (con letter-spacing manual)
  $fontSmall = New-Object System.Drawing.Font("Segoe UI", ($size*0.082), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $word = "S T O R E"
  $cySmall = [single]($size*0.635)
  $ptSmall = New-Object System.Drawing.PointF $cx, $cySmall
  $g.DrawString($word, $fontSmall, $amberBrush, $ptSmall, $sf)

  # linea fina bajo el texto
  $lineW = [single]([Math]::Max(1, $size*0.006))
  $linePen = New-Object System.Drawing.Pen $amber, $lineW
  $lw = $size * 0.30
  $x1 = [single]($size/2 - $lw/2)
  $x2 = [single]($size/2 + $lw/2)
  $ly = [single]($size*0.735)
  $g.DrawLine($linePen, $x1, $ly, $x2, $ly)

  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "Guardado: $path ($size x $size)"
}

$dir = "C:\Users\berfd\Desktop\claude\tienda-app\icons"
New-Icon -size 512 -path "$dir\icon-512.png"
New-Icon -size 192 -path "$dir\icon-192.png"
New-Icon -size 180 -path "$dir\apple-touch-icon.png"
New-Icon -size 32  -path "$dir\favicon-32.png"
