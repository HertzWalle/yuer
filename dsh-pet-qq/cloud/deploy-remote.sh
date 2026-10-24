#!/usr/bin/env bash
# 在服务器上执行：安装 Node 22 + 用户 + systemd 服务，解压 dist.zip 到 /opt/dsh-pet
# 用法（本机）：bash cloud/deploy-remote.sh   →  内部用 ssh 执行本文件
# 前提：服务器已放好 /tmp/dist.zip 与 /tmp/bot.env
set -euo pipefail

APP_DIR=/opt/dsh-pet
APP_USER=dshpet
NODE_VER=${NODE_VER:-v22.13.0}
NODE_MIRROR=${NODE_MIRROR:-https://registry.npmmirror.com/-/binary/node}

log() { printf '\n=== %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then echo "需要 root" >&2; exit 1; fi

log "基础包"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates unzip xz-utils tzdata >/dev/null

log "Node ${NODE_VER}"
if ! command -v node >/dev/null || [[ "$(node -v)" != "${NODE_VER%%.*}"* ]]; then
  cd /tmp
  if [[ ! -f node.tar.xz ]]; then
    curl -fsSL --retry 3 -o node.tar.xz "${NODE_MIRROR}/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz"
  fi
  rm -rf "/usr/local/lib/node-${NODE_VER}-linux-x64"
  tar -xJf node.tar.xz -C /usr/local/lib
  for b in node npm npx; do ln -sf "/usr/local/lib/node-${NODE_VER}-linux-x64/bin/$b" "/usr/local/bin/$b"; done
fi
node -v && npm -v

log "用户与目录"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -r -m -d "/home/$APP_USER" -s /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
if [[ ! -f /tmp/dist.zip ]]; then echo "缺少 /tmp/dist.zip" >&2; exit 1; fi
unzip -oq /tmp/dist.zip -d "$APP_DIR"
mkdir -p "$APP_DIR/data" "$APP_DIR/data/backups"

log "环境变量文件"
if [[ -f /tmp/bot.env ]]; then
  install -m 600 -o "$APP_USER" -g "$APP_USER" /tmp/bot.env "$APP_DIR/.env"
  rm -f /tmp/bot.env
else
  echo "缺少 /tmp/bot.env" >&2; exit 1
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 700 "$APP_DIR/.env"

log "systemd"
install -m 644 "$APP_DIR/systemd/dsh-pet-bot.service" /etc/systemd/system/dsh-pet-bot.service
systemctl daemon-reload
systemctl enable dsh-pet-bot >/dev/null 2>&1 || true

log "完成。服务还没启动 —— 先确认 NapCat 已在 127.0.0.1:3001 起好，再 systemctl start dsh-pet-bot"
ls -la "$APP_DIR" | head -20
