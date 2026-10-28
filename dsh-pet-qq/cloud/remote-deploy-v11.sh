#!/usr/bin/env bash
# v1.13.0 部署：解包代码 → 合并气泡参数 → 重启 → 自检
set -euo pipefail

APP=/opt/dsh-pet
PKG=/tmp/dist.tgz
[ -f "$PKG" ] || { echo "找不到 $PKG"; exit 1; }

echo "== 1. 解包代码（保留 data/ 与 logs/）"
tar -xzf "$PKG" -C "$APP"

echo "== 2. 合并配置"
node - <<'NODE'
const fs = require('node:fs');

const pp = '/opt/dsh-pet/data/pet.json';
const c = JSON.parse(fs.readFileSync(pp, 'utf8'));
c.maxBubbles = 3;
c.splitChance = 0.35;
fs.writeFileSync(pp, JSON.stringify(c, null, 2));
console.log('pet.json：maxBubbles =', c.maxBubbles, '/ splitChance =', c.splitChance);

const bp = '/opt/dsh-pet/bridge.config.json';
const b = JSON.parse(fs.readFileSync(bp, 'utf8'));
b.behavior = b.behavior || {};
b.behavior.maxBubbles = 3;
fs.writeFileSync(bp, JSON.stringify(b, null, 2));
console.log('bridge.config.json：behavior.maxBubbles =', b.behavior.maxBubbles);
NODE

echo "== 3. 权限与重启"
chown -R dshpet:dshpet "$APP/lib" "$APP"/*.mjs "$APP/personas.json" "$APP/data" 2>/dev/null || true
systemctl restart dsh-pet-bot
sleep 3

echo "== 4. 自检"
echo -n "服务状态："; systemctl is-active dsh-pet-bot
echo -n "版本："; cat "$APP/VERSION" 2>/dev/null || echo （无）
echo -n "拆气泡函数："; grep -c 'function reshapeSingle' "$APP/lib/pet-api.mjs" || true
echo -n "字数硬切残留（应为 0）："; grep -c 'pieces.push(x.slice' "$APP/lib/pet-api.mjs" || true
echo "--- 最近日志 ---"
journalctl -u dsh-pet-bot -n 6 --no-pager || true

echo "== 5. /turn 健康检查"
PORT=$(grep -E '^TURN_PORT=' "$APP/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')
PORT=${PORT:-3030}
curl -s --max-time 3 "http://127.0.0.1:${PORT}/health" || echo "（/turn 未启动或未配 token）"
echo
