@echo off
rem 一键打开云端控制台（建隧道 + 开浏览器）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-panel.ps1" %*
if errorlevel 1 pause
