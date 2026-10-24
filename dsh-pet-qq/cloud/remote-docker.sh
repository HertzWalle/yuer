#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
echo "== apt install docker =="
sudo apt-get update -qq
sudo apt-get install -y -qq docker.io >/dev/null
sudo systemctl enable --now docker
echo "== daemon.json =="
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{
  "registry-mirrors": ["https://mirror.ccs.tencentyun.com", "https://docker.m.daocloud.io"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
sudo systemctl restart docker
sleep 2
docker version --format '{{.Server.Version}}'
echo "== pull napcat =="
sudo docker pull mlikiowa/napcat-docker:latest
echo "== image =="
sudo docker image inspect mlikiowa/napcat-docker:latest --format '{{.Id}} {{.Config.Cmd}}' || true
