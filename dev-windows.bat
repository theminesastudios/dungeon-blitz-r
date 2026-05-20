@echo off
setlocal enabledelayedexpansion

:: Script'in bulundugu klasore git
cd /d "%~dp0"

echo Dungeon Blitz ^(local dev server^)
echo.

:: Node kontrol
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not on PATH.
    echo Install Node.js ^(LTS^) then re-run this file.
    echo.
    pause
    exit /b 1
)

:: npm kontrol
where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: npm is not installed or not on PATH.
    echo Reinstall Node.js ^(LTS^) then re-run this file.
    echo.
    pause
    exit /b 1
)

:: Versiyonlar
echo Node:
node -v
echo npm:
call npm -v
echo.

:: Root dependencies
if not exist node_modules (
    echo Installing root dependencies...
    call npm install
    echo.
) else (
    echo Root dependencies already installed; skipping.
    echo.
)

:: Server dependencies
if not exist src\server\node_modules (
    echo Installing server dependencies...
    cd src\server
    call npm install
    cd /d "%~dp0"
    echo.
) else (
    echo Server dependencies already installed; skipping.
    echo.
)

echo Building Discord Social SDK native bridge...
call src\server\native_bridge\build-windows.bat
set BRIDGE_BUILD_CODE=%errorlevel%
cd /d "%~dp0"
if %BRIDGE_BUILD_CODE% neq 0 (
    echo.
    echo ERROR: Discord Social SDK native bridge build failed.
    pause
    exit /b %BRIDGE_BUILD_CODE%
)
echo.

if not defined DISCORD_SOCIAL_BRIDGE_ENABLED set DISCORD_SOCIAL_BRIDGE_ENABLED=true
if not defined DISCORD_SOCIAL_BRIDGE_EXECUTABLE set DISCORD_SOCIAL_BRIDGE_EXECUTABLE=%CD%\src\server\native_bridge\build\discord_social_bridge.exe

:: SERVER BASLAT
echo Starting server with Discord RPC ^(npm run dev:discord^)^...
echo Discord Social SDK bridge: %DISCORD_SOCIAL_BRIDGE_EXECUTABLE%
echo When it's ready, open the URL shown in the logs.
echo.

call npm run dev:discord
set EXIT_CODE=%errorlevel%

echo.
echo Server exited with code %EXIT_CODE%
pause
exit /b %EXIT_CODE%
