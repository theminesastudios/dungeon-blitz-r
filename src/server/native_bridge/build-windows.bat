@echo off
setlocal

pushd "%~dp0"

where cmake >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: CMake is required to build the Discord Social SDK bridge.
    echo Install CMake with Visual Studio C++ build tools, then re-run this file.
    set EXIT_CODE=1
    goto done
)

cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
if %errorlevel% neq 0 (
    set EXIT_CODE=%errorlevel%
    goto done
)

cmake --build build --config Release
if %errorlevel% neq 0 (
    set EXIT_CODE=%errorlevel%
    goto done
)

if not exist "build\discord_social_bridge.exe" (
    echo ERROR: Native bridge executable was not created at build\discord_social_bridge.exe
    set EXIT_CODE=1
    goto done
)

echo Built: %CD%\build\discord_social_bridge.exe
set EXIT_CODE=0

:done
popd
exit /b %EXIT_CODE%
