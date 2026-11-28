@echo off
setlocal
title Add Arcade To Sunshine
rem Adds "Liria's Arcade" to Sunshine's app list (C:\Program Files\Sunshine\config\apps.json),
rem so Moonlight on the Mac can start the arcade. Backs the list up first and is safe
rem to run twice (sunshine-app.js). Needs admin (asks once), because the list lives
rem under Program Files. Then restarts Sunshine so it reads the new list.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -Wait"
  exit /b
)
cd /d "%~dp0"
color 07
echo ============================================
echo   Liria's Arcade: add it to Sunshine
echo ============================================
echo.
node "%~dp0sunshine-app.js" add
set "RESULT=%errorlevel%"
if "%RESULT%"=="10" goto done
if not "%RESULT%"=="0" goto failed
echo.
echo  Restarting Sunshine so it reads the new list (a stream that is open now would drop)...
powershell -NoProfile -Command "$s = Get-Service -Name SunshineService -ErrorAction SilentlyContinue; if ($s) { Restart-Service -Name SunshineService -Force; 'Sunshine restarted.' } else { 'Sunshine is not running as a service: close Sunshine from its tray icon and start it again.' }"
:done
color 2F
echo.
echo  DONE. In Moonlight on the Mac, "Liria's Arcade" is now in the PC's list.
goto end
:failed
color 4F
echo.
echo  NOT CHANGED - see the message above.
:end
echo.
pause
