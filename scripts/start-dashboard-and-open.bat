@echo off
setlocal
title EduCon Pipeline Dashboard

REM Port can be overridden:  start-dashboard-and-open.bat 3007
set "PORT=%~1"
if "%PORT%"=="" set "PORT=3007"

cd /d "%~dp0.."

echo.
echo   EduCon Student Status Dashboard
echo   Starting on port %PORT% ...
echo.

if not exist node_modules (
  echo   Installing dependencies ^(first run^)...
  call npm install
)

start "" http://localhost:%PORT%/
node backend\server.js

endlocal