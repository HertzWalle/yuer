#!/usr/bin/env bash
set -uo pipefail
echo "== docker state =="
sudo systemctl is-active docker
sudo docker version --format '{{.Server.Version}}' || true
echo "== group =="
sudo usermod -aG docker ubuntu || true
echo "== pull =="
sudo docker pull mlikiowa/napcat-docker:latest
echo "== image =="
sudo docker image ls mlikiowa/napcat-docker
sudo docker image inspect mlikiowa/napcat-docker:latest --format 'ENTRYPOINT={{json .Config.Entrypoint}} CMD={{json .Config.Cmd}} ENV={{json .Config.Env}}'
