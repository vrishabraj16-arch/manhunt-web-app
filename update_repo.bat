@echo off
title GitHub Repository Updater - MANHUNT
cd /d "%~dp0"

:: Ensure Git and GitHub CLI are in PATH
set "PATH=C:\Users\VRISHAB RAJ\AppData\Local\Programs\MinGit\cmd;C:\Users\VRISHAB RAJ\AppData\Local\Programs\gh;%PATH%"

echo ========================================================
echo       MANHUNT - 1-CLICK GITHUB REPO UPDATER
echo ========================================================
echo.

:: 1. Verify Git
git --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git could not be located.
    pause
    exit /b 1
)

:: 2. Check for changes and commit
echo [1/3] Checking for modified or new files...
git status --porcelain > "%temp%\git_status.tmp"
for %%A in ("%temp%\git_status.tmp") do if %%~zA GTR 0 (
    echo Changes detected. Staging and committing...
    git add -A
    git commit -m "Update MANHUNT web app files"
) else (
    echo No new local unstaged changes. Proceeding with sync...
)
del "%temp%\git_status.tmp" >nul 2>&1

:: 3. Push to GitHub
echo.
echo [2/3] Pushing updates to GitHub (main branch)...
git push origin main
if errorlevel 1 (
    echo.
    echo [ERROR] Push failed. Checking GitHub authentication...
    gh auth status >nul 2>&1
    if errorlevel 1 (
        echo Logging in with GitHub...
        gh auth login --web -h github.com -p https -s repo
        git push origin main
    )
)

:: 4. Open GitHub repo
echo.
echo [3/3] Opening your GitHub repository in your web browser...
gh browse

echo.
echo ========================================================
echo   SUCCESS! Your repository on GitHub is now up to date!
echo ========================================================
echo.
pause
