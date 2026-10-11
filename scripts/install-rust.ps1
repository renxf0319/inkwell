# install-rust.ps1
# Interactive Rust toolchain installer for Kore (Tauri desktop build).
# Lets you choose the install drive so the toolchain never writes to C:\Users.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/install-rust.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/install-rust.ps1 -InstallDir "D:\myrust"
#   powershell -ExecutionPolicy Bypass -File scripts/install-rust.ps1 -Gnu
#
# Options:
#   -InstallDir <path>   Install location for CARGO_HOME / RUSTUP_HOME (skip the prompt).
#   -Gnu                 Install the x86_64-pc-windows-gnu target instead of MSVC.

param(
  [string]$InstallDir = "",
  [switch]$Gnu = $false
)

$ErrorActionPreference = "Stop"

function Pick-DefaultDrive {
  $fixed = @()
  try {
    $fixed = Get-CimInstance -ClassName Win32_LogicalDisk -ErrorAction SilentlyContinue |
             Where-Object { $_.DriveType -eq 3 } | Select-Object -ExpandProperty DeviceID
  } catch { }
  if (-not $fixed) {
    $fixed = (Get-PSDrive -PSProvider FileSystem).Root
  }
  $other = $fixed | Where-Object { $_ -notmatch '^[Cc]:' } | Select-Object -First 1
  if ($other) { return $other.TrimEnd('\') }
  return "E:"
}

if ($InstallDir -eq "") {
  $default = Join-Path (Pick-DefaultDrive) "rust"
  Write-Host ""
  Write-Host "Rust toolchain install location (CARGO_HOME / RUSTUP_HOME):"
  Write-Host "  Default: $default"
  $ans = Read-Host "Enter a path, or press Enter to accept default"
  if ($ans -ne "") { $InstallDir = $ans.Trim() } else { $InstallDir = $default }
}

$InstallDir = $InstallDir.TrimEnd('\')
if (-not [System.IO.Path]::IsPathRooted($InstallDir)) {
  Write-Error "Please provide an absolute path (e.g. E:\rust)."
  exit 1
}

$driveLetter = $InstallDir.Substring(0, 1)
if ($driveLetter -ieq 'C') {
  Write-Warning "You chose a path on the C: drive. The toolchain data will be written to C:."
  $ok = Read-Host "Continue anyway? (y/N)"
  if ($ok -notmatch '^[Yy]') { Write-Host "Aborted."; exit 0 }
}

$cargoHome = Join-Path $InstallDir "cargo"
$rustupHome = Join-Path $InstallDir "rustup"

New-Item -ItemType Directory -Force -Path $cargoHome | Out-Null
New-Item -ItemType Directory -Force -Path $rustupHome | Out-Null

# Point THIS process at the chosen location (rustup-init reads these env vars).
$env:CARGO_HOME = $cargoHome
$env:RUSTUP_HOME = $rustupHome

# Persist for every future terminal (User scope) so you never re-set them.
[Environment]::SetEnvironmentVariable("CARGO_HOME", $cargoHome, "User")
[Environment]::SetEnvironmentVariable("RUSTUP_HOME", $rustupHome, "User")

Write-Host ""
Write-Host "Toolchain will be installed to:"
Write-Host "  CARGO_HOME = $cargoHome"
Write-Host "  RUSTUP_HOME = $rustupHome"

# Download rustup-init to a transient temp location (not toolchain data).
$tmp = Join-Path $env:TEMP "rustup-init.exe"
if (-not (Test-Path $tmp)) {
  Write-Host "Downloading rustup-init ..."
  Invoke-WebRequest -Uri "https://win.rustup.rs" -OutFile $tmp -UseBasicParsing
}

$args = @("-y", "--default-toolchain", "stable", "--profile", "minimal", "--no-modify-path")
if ($Gnu) { $args += @("--default-host", "x86_64-pc-windows-gnu") }

Write-Host "Running rustup-init ..."
# rustup-init 在缺少前置（如 MSVC C++ 链接器）时会往 stderr 打一条警告并继续安装；
# 但本脚本开头设了 $ErrorActionPreference="Stop"，PowerShell 会把原生程序的 stderr
# 当成致命错误（NativeCommandError）从而中止安装。这里临时放宽错误偏好，把 stderr
# 合并进输出流避免被误判为异常，再检查真实退出码。
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $tmp @args 2>&1 | ForEach-Object { $_ }
$rustupRc = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($rustupRc -ne 0) {
  Write-Host "[install-rust] rustup-init failed (exit $rustupRc)." -ForegroundColor Red
  exit $rustupRc
}

# Add cargo\bin to the user PATH so `cargo` / `rustc` work in new terminals.
$cargoBin = Join-Path $cargoHome "bin"
$path = [Environment]::GetEnvironmentVariable("Path", "User")
if ($path -notlike "*$cargoBin*") {
  if ($path) { $path = "$cargoBin;$path" } else { $path = $cargoBin }
  [Environment]::SetEnvironmentVariable("Path", $path, "User")
  Write-Host "Added $cargoBin to user PATH."
}

Write-Host ""
Write-Host "Done. Open a NEW terminal and verify with:  rustc --version"
Write-Host "Then: cd kore && npm install && npm run tauri dev"
if (-not $Gnu) {
  Write-Host ""
  Write-Host "NOTE: the default MSVC target needs the Visual Studio Build Tools"
  Write-Host "      (C++ desktop development workload) for the linker. That Microsoft"
  Write-Host "      tool installs to C: by default and is outside Kore's control;"
  Write-Host "      only the Rust toolchain and crate cache above are kept off C:."
}
