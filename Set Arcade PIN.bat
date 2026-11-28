@echo off
setlocal
title Set Arcade PIN
cd /d "%~dp0"

echo ============================================
echo   Liria's Arcade: the Living Room page
echo ============================================
echo.
echo  Another device on your home network (the Mac in the living room)
echo  can open the arcade's Living Room page after typing an Arcade PIN once.
echo  The page only shows the arcade's status and the Moonlight steps:
echo  games are streamed by Sunshine and Moonlight (see the streaming folder).
echo  This PC never needs the PIN, and the arcade on this PC does not change.
echo.
node frontend\tools\set-pin.js status
echo.
echo   1 = Set or change the Arcade PIN (turns the Living Room page ON)
echo   2 = Turn the Living Room page OFF
echo   3 = Cancel
echo.
choice /c 123 /n /m "Choose 1, 2 or 3: "
if errorlevel 3 goto cancel
if errorlevel 2 goto turn_off

echo.
node frontend\tools\set-pin.js set
if errorlevel 1 goto failed
echo.
echo  Next, Windows Firewall has to let the Mac in (home network only).
echo  Windows will ask for permission: press Yes.
echo.
pause
call "%~dp0Allow Arcade On Home Network.bat"
echo.
echo  Last step: if the arcade is running, press EXIT in the arcade on this PC
echo  and open Liria's Arcade again. Then on the Mac, open and bookmark:
echo.
echo      http://lirias-arcade.local:6969
goto end

:turn_off
echo.
node frontend\tools\set-pin.js off
echo.
echo  The Mac is refused straight away. Windows will now ask for permission
echo  to remove the firewall rules: press Yes.
echo.
pause
call "%~dp0Allow Arcade On Home Network.bat" remove
goto end

:cancel
echo.
echo  Nothing was changed.
goto end

:failed
echo.
echo  The PIN was not changed.

:end
echo.
pause
