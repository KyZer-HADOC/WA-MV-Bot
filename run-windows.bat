@echo off
setlocal
cd /d "%~dp0"
title WA-MV-Bot

echo ========================================
echo          WA-MV-Bot - Windows
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed.
  echo Install Node.js 20 or newer from https://nodejs.org/
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set NODE_MAJOR=%%V
if not defined NODE_MAJOR (
  echo ERROR: Could not detect the Node.js version.
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 20 (
  echo ERROR: Node.js 20 or newer is required. Detected version:
  node --version
  pause
  exit /b 1
)

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo Created .env from .env.example.
  echo Add the request and destination group JIDs in Notepad.
  echo If you do not know the JIDs yet, leave them blank for now.
  notepad ".env"
)

if not exist "node_modules" (
  echo Installing bot dependencies. This may take a while on first run...
  call npm install
  if errorlevel 1 goto :failed
)

echo.
echo Starting WA-MV-Bot. Keep this window open while the bot runs.
echo Press Ctrl+C to stop it.
echo.
call npm start
echo.
echo Bot process stopped.
pause
exit /b 0

:failed
echo.
echo Setup failed. Check the error above and make sure internet access is working.
pause
exit /b 1
