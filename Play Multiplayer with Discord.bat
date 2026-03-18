@echo off
set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"
node src\server\tools\launchMultiplayerClient.js
