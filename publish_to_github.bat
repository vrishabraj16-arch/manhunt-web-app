@echo off
title GitHub Setup & Auto-Publisher - MANHUNT
cd /d "%~dp0"

:: Ensure Git and GitHub CLI are in PATH
set "PATH=C:\Users\VRISHAB RAJ\AppData\Local\Programs\MinGit\cmd;C:\Users\VRISHAB RAJ\AppData\Local\Programs\gh;%PATH%"

echo ========================================================
echo       MANHUNT - AUTOMATIC GITHUB REPOSITORY CREATOR
echo ========================================================
echo.

:: 1. Verify Git
git --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git could not be located.
    pause
    exit /b 1
)

:: 2. Check GitHub Authentication
echo [1/3] Checking GitHub authentication status...
gh auth status >nul 2>&1
if errorlevel 1 (
    echo.
    echo You are not logged in yet.
    echo Opening browser to log in with GitHub...
    echo (You will be prompted to enter a one-time code shown in this terminal)
    echo.
    gh auth login --web -h github.com -p https -s repo
    if errorlevel 1 (
        echo.
        echo [ERROR] GitHub authentication failed or was cancelled.
        pause
        exit /b 1
    )
) else (
    echo Authenticated successfully!
)

echo.
echo [2/3] Creating repository on your GitHub account and pushing code...

:: Ensure branch is main
git branch -M main

:: Check if remote origin already exists
git remote get-url origin >nul 2>&1
if errorlevel 1 (
    gh repo create manhunt-web-app --public --source=. --remote=origin --push
) else (
    git push -u origin main
)

if errorlevel 1 (
    echo.
    echo [INFO] Attempting push to remote origin...
    git push -u origin main
)

echo.
echo [3/3] Opening your repository on GitHub in your browser...
gh browse

echo.
echo ========================================================
echo    SUCCESS! Your repository is now live on GitHub!
echo ========================================================
echo.
pause
