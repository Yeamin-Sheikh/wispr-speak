# Generate professional multi-resolution icons for Wispr Tell
Add-Type -AssemblyName System.Drawing

function Draw-WisprBadge([int]$size, [bool]$monochromeOnly = $false) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    if (-not $monochromeOnly) {
        # Squircle background
        $pad = [float]($size * 0.04)
        $badgeW = [float]($size - $pad * 2)
        $badgeH = [float]($size - $pad * 2)
        $radius = [float]($badgeW * 0.23)

        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddArc($pad, $pad, $radius * 2, $radius * 2, 180, 90)
        $path.AddArc($pad + $badgeW - $radius * 2, $pad, $radius * 2, $radius * 2, 270, 90)
        $path.AddArc($pad + $badgeW - $radius * 2, $pad + $badgeH - $radius * 2, $radius * 2, $radius * 2, 0, 90)
        $path.AddArc($pad, $pad + $badgeH - $radius * 2, $radius * 2, $radius * 2, 90, 90)
        $path.CloseFigure()

        # Dark sleek gradient
        $rect = New-Object System.Drawing.RectangleF $pad, $pad, $badgeW, $badgeH
        $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect,
            ([System.Drawing.Color]::FromArgb(255, 24, 28, 38)),
            ([System.Drawing.Color]::FromArgb(255, 10, 12, 16)),
            45.0
        $g.FillPath($bgBrush, $path)

        # Subtle highlight border
        $penWidth = [float]([Math]::Max(1.0, $size * 0.015))
        $penColor = [System.Drawing.Color]::FromArgb(55, 255, 255, 255)
        $borderPen = New-Object System.Drawing.Pen ($penColor, $penWidth)
        $g.DrawPath($borderPen, $path)
        $borderPen.Dispose()
        $bgBrush.Dispose()
        $path.Dispose()
    }

    # Draw 5 harmonic acoustic bars forming the "W" monogram
    # Bar centers relative to size: 0.28, 0.39, 0.50, 0.61, 0.72
    # Bar heights relative to size: 0.28, 0.58, 0.35, 0.58, 0.28
    $barW = [float]([Math]::Max(1.0, $size * 0.075))
    $barRadius = [float]($barW / 2.0)
    $centerY = [float]($size * 0.5)

    $barData = @(
        @{ X = 0.26; H = 0.28; Alpha = 200 },
        @{ X = 0.38; H = 0.58; Alpha = 255 },
        @{ X = 0.50; H = 0.35; Alpha = 245 },
        @{ X = 0.62; H = 0.58; Alpha = 255 },
        @{ X = 0.74; H = 0.28; Alpha = 200 }
    )

    foreach ($b in $barData) {
        $bx = [float]($size * $b.X - $barW / 2.0)
        $bh = [float]($size * $b.H)
        $by = [float]($centerY - $bh / 2.0)

        $barPath = New-Object System.Drawing.Drawing2D.GraphicsPath
        if ($barW -ge 2.0 -and $bh -ge $barW) {
            $barPath.AddArc($bx, $by, $barW, $barW, 180, 180)
            $barPath.AddArc($bx, $by + $bh - $barW, $barW, $barW, 0, 180)
            $barPath.CloseFigure()
        } else {
            $barPath.AddRectangle((New-Object System.Drawing.RectangleF $bx, $by, $barW, $bh))
        }

        $barColor = if ($monochromeOnly) {
            [System.Drawing.Color]::FromArgb($b.Alpha, 255, 255, 255)
        } else {
            [System.Drawing.Color]::FromArgb($b.Alpha, 255, 255, 255)
        }
        $barBrush = New-Object System.Drawing.SolidBrush $barColor
        $g.FillPath($barBrush, $barPath)

        $barBrush.Dispose()
        $barPath.Dispose()
    }

    $g.Dispose()
    return $bmp
}

$assetsDir = "e:\Scripts\GitHub\wispr-tell\assets"

# 1. Generate master PNGs: 256x256, 128x128, 64x64, 48x48, 32x32, 24x24, 16x16
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngBytesList = @()

foreach ($s in $sizes) {
    $bmp = Draw-WisprBadge $s $false
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $pngBytesList += [PSCustomObject]@{ Size = $s; Bytes = $bytes }
    $ms.Dispose()
    $bmp.Dispose()
}

# Save main icon.png (256x256)
$mainBmp = Draw-WisprBadge 256 $false
$mainBmp.Save("$assetsDir\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$mainBmp.Dispose()
Write-Output "Saved $assetsDir\icon.png"

# Save system tray icon (32x32 monochrome clean audio wave)
$trayBmp = Draw-WisprBadge 32 $true
$trayBmp.Save("$assetsDir\tray.png", [System.Drawing.Imaging.ImageFormat]::Png)
$trayBmp.Dispose()
Write-Output "Saved $assetsDir\tray.png"

# 2. Build multi-resolution icon.ico
$icoStream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $icoStream

# Header: reserved(0), type(1=icon), count
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$pngBytesList.Count)

# Calculate image data start offset
# 6 bytes header + 16 bytes per entry
$dataOffset = 6 + ($pngBytesList.Count * 16)

foreach ($item in $pngBytesList) {
    $s = $item.Size
    $wByte = if ($s -ge 256) { [byte]0 } else { [byte]$s }
    $hByte = if ($s -ge 256) { [byte]0 } else { [byte]$s }

    $writer.Write([byte]$wByte)        # Width
    $writer.Write([byte]$hByte)        # Height
    $writer.Write([byte]0)             # Color palette count (0 for PNG/32bpp)
    $writer.Write([byte]0)             # Reserved
    $writer.Write([uint16]1)           # Color planes
    $writer.Write([uint16]32)          # Bits per pixel
    $writer.Write([uint32]$item.Bytes.Length) # Image bytes count
    $writer.Write([uint32]$dataOffset) # Data offset

    $dataOffset += $item.Bytes.Length
}

# Write each PNG stream
foreach ($item in $pngBytesList) {
    $writer.Write($item.Bytes)
}

$writer.Flush()
[System.IO.File]::WriteAllBytes("$assetsDir\icon.ico", $icoStream.ToArray())
$writer.Dispose()
$icoStream.Dispose()

Write-Output "Saved multi-resolution Windows icon at $assetsDir\icon.ico"
