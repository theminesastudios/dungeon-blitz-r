@echo off
setlocal enabledelayedexpansion

title Dungeon Blitz (local dev server)

REM Switch to repo root (directory of this script)
cd /d "%~dp0"

echo Dungeon Blitz (local dev server)
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not on PATH.
  echo Install Node.js (LTS) then re-run this file.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm is not installed or not on PATH.
  echo Reinstall Node.js (LTS) then re-run this file.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
for /f "delims=" %%v in ('npm -v') do set NPM_VER=%%v
echo Node: %NODE_VER%
echo npm:  %NPM_VER%
echo.

if not exist "node_modules\" (
  echo Installing root dependencies...
  call npm install
  if errorlevel 1 goto :fail
  echo.
) else (
  echo Root dependencies already installed; skipping.
  echo.
)

if not exist "src\server\node_modules\" (
  echo Installing server dependencies...
  pushd "src\server"
  call npm install
  if errorlevel 1 (
    popd
    goto :fail
  )
  popd
  echo.
) else (
  echo Server dependencies already installed; skipping.
  echo.
)

echo Starting server (npm run dev)...
echo When it's ready, open the URL shown in the logs.
echo.
call npm run dev
set EXIT_CODE=%errorlevel%

echo.
echo Server exited with code %EXIT_CODE%
pause
exit /b %EXIT_CODE%

:fail
echo.
echo ERROR: Command failed.
pause
exit /b 1
