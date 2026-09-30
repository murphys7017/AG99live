@echo off
setlocal

cd /d "%~dp0frontend"

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found. Install Node.js LTS and try again.
  pause
  exit /b 1
)

echo [1/2] Installing frontend dependencies...
call npm ci
if errorlevel 1 (
  echo [ERROR] npm ci failed.
  pause
  exit /b 1
)

echo [2/2] Building the Windows installer...
call npm run package:win
if errorlevel 1 (
  echo [ERROR] Installer build failed.
  pause
  exit /b 1
)

echo.
echo Installer created in:
echo %CD%\release
start "" explorer.exe "%CD%\release"
pause
