@echo off
setlocal
cd /d "%~dp0"
rem Opens the QQ group briefing. The console itself runs hidden in the background;
rem this window closes as soon as the browser opens.
set "NODE_EXE=node"
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
if /i "%NODE_EXE%"=="node" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js was not found. Install Node.js 20 or newer from https://nodejs.org and try again.
    pause
    exit /b 1
  )
)
if not exist "%~dp0node_modules\better-sqlite3-multiple-ciphers" (
  echo First run: installing dependencies with npm install, this can take a minute...
  call npm install
  if errorlevel 1 (
    echo npm install failed. Check your network connection and try again.
    pause
    exit /b 1
  )
)
"%NODE_EXE%" "%~dp0src\launcher.js" %*
if errorlevel 1 pause
