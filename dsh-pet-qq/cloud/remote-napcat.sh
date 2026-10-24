#!/usr/bin/env bash
set -uo pipefail
echo "== 清理旧容器 =="
sudo docker rm -f napcat >/dev/null 2>&1 || true
mkdir -p /opt/napcat/config /opt/napcat/cache /opt/napcat/logs /opt/napcat/qq
sudo chown -R 0:0 /opt/napcat
echo "== 启动 =="
sudo docker run -d --name napcat --restart=always \
  -e ACCOUNT=2536561711 \
  -e WEBUI_TOKEN=dshpet-napcat-2026 \
  -e NAPCAT_UID=0 -e NAPCAT_GID=0 \
  -e TZ=Asia/Shanghai \
  -p 127.0.0.1:3001:3001 -p 127.0.0.1:6099:6099 \
  -v /opt/napcat/config:/app/napcat/config \
  -v /opt/napcat/cache:/app/napcat/cache \
  -v /opt/napcat/logs:/app/napcat/logs \
  mlikiowa/napcat-docker:latest
sleep 30
echo "== ps =="
sudo docker ps --format '{{.Names}} {{.Status}} {{.Ports}}'
echo "== logs tail =="
sudo docker logs --tail 40 napcat 2>&1 | tail -40
echo "== config dir =="
sudo ls -la /opt/napcat/config
echo "== cache =="
sudo ls -la /opt/napcat/cache | head
