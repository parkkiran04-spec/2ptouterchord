@echo off
rem xgradation: start the server, then open the main page
cd /d "%~dp0"
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8765/"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
pause
