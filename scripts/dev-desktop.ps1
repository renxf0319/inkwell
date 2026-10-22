# dev-desktop.ps1
# Launch Kore in DESKTOP dev mode (Tauri) with hot reload.
#
# Everyday local-dev entry point: starts the Vite dev server (HMR) and opens a
# real native window that reloads instantly on every save. No installer needed.
#
# Rust toolchain resolution is PORTABLE: it finds cargo wherever it lives
# (already on PATH, via $CARGO_HOME, on common non-system drives, or the
# default ~/.cargo) instead of assuming a fixed drive layout. Both the
# `<root>\cargo` and `<root>\.cargo` layouts are supported.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/dev-desktop.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/dev-desktop.ps1 -RustHome "D:\rust"
#   powershell -ExecutionPolicy Bypass -File scripts/dev-desktop.ps1 -NoInstall

param(
  [string]$RustHome = "",
  [switch]$NoInstall = $false
)

$ErrorActionPreference = "Stop"

# Resolve the repo root FIRST: everything below (log path, CARGO_HOME, etc.)
# depends on it. Defining $repo after it is used caused a null-argument fatal
# error that aborted the launcher before any diagnostics could run.
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# Diagnostics: mirror all output to dev-desktop.log so a crash is never a silent
# flash. Start-Transcript can be blocked under Constrained Language Mode; ignore
# that failure and keep running.
$logFile = Join-Path $repo "dev-desktop.log"
try { Start-Transcript -Path $logFile -Append -ErrorAction Stop } catch { }

