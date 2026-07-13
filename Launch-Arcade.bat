@echo off
cd /d "%~dp0\frontend"

echo ============================================
echo   Liria's Arcade
echo ============================================
echo.

if exist "node_modules" goto start_server

echo Installing dependencies (first run only)...
call npm install
if errorlevel 1 goto install_failed
echo.

:start_server
echo Starting the arcade server in the background...
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%cd%' -WindowStyle Hidden"

set /a tries=0

:wait_loop
set /a tries+=1
curl -s -o nul -m 1 http://localhost:8080/api/games
if not errorlevel 1 goto server_up
if %tries% GEQ 20 goto server_timeout
ping -n 2 127.0.0.1 >nul
goto wait_loop

:server_up
echo Server confirmed running at http://localhost:8080
start "" http://localhost:8080
echo The arcade is now running in the background. This window will close shortly.
ping -n 3 127.0.0.1 >nul
exit /b 0

:server_timeout
echo.
echo WARNING: Server did not respond after %tries% seconds.
echo Check that node/npm are installed correctly and try again.
echo.
pause
exit /b 1

:install_failed
echo.
echo ERROR: npm install failed. See the error above.
echo.
pause
exit /b 1
