@echo off
setlocal enabledelayedexpansion

pushd "%~dp0"

where cmake >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: CMake is required to build the Discord Social SDK bridge.
    echo Install CMake with Visual Studio C++ build tools, then re-run this file.
    set EXIT_CODE=1
    goto done
)

set CMAKE_GENERATOR_ARGS=
set EXPECTED_GENERATOR=
set CMAKE_BUILD_ARGS=--config Release

where ninja >nul 2>nul
if %errorlevel% equ 0 (
    set CMAKE_GENERATOR_ARGS=-G "Ninja"
    set EXPECTED_GENERATOR=Ninja
    set CMAKE_BUILD_ARGS=
) else (
    where msbuild >nul 2>nul
    if !errorlevel! equ 0 (
        set CMAKE_GENERATOR_ARGS=-G "Visual Studio 17 2022"
        set EXPECTED_GENERATOR=Visual Studio 17 2022
    ) else (
        where devenv >nul 2>nul
        if !errorlevel! equ 0 (
            set CMAKE_GENERATOR_ARGS=-G "Visual Studio 17 2022"
            set EXPECTED_GENERATOR=Visual Studio 17 2022
        ) else (
            where nmake >nul 2>nul
            if !errorlevel! equ 0 (
                set CMAKE_GENERATOR_ARGS=-G "NMake Makefiles"
                set EXPECTED_GENERATOR=NMake Makefiles
                set CMAKE_BUILD_ARGS=
            ) else (
                echo ERROR: A Windows C++ build tool is required to build the Discord Social SDK bridge.
                echo Install Visual Studio C++ Build Tools or Ninja, then re-run this file.
                set EXIT_CODE=1
                goto done
            )
        )
    )
)

if exist "build\CMakeCache.txt" (
    findstr /c:"CMAKE_GENERATOR:INTERNAL=!EXPECTED_GENERATOR!" "build\CMakeCache.txt" >nul 2>nul
    if !errorlevel! neq 0 (
        echo Reconfiguring native bridge build directory for !EXPECTED_GENERATOR!...
        if exist "build\CMakeCache.txt" del /f /q "build\CMakeCache.txt"
        if exist "build\CMakeFiles" rmdir /s /q "build\CMakeFiles"
    )
)

cmake -S . -B build !CMAKE_GENERATOR_ARGS! -DCMAKE_BUILD_TYPE=Release
if %errorlevel% neq 0 (
    set EXIT_CODE=%errorlevel%
    goto done
)

cmake --build build !CMAKE_BUILD_ARGS!
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
