@echo off
title MANHUNT Web App Server
cd /d "%~dp0"
echo ========================================================
echo               MANHUNT WEB APP RUNNER
echo ========================================================
echo.
echo Starting web app on http://localhost:3000 ...
start http://localhost:3000
npm start
pause
