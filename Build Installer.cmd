@echo off
rem Double-click to build dist\Nyx-Setup-<version>.exe
cd /d "%~dp0"
call npx.cmd electron-builder --win nsis
echo.
if errorlevel 1 (echo Build FAILED - see messages above.) else (echo Done. Installer is in the dist folder.& start "" "%~dp0dist")
pause