function Resolve-RustHome {
  param([string]$Explicit)
  if ($Explicit) { return $Explicit.TrimEnd('\') }

  # 1) Explicit CARGO_HOME (points at the cargo dir; take its parent as root)
  if ($env:CARGO_HOME) {
    $p = Split-Path $env:CARGO_HOME -Parent
    if ($p) { return $p }
  }

  # 2) cargo already on PATH (rustup default install OR any custom location)
  $cargoCmd = Get-Command cargo.exe -ErrorAction SilentlyContinue
  if (-not $cargoCmd) { $cargoCmd = Get-Command cargo -ErrorAction SilentlyContinue }
  if ($cargoCmd) {
    # cargo lives at <root>\cargo\bin\cargo.exe  or  <root>\.cargo\bin\cargo.exe,
    # so walk up THREE levels from the executable to reach <root>.
    $root = Split-Path (Split-Path (Split-Path $cargoCmd.Source -Parent) -Parent) -Parent
    if (Test-Path (Join-Path $root "cargo\bin\cargo.exe"))  { return $root }
    if (Test-Path (Join-Path $root ".cargo\bin\cargo.exe")) { return $root }
    return $root
  }

  # 3) Common non-system drive locations (legacy kore convention)
  foreach ($d in @("E:\rust", "D:\rust", "F:\rust")) {
    if (Test-Path (Join-Path $d "cargo\bin\cargo.exe")) { return $d }
  }

  # 4) Default rustup location (may be on C:)
  if (Test-Path (Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe")) {
    return $env:USERPROFILE
  }
  return $null
}

# NOTE: do NOT name this variable `$home`. PowerShell variable names are
# case-insensitive, and `$HOME` is a READ-ONLY automatic variable holding the
# user's home directory. Assigning to `$home` throws:
#   WriteError: (HOME:String) [], ParentContainsErrorRecordException
#     FullyQualifiedErrorId : VariableNotWritable
# which would abort the launcher before Rust is even located.
$rustRoot = Resolve-RustHome -Explicit $RustHome
if (-not $rustRoot) {
  Write-Host ""
  Write-Host "[dev] Rust toolchain not found." -ForegroundColor Yellow
  Write-Host "      Install it first (choose a non-C: drive when prompted):"
  Write-Host "        powershell -ExecutionPolicy Bypass -File scripts/install-rust.ps1"
  Write-Host ""
  Write-Host "      Or, for a zero-setup run in the browser (no Rust needed):"
  Write-Host "        npm run dev"
  exit 1
}

# Resolve cargo/rustup layout: support both `<root>\cargo` and `<root>\.cargo`.
if (Test-Path (Join-Path $rustRoot "cargo\bin\cargo.exe")) {
  $cargoHome  = Join-Path $rustRoot "cargo"
  $rustupHome = Join-Path $rustRoot "rustup"
} elseif (Test-Path (Join-Path $rustRoot ".cargo\bin\cargo.exe")) {
  $cargoHome  = Join-Path $rustRoot ".cargo"
  $rustupHome = Join-Path $rustRoot ".rustup"
} else {
  Write-Host "[dev] Found '$rustRoot' but no cargo.exe inside; aborting." -ForegroundColor Red
  exit 1
}

$env:CARGO_HOME  = $cargoHome
$env:RUSTUP_HOME = $rustupHome
$cargoBin = Join-Path $cargoHome "bin"
if ((Test-Path $cargoBin) -and ($env:Path -notlike "*$cargoBin*")) {
  $env:Path = "$cargoBin;$env:Path"
}

# GNU/MinGW fallback for this machine: when the default MSVC linker (link.exe
# from VS Build Tools) is absent, the cargo config at $CARGO_HOME points the
# build at x86_64-pc-windows-gnu and we must put MinGW's bin on PATH so the
# linker / archiver / windres (resource compiler) resolve. On a machine that
# uses MSVC (no E:\mingw64), this is a no-op.
$mingwBin = "E:\mingw64\bin"
if ((Test-Path $mingwBin) -and ($env:Path -notlike "*$mingwBin*")) {
  $env:Path = "$mingwBin;$env:Path"
  Write-Host "[dev] GNU toolchain on PATH: $mingwBin"
}

Write-Host ""
Write-Host "[dev] CARGO_HOME  = $cargoHome"
Write-Host "[dev] RUSTUP_HOME = $rustupHome"

$cargo = Join-Path $cargoBin "cargo.exe"
if (-not (Test-Path $cargo)) { $cargo = "cargo" }

Write-Host "[dev] Rust toolchain check:"
& $cargo --version

if (-not $NoInstall -and -not (Test-Path (Join-Path $repo "node_modules"))) {
  Write-Host "[dev] node_modules missing, running npm install ..."
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[dev] npm install failed (exit $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

Write-Host ""
Write-Host "[dev] Starting Tauri dev (Vite HMR + native window, hot reload on save)."
Write-Host "[dev] Close the app window (or press Ctrl+C here) to stop."
Write-Host ""

# --- Resolve Node (portable) ----------------------------------------------
# Order: fnm/FNM_DIR pinned > WorkBuddy-managed Node > PATH default.
# The managed Node lives on disk under
#   %USERPROFILE%\.workbuddy\binaries\node\versions
# but is typically NOT on PATH for a double-clicked launcher, which would
# otherwise fall back to a stale system Node (e.g. v16) and fail check-node.mjs.
$nodeVersion = '22'
$vnFile = Join-Path $repo '.node-version'
if (Test-Path $vnFile) { $nodeVersion = (Get-Content $vnFile -Raw).Trim() }

$nodeDir = $null

# 1) fnm-pinned version
if ($env:FNM_DIR) {
  $fnmCandidate = Join-Path $env:FNM_DIR "node-versions\v$nodeVersion\installation"
  if (Test-Path (Join-Path $fnmCandidate 'node.exe')) { $nodeDir = $fnmCandidate }
}

# 2) WorkBuddy-managed Node: prefer the "current" pointer, else the newest dir
if (-not $nodeDir) {
  $wbRoot = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'
  if (Test-Path $wbRoot) {
    $wbCurrent = Join-Path $wbRoot 'current'
    if (Test-Path (Join-Path $wbCurrent 'node.exe')) {
      $nodeDir = $wbCurrent
    } else {
      $wbNewest = Get-ChildItem $wbRoot -Directory -ErrorAction SilentlyContinue |
                  Sort-Object Name -Descending |
                  Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } |
                  Select-Object -First 1
      if ($wbNewest) { $nodeDir = $wbNewest.FullName }
    }
  }
}

if ($nodeDir) {
  $env:Path = "$nodeDir;$env:Path"
  $nv = & (Join-Path $nodeDir 'node.exe') -v
  Write-Host "[dev] node $nv  ($nodeDir)"
} else {
  Write-Host "[dev] No managed Node found; falling back to PATH default." -ForegroundColor Yellow
}

npm run tauri dev
# Propagate the exit code: when tauri fails to start (missing Rust deps, compile
# errors, ...) the outer .cmd can then pause instead of the window flashing
# shut and hiding the error.
exit $LASTEXITCODE
