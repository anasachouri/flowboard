@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it free from https://nodejs.org then run this again.
  pause
  exit /b 1
)
node flowboard-server.js
pause
