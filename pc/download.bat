@echo off
rem appMoove downloader. Double-click this file (or the desktop shortcut).
rem (ASCII only on purpose: cmd.exe misreads UTF-8 text in .bat files.)
setlocal
title appMoove downloader
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0download.ps1" %*
if errorlevel 2 pause
endlocal
