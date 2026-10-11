@echo off
REM Double-clickable wrapper for the Tauri desktop dev launcher.
REM See scripts\dev-desktop.ps1 for details.
REM
REM ASCII-ONLY ON PURPOSE. cmd.exe reads this file using the OEM code page
REM (936 on zh-CN); non-ASCII bytes are mis-decoded into mojibake, and a GBK
REM trail byte can swallow the next ASCII character (quote / %), breaking the
REM parser. Keep this file ASCII.
REM
REM If PowerShell exits non-zero (Rust toolchain missing, tauri failed to
REM start, npm install failed, ...), pause so the error stays on screen
REM instead of the window flashing shut.
powershell -ExecutionPolicy Bypass -File "%~dp0dev-desktop.ps1" %*
if %errorlevel% neq 0 (
  echo.
  echo [dev-desktop] Startup did not finish (exit code %errorlevel%).
  echo Check the error message above.
  echo If Rust is missing, install it first:
  echo     powershell -ExecutionPolicy Bypass -File scripts\install-rust.ps1
  pause
)
