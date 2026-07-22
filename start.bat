@echo off
cd /d "%~dp0"
title Remote Photo Slides
powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) { exit 10 }"
if %errorlevel% equ 10 exit /b 0
npm start
pause

