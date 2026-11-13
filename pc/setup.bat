@echo off
rem appMoove downloader - first-time setup. Double-click this file.
rem (ASCII only on purpose: cmd.exe misreads UTF-8 text in .bat files.)
setlocal
title appMoove downloader - setup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
if errorlevel 2 pause
endlocal
