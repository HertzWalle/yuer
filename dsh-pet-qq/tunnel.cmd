@echo off
cd /d "%~dp0"
title yuer tunnel (keep open)
echo Tunnel to Letta: keep this window open.
:loop
ssh -F /dev/null -N -R 127.0.0.1:8283:127.0.0.1:8283 -i ".ssh\server.pem" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=".ssh\known_hosts" -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes ubuntu@124.220.183.169
echo Tunnel dropped, retry in 5s...
timeout /t 5 >nul
goto loop
