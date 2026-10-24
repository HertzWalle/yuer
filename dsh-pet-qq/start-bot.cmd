@echo off
chcp 65001 >nul
title dsh-pet QQ bot
cd /d "%~dp0"

echo ============================================
echo   dsh-pet 人格 + QQ 桥
echo ============================================
echo.

echo [1/3] 检查 dsh-pet 桌面端 ...
node -e "fetch('http://127.0.0.1:2627/dsh-pet-7340/state',{signal:AbortSignal.timeout(4000)}).then(r=>{console.log(r.ok?'  dsh-pet OK':'  dsh-pet 返回 '+r.status);process.exit(r.ok?0:1)}).catch(e=>{console.log('  dsh-pet 没在跑：'+e.message);process.exit(1)})"
if errorlevel 1 (
  echo.
  echo   请先打开 DSH 桌面端（桌宠在跑），再运行本脚本。
  pause
  exit /b 1
)

echo.
echo [2/3] 启动 NapCat（需要管理员权限，会弹一次 UAC，请点「是」）...
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0napcat\start-napcat.bat' -Verb RunAs"
echo      等待 OneBot 端口 127.0.0.1:3001 ...
node -e "const net=require('net');const t0=Date.now();const tick=()=>{const s=net.connect(3001,'127.0.0.1');s.on('connect',()=>{console.log('  OneBot 就绪');s.destroy();process.exit(0)});s.on('error',()=>{s.destroy();if(Date.now()-t0>180000){console.log('  等待超时：NapCat 可能还停在扫码界面，看 napcat\logs\napcat-console.log');process.exit(1)}setTimeout(tick,3000)})};tick()"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

echo.
echo [3/3] 启动 QQ 桥（Ctrl+C 停止）...
echo.
node qq-bridge.mjs

echo.
echo 桥已退出。
pause
