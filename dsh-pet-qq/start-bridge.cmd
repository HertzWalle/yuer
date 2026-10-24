@echo off
chcp 65001 >nul
title dsh-pet QQ bridge
cd /d "%~dp0"
node qq-bridge.mjs
pause
