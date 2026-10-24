#!/usr/bin/env bash
set -uo pipefail
APP_DIR=/opt/dsh-pet
APP_USER=dshpet
echo "== 解压 =="
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
tar -xzf /tmp/dist.tar.gz -C "$APP_DIR"
echo "== 环境文件 =="
install -m 600 -o "$APP_USER" -g "$APP_USER" /tmp/bot.env "$APP_DIR/.env"
mkdir -p "$APP_DIR/data/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
echo "== systemd =="
install -m 644 "$APP_DIR/systemd/dsh-pet-bot.service" /etc/systemd/system/dsh-pet-bot.service
systemctl daemon-reload
echo "== NapCat 配置目录 =="
mkdir -p /opt/napcat/config
if [ ! -f /opt/napcat/config/onebot11.json ]; then
cat > /opt/napcat/config/onebot11.json <<'JSON'
{
  "network": {
    "httpServers": [],
    "httpClients": [],
    "websocketServers": [
      {
        "name": "dsh-pet-bridge",
        "enable": true,
        "host": "0.0.0.0",
        "port": 3001,
        "enableForcePushEvent": true,
        "reportSelfMessage": false,
        "messagePostFormat": "array",
        "token": "",
        "debug": false,
        "heartInterval": 30000
      }
    ],
    "websocketClients": []
  },
  "musicSignUrl": "",
  "enableLocalFile2Url": false,
  "parseMultMsg": false
}
JSON
fi
echo "== 文件清单 =="
ls "$APP_DIR"
echo "== node =="
/usr/local/bin/node -v
