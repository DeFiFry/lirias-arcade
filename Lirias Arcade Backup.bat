@echo off
echo ========================================
echo   Lirias Arcade - Auto GitHub Backup
echo ========================================
echo.

cd /d E:\Projects\Lirias-Arcade

echo Checking for changes...
git status

echo.
echo Adding all changes...
git add .

echo.
set /p commit_msg="Enter commit message (or press Enter for default): "

if "%commit_msg%"=="" (
    set commit_msg=Auto-backup Lirias Arcade
)

echo.
echo Committing with message: "%commit_msg%"
git commit -m "%commit_msg%"

echo.
echo Pushing to GitHub...
git push

echo.
echo ========================================
echo   Backup Complete!
echo ========================================
echo.
pause
