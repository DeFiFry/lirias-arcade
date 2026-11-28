@echo off
rem Windows Firewall rules for Liria's Arcade's home network mode: TCP 6969
rem (the Living Room page; the arcade's own port 8080 is never opened) and UDP
rem 5353 (the lirias-arcade.local name), inbound, for Node.js only, on the
rem PRIVATE network profile only. "remove" deletes them. Their names are the
rem arcade's own, so Liria Cinema's and Playlist Liria's rules are never
rem touched. Needs admin (asks once). Run by "Set Arcade PIN.bat".
title Allow Arcade On Home Network
net session >nul 2>&1
if errorlevel 1 (
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -Wait"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -Verb RunAs -Wait"
  )
  exit /b
)
color 07
if /i "%~1"=="remove" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0frontend\tools\lan-firewall.ps1" -Remove
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0frontend\tools\lan-firewall.ps1"
)
if errorlevel 1 (
  color 4F
  echo.
  echo  FIREWALL NOT CHANGED - see the message above.
) else (
  color 2F
  echo.
  echo  FIREWALL DONE.
)
echo.
pause
