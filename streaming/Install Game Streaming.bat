@echo off
setlocal
title Install Game Streaming
echo ============================================
echo   Liria's Arcade: install game streaming
echo ============================================
echo.
echo  This installs Sunshine, the free game-streaming program that sends
echo  the arcade's picture and sound to Moonlight on the living-room Mac,
echo  and the Mac's controller back to this PC.
echo.
echo  Windows will ask for permission to install it: press Yes.
echo  If the installer shows options, keep "Virtual Gamepad" (ViGEmBus)
echo  ticked: that is the driver that makes the Mac's controller work here.
echo.
where winget >nul 2>&1
if errorlevel 1 (
  echo  winget was not found. Install "App Installer" from the Microsoft Store,
  echo  or download Sunshine from https://app.lizardbyte.dev/Sunshine/
  goto end
)
pause
winget install --id LizardByte.Sunshine -e --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo.
  echo  winget reported a problem (or Sunshine was already installed^). See above.
  goto end
)
echo.
echo  Sunshine is installed. Next:
echo   1. Open https://localhost:47990 in Chrome. Chrome warns the page is not
echo      private (Sunshine makes its own certificate^): click Advanced, then
echo      Proceed to localhost.
echo   2. Choose a Sunshine username and password yourself and keep them safe.
echo   3. Run "Add Arcade To Sunshine.bat" in this folder.
echo  The full steps are in docs\living-room-arcade.md.

:end
echo.
pause
