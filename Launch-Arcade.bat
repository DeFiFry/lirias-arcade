@echo off
setlocal
cd /d "%~dp0\frontend"

echo ============================================
echo   Liria's Arcade
echo ============================================
echo.

set "URL=http://localhost:8080"
rem The arcade's own Chrome profile (gitignored). Paul's normal Chrome profile is
rem never used, so the autoplay flag below always applies and the music starts
rem without a click.
set "PROFILE=%~dp0.chrome-app-arcade"

rem Already running? Just open the arcade window again (no second server).
curl -s -o nul -m 1 %URL%/api/games
if not errorlevel 1 goto server_up

rem Install/refresh dependencies on first run, and again whenever a newer
rem version adds one (pngjs is used for the arcade-cabinet side art).
if exist "node_modules\pngjs" goto start_server

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
curl -s -o nul -m 1 %URL%/api/games
if not errorlevel 1 goto server_up
if %tries% GEQ 20 goto server_timeout
ping -n 2 127.0.0.1 >nul
goto wait_loop

:server_up
echo Server confirmed running at %URL%
call :find_chrome
if defined CHROME (
  rem Full screen in its own app window, or the open one brought to the front (open-app-window.ps1).
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-app-window.ps1" -Chrome "%CHROME%" -Url %URL% -ProfileDir "%PROFILE%" -Autoplay
) else (
  echo Chrome not found: opening the default browser. The music starts after your first click there.
  start "" %URL%
)
echo The arcade is now running in the background. This window will close shortly.
ping -n 3 127.0.0.1 >nul
exit /b 0

:find_chrome
set "CHROME="
for %%P in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe") do (
  if not defined CHROME if exist "%%~P" set "CHROME=%%~P"
)
if defined CHROME exit /b 0
for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul ^| find "REG_SZ"') do set "CHROME=%%~B"
if defined CHROME if not exist "%CHROME%" set "CHROME="
if defined CHROME exit /b 0
for /f "tokens=2,*" %%A in ('reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul ^| find "REG_SZ"') do set "CHROME=%%~B"
if defined CHROME if not exist "%CHROME%" set "CHROME="
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
