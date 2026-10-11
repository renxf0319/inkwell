@echo off
REM ============================================================================
REM  Kore dev launcher (browser mode).
REM
REM  ASCII-ONLY ON PURPOSE. cmd.exe reads this file using the OEM code page
REM  (936 on zh-CN). Non-ASCII bytes get mis-decoded, garble the output, and -
REM  worst case - a GBK trail byte can swallow the following ASCII character
REM  (such as a quote or %), which breaks the parser and shows up as a window
REM  that flashes shut immediately. Keep this file ASCII.
REM
REM  Runs "npm run dev" using the first usable Node >= 18 found in:
REM    1) fnm, if it is on PATH
REM    2) nvm-windows, if NVM_HOME is set
REM    3) the WorkBuddy-managed Node bundled with the IDE, which lives on disk
REM       under %USERPROFILE%\.workbuddy\binaries\node\versions but is usually
REM       NOT on PATH when this file is launched by double-click
REM    4) whatever Node is already on PATH (>= 18 enforced by check-node.mjs)
REM
REM  Any startup failure pauses instead of closing, so the error stays visible.
REM
REM  Usage:
REM    scripts\dev.cmd
REM    scripts\dev.cmd --port 5174      (extra args are forwarded to vite)
REM ============================================================================
setlocal EnableExtensions

REM --- Always run from the project root, even when double-clicked ------------
cd /d "%~dp0.."
if not exist "package.json" (
  echo [dev] package.json not found in "%CD%"
  echo [dev] This launcher must live inside the kore repository.
  pause
  exit /b 1
)

REM --- Target version (only used to pin via fnm / nvm-windows) --------------
set "KORE_NODE_VERSION="
if exist ".node-version" for /f "usebackq delims=" %%v in (".node-version") do if not defined KORE_NODE_VERSION set "KORE_NODE_VERSION=%%v"
if not defined KORE_NODE_VERSION set "KORE_NODE_VERSION=22"

REM --- 1) fnm, if it is on PATH ----------------------------------------------
where fnm >nul 2>nul
if not errorlevel 1 (
  call fnm exec --using=%KORE_NODE_VERSION% -- npm.cmd run dev -- %*
  if errorlevel 1 (
    echo.
    echo [dev] fnm failed to start the dev server. See the error above.
    pause
  )
  exit /b %errorlevel%
)

REM --- 2) nvm-windows: use its installed node if present ---------------------
if defined NVM_HOME if exist "%NVM_HOME%\v%KORE_NODE_VERSION%\node.exe" (
  set "PATH=%NVM_HOME%\v%KORE_NODE_VERSION%;%PATH%"
  goto :run
)

REM --- 3) WorkBuddy-managed Node ---------------------------------------------
REM  Prefer the "current" pointer; otherwise take the newest version directory.
set "WB_NODE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe" (
  set "WB_NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\current"
)
if not defined WB_NODE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions" (
  for /f "delims=" %%d in ('dir /b /ad /o-d "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do (
    if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%d\node.exe" (
      set "WB_NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\%%d"
      goto :wb_found
    )
  )
)
:wb_found
if defined WB_NODE (
  echo [dev] using WorkBuddy-managed Node: %WB_NODE%
  set "PATH=%WB_NODE%;%PATH%"
  goto :run
)

REM --- 4) Fallback: whatever Node is already on PATH -------------------------
REM  check-node.mjs rejects Node < 18 with a clear message, so no extra check.
for /f "delims=" %%v in ('node -v 2^>nul') do echo [dev] using Node %%v from PATH

:run
where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo [dev] ERROR: npm was not found on PATH and this launcher could not
  echo        select a usable Node. Install Node.js 18 or newer, or make a
  echo        version manager (fnm / nvm-windows) available.
  pause
  exit /b 1
)

call npm run dev -- %*
set "RC=%errorlevel%"
if %RC% neq 0 (
  echo.
  echo [dev] dev server exited with code %RC%. See the error message above.
  echo If it mentions Node 18 or newer, this launcher could not find a
  echo suitable Node - install Node ^>= 18 or use a version manager.
  pause
)
exit /b %RC%
