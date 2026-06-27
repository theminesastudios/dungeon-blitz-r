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
if not exist node_modules\.bin\concurrently.cmd (
    echo Installing root dependencies...
    call npm install --include=dev
    if !errorlevel! neq 0 (
        echo.
        echo ERROR: Root dependency install failed.
        pause
        exit /b !errorlevel!
    )
    echo.
) else (
    echo Root dependencies already installed; skipping.
    echo.
)

:: Server dependencies
if not exist src\server\node_modules\.bin\nodemon.cmd (
    echo Installing server dependencies...
    cd src\server
    call npm install --include=dev
    if !errorlevel! neq 0 (
        cd /d "%~dp0"
        echo.
        echo ERROR: Server dependency install failed.
        pause
        exit /b !errorlevel!
    )
    cd /d "%~dp0"
    echo.
) else (
    echo Server dependencies already installed; skipping.
    echo.
)

set BRIDGE_DIR=%CD%\src\server\native_bridge
set BRIDGE_SDK_DIR=%BRIDGE_DIR%\discord_social_sdk
set BRIDGE_EXECUTABLE=%BRIDGE_DIR%\build\discord_social_bridge.exe
set BRIDGE_BUILD_READY=false
set BRIDGE_TOOLCHAIN_READY=false

where cmake >nul 2>nul
if %errorlevel% equ 0 (
    where ninja >nul 2>nul
    if !errorlevel! equ 0 set BRIDGE_TOOLCHAIN_READY=true
    where msbuild >nul 2>nul
    if !errorlevel! equ 0 set BRIDGE_TOOLCHAIN_READY=true
    where devenv >nul 2>nul
    if !errorlevel! equ 0 set BRIDGE_TOOLCHAIN_READY=true
    where nmake >nul 2>nul
    if !errorlevel! equ 0 set BRIDGE_TOOLCHAIN_READY=true
)

if exist "%BRIDGE_DIR%\build-windows.bat" if exist "%BRIDGE_SDK_DIR%" if "%BRIDGE_TOOLCHAIN_READY%"=="true" set BRIDGE_BUILD_READY=true

if "%BRIDGE_BUILD_READY%"=="true" (
    echo Building Discord Social SDK native bridge...
    call "%BRIDGE_DIR%\build-windows.bat"
    set BRIDGE_BUILD_CODE=!errorlevel!
    cd /d "%~dp0"
    if !BRIDGE_BUILD_CODE! neq 0 (
        echo.
        echo ERROR: Discord Social SDK native bridge build failed.
        pause
        exit /b !BRIDGE_BUILD_CODE!
    )
    echo.
) else if exist "%BRIDGE_SDK_DIR%" if "%BRIDGE_TOOLCHAIN_READY%"=="false" if exist "%BRIDGE_EXECUTABLE%" (
    echo Discord Social SDK C++ build tools were not found; reusing existing native bridge build.
    echo Install Visual Studio C++ Build Tools or Ninja to rebuild the optional bridge.
    echo.
) else if exist "%BRIDGE_SDK_DIR%" if "%BRIDGE_TOOLCHAIN_READY%"=="false" (
    echo Discord Social SDK C++ build tools were not found; skipping optional native bridge build.
    echo Install Visual Studio C++ Build Tools or Ninja to enable the optional bridge.
    echo.
) else if exist "%BRIDGE_EXECUTABLE%" (
    echo Discord Social SDK folder not installed; reusing existing native bridge build.
    echo.
) else (
    echo Discord Social SDK native bridge is not installed; skipping native bridge build.
    echo Run npm run install:discord-social-sdk to install the optional SDK files.
    echo.
)

if not defined DISCORD_SOCIAL_BRIDGE_EXECUTABLE set DISCORD_SOCIAL_BRIDGE_EXECUTABLE=%BRIDGE_EXECUTABLE%

if exist "%DISCORD_SOCIAL_BRIDGE_EXECUTABLE%" (
    if not defined DISCORD_SOCIAL_BRIDGE_ENABLED set DISCORD_SOCIAL_BRIDGE_ENABLED=true
    if not defined DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED set DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED=true
    if not defined DISCORD_SOCIAL_CHAT_RELAY_MODE set DISCORD_SOCIAL_CHAT_RELAY_MODE=native
) else (
    set DISCORD_SOCIAL_BRIDGE_ENABLED=false
    set DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED=false
    set DISCORD_SOCIAL_CHAT_RELAY_MODE=off
)
set DISCORD_SOCIAL_APP_ID=1447954255452311695
set DISCORD_SOCIAL_DEVICE_FLOW=false
if not defined STATIC_PORT set "STATIC_PORT=8000"
if not defined FLASH_SWF_PATH set "FLASH_SWF_PATH=p/cbp/DungeonBlitz.swf"
if not defined FLASH_FILE_VERSION set "FLASH_FILE_VERSION=cbp"
if not defined FLASH_GAME_VERSION set "FLASH_GAME_VERSION=cbp"
if not defined FLASH_BROWSER_URL set "FLASH_BROWSER_URL=http://localhost:%STATIC_PORT%/"
set "FLASH_PLAYER_URL=!FLASH_BROWSER_URL!!FLASH_SWF_PATH!?fv=!FLASH_FILE_VERSION!^&gv=!FLASH_GAME_VERSION!"

:: SERVER BASLAT
echo Starting server with Discord RPC ^(npm run dev:discord^)^...
echo Discord channel bridge enabled: %DISCORD_SOCIAL_BRIDGE_ENABLED%
echo Discord Social SDK native bridge enabled: %DISCORD_SOCIAL_NATIVE_BRIDGE_ENABLED%
echo Discord chat relay mode: %DISCORD_SOCIAL_CHAT_RELAY_MODE%
echo Discord Social SDK app id: %DISCORD_SOCIAL_APP_ID%
echo Discord Social SDK device flow: %DISCORD_SOCIAL_DEVICE_FLOW%
echo Discord Social SDK bridge: %DISCORD_SOCIAL_BRIDGE_EXECUTABLE%
echo.

call node tools\runDevDiscordWithUrls.js
set EXIT_CODE=%errorlevel%

echo.
echo Server exited with code %EXIT_CODE%
pause
exit /b %EXIT_CODE%
