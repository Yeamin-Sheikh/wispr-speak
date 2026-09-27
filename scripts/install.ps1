# scripts/install.ps1
# Installs or updates Wispr Tell to AppData/Local/Programs/Wispr Tell
# Configures Start Menu, Desktop shortcuts, and Windows Registry metadata.

param(
  [string]$SourceDir = "e:\Scripts\Wispr Tell",
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

Write-Host "=== Wispr Tell Installer ===" -ForegroundColor Cyan

# 1. Terminate running instances
Write-Host "Closing running instances of Wispr Tell..." -ForegroundColor Yellow
Get-Process | Where-Object { $_.ProcessName -like "*Wispr Tell*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$procs = Get-Process | Where-Object { $_.ProcessName -like "*Wispr Tell*" }
if ($procs) {
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

# 2. Target paths
$TargetDir = "$env:LOCALAPPDATA\Programs\Wispr Tell"
$AppDir = "$TargetDir\resources\app"
$PkgJsonPath = "$SourceDir\resources\app\package.json"

# Read version and author from package.json if present
$Version = "1.0.0"
$Publisher = "Sheikh Technologies Inc."
if (Test-Path $PkgJsonPath) {
  try {
    $pkg = Get-Content $PkgJsonPath -Raw | ConvertFrom-Json
    if ($pkg.version) { $Version = $pkg.version }
    if ($pkg.author) { $Publisher = $pkg.author }
  } catch {}
}

Write-Host "Installing version $Version by $Publisher..." -ForegroundColor Cyan

# 3. Create target directory
if (-not (Test-Path $TargetDir)) {
  New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
}

# 4. Copy files
Write-Host "Copying application binaries and assets..." -ForegroundColor Yellow
try {
  Copy-Item -Path "$SourceDir\*" -Destination $TargetDir -Recurse -Force -ErrorAction Stop
} catch {
  Write-Host "Notice: Base binaries locked, synchronizing resources/app..." -ForegroundColor Yellow
  Copy-Item -Path "$SourceDir\resources\app\*" -Destination "$TargetDir\resources\app" -Recurse -Force
}

# 4.1 Unblock files to eliminate Microsoft Defender SmartScreen prompts
Write-Host "Unblocking application binaries to eliminate SmartScreen warnings..." -ForegroundColor Yellow
Get-ChildItem -Path $TargetDir -Recurse | Unblock-File -ErrorAction SilentlyContinue

# 5. Create uninstaller script in target directory
$UninstallScript = @"
param([switch]`$Quiet)
Write-Host "Uninstalling Wispr Tell..." -ForegroundColor Yellow
Get-Process | Where-Object { `$_.ProcessName -like "*Wispr Tell*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

`$desktopLnk = "`$([Environment]::GetFolderPath('Desktop'))\Wispr Tell.lnk"
`$startMenuLnk = "`$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Wispr Tell.lnk"
if (Test-Path `$desktopLnk) { Remove-Item -Path `$desktopLnk -Force -ErrorAction SilentlyContinue }
if (Test-Path `$startMenuLnk) { Remove-Item -Path `$startMenuLnk -Force -ErrorAction SilentlyContinue }

`$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Wispr Tell"
if (Test-Path `$regPath) { Remove-Item -Path `$regPath -Recurse -Force -ErrorAction SilentlyContinue }

`$target = "`$env:LOCALAPPDATA\Programs\Wispr Tell"
if (Test-Path `$target) {
  # Schedule removal of folder upon script termination
  Start-Process powershell.exe -ArgumentList "-WindowStyle Hidden -Command Start-Sleep -Seconds 1; Remove-Item -Path '`$target' -Recurse -Force" -WindowStyle Hidden
}
if (-not `$Quiet) {
  [System.Windows.Forms.MessageBox]::Show("Wispr Tell has been uninstalled.", "Wispr Tell", 0, 64)
}
"@

Set-Content -Path "$TargetDir\uninstall.ps1" -Value $UninstallScript -Encoding UTF8

# 6. Shortcuts
Write-Host "Updating shortcuts..." -ForegroundColor Yellow
$wsh = New-Object -ComObject WScript.Shell
$IconPath = "$AppDir\assets\icon.ico"
$ExePath = "$TargetDir\Wispr Tell.exe"

# Start Menu
$StartMenuDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
$StartMenuLnk = "$StartMenuDir\Wispr Tell.lnk"
$s = $wsh.CreateShortcut($StartMenuLnk)
$s.TargetPath = $ExePath
$s.WorkingDirectory = $TargetDir
$s.IconLocation = "$IconPath,0"
$s.Description = "Wispr Tell - Voice typing by $Publisher"
$s.Save()

# Desktop
$DesktopDir = [Environment]::GetFolderPath('Desktop')
$DesktopLnk = "$DesktopDir\Wispr Tell.lnk"
$d = $wsh.CreateShortcut($DesktopLnk)
$d.TargetPath = $ExePath
$d.WorkingDirectory = $TargetDir
$d.IconLocation = "$IconPath,0"
$d.Description = "Wispr Tell - Voice typing by $Publisher"
$d.Save()

# 7. Calculate estimated size in KB
$SizeKB = 0
try {
  $sizeBytes = (Get-ChildItem -Path $TargetDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
  $SizeKB = [math]::Round($sizeBytes / 1024)
} catch {
  $SizeKB = 250000
}

# 8. Windows Registry Registration
Write-Host "Registering in Windows Installed Apps..." -ForegroundColor Yellow
$RegPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Wispr Tell"
if (-not (Test-Path $RegPath)) {
  New-Item -Path $RegPath -Force | Out-Null
}

$Today = Get-Date -Format "yyyyMMdd"
$UninstallCmd = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -Command `& `'$TargetDir\uninstall.ps1`'"
$QuietUninstallCmd = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -Command `& `'$TargetDir\uninstall.ps1`' -Quiet"

Set-ItemProperty -Path $RegPath -Name "DisplayName" -Value "Wispr Tell" -Force
Set-ItemProperty -Path $RegPath -Name "DisplayVersion" -Value $Version -Force
Set-ItemProperty -Path $RegPath -Name "Publisher" -Value $Publisher -Force
Set-ItemProperty -Path $RegPath -Name "InstallLocation" -Value $TargetDir -Force
Set-ItemProperty -Path $RegPath -Name "InstallDate" -Value $Today -Force
Set-ItemProperty -Path $RegPath -Name "DisplayIcon" -Value "$IconPath,0" -Force
Set-ItemProperty -Path $RegPath -Name "HelpLink" -Value "https://github.com/Yeamin-Sheikh/wispr-tell" -Force
Set-ItemProperty -Path $RegPath -Name "URLInfoAbout" -Value "https://github.com/Yeamin-Sheikh/wispr-tell" -Force
Set-ItemProperty -Path $RegPath -Name "EstimatedSize" -Value $SizeKB -Type DWord -Force
Set-ItemProperty -Path $RegPath -Name "UninstallString" -Value $UninstallCmd -Force
Set-ItemProperty -Path $RegPath -Name "QuietUninstallString" -Value $QuietUninstallCmd -Force
Set-ItemProperty -Path $RegPath -Name "NoModify" -Value 1 -Type DWord -Force
Set-ItemProperty -Path $RegPath -Name "NoRepair" -Value 1 -Type DWord -Force

Write-Host "Installation completed successfully." -ForegroundColor Green
Write-Host "Installed: Wispr Tell $Version" -ForegroundColor Green
Write-Host "Publisher: $Publisher" -ForegroundColor Green

# 9. Launch
if (-not $NoLaunch) {
  Write-Host "Launching Wispr Tell..." -ForegroundColor Cyan
  Start-Process -FilePath $ExePath -WorkingDirectory $TargetDir
}
