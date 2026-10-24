#!/bin/sh
# v1.5.0：引用回复（入站解析 reply 段 + 出站带引用）
# 用法：scp dist.tar.gz 到 /tmp/dist.tgz 后 `sudo bash /tmp/remote-deploy-v7.sh`
set -e

APP=/opt/dsh-pet
echo "= 解包代码（不含 data/、logs/）"
sudo tar -xzf /tmp/dist.tgz -C "$APP"

echo "= bridge.config.json 加 behavior.quoteReply=auto（不动其它已调过的值）"
sudo node -e '
const fs = require("fs");
const p = "/opt/dsh-pet/bridge.config.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.behavior = c.behavior || {};
if (!c.behavior.quoteReply) c.behavior.quoteReply = "auto";
fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n", "utf8");
console.log("quoteReply =", c.behavior.quoteReply, "| maxBubbles =", c.behavior.maxBubbles, "| tailPauseMs =", c.behavior.tailPauseMs);
'

echo "= 权限"
sudo chown -R dshpet:dshpet "$APP/lib" "$APP"/*.mjs "$APP/personas.json" "$APP/data" 2>/dev/null || true

echo "= 重启服务"
sudo systemctl restart dsh-pet-bot
sleep 3

echo "= 代码检查"
echo -n "shouldQuote: "; sudo grep -c 'shouldQuote' "$APP/qq-bridge.mjs"
echo -n "segmentsToPlain: "; sudo grep -c 'segmentsToPlain' "$APP/qq-bridge.mjs"
echo -n "quoteOf: "; sudo grep -c 'quoteOf' "$APP/qq-bridge.mjs"
echo -n "call: (action"; sudo grep -c 'call: (action' "$APP/qq-bridge.mjs"

echo "= 服务状态"
systemctl is-active dsh-pet-bot
sudo journalctl -u dsh-pet-bot -n 6 --no-pager | tail -6
