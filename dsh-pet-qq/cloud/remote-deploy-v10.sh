#!/usr/bin/env bash
# v1.12.0 部署：解包代码 → 合并 pet.json / bridge.config.json（说话频率 + 追问窗口）→ 重启 → 自检
set -euo pipefail

APP=/opt/dsh-pet
PKG=/tmp/dist.tgz
[ -f "$PKG" ] || { echo "找不到 $PKG"; exit 1; }

echo "== 1. 解包代码（保留 data/ 与 logs/）"
tar -xzf "$PKG" -C "$APP"

echo "== 2. 合并配置"
node - <<'NODE'
const fs = require('node:fs');

// pet.json：表情概率 + 群聊那半边调参（服务器用它覆盖 bridge.config 的同名字段）
const pp = '/opt/dsh-pet/data/pet.json';
const c = JSON.parse(fs.readFileSync(pp, 'utf8'));
c.memeChancePrivate = 0.22;
c.memeChanceGroup = 0.08;
c.proactive = c.proactive || {};
c.proactive.group = {
  ...(c.proactive.group || {}),
  ratePerHour: 6,
  dailyLimit: { hot: 100, normal: 40, quiet: 20, dead: 6 },
  hourLimit: { hot: 15, normal: 10, quiet: 4, dead: 2 },
  minGapSec: { hot: 75, normal: 240, quiet: 900, dead: 3600 },
  urgencyMin: { hot: 8, normal: 9, quiet: 10, dead: 13 },
  idleOpenMin: 25,
  openerPerHour: { quiet: 1.5, dead: 0.8 },
};
fs.writeFileSync(pp, JSON.stringify(c, null, 2));
console.log('pet.json：群 dailyLimit =', JSON.stringify(c.proactive.group.dailyLimit));

// bridge.config.json：私聊主动频率 + 群聊 + 追问窗口
const bp = '/opt/dsh-pet/bridge.config.json';
const b = JSON.parse(fs.readFileSync(bp, 'utf8'));
b.proactive = b.proactive || {};
Object.assign(b.proactive, {
  impulseThreshold: 58,
  impulseCost: 38,
  ratePerHour: 9,
  dailyLimit: 8,
  minGapMin: 35,
});
b.proactive.group = {
  ...(b.proactive.group || {}),
  ratePerHour: 6,
  perMessage: 3,
  dailyLimit: { hot: 100, normal: 40, quiet: 20, dead: 6 },
  hourLimit: { hot: 15, normal: 10, quiet: 4, dead: 2 },
  minGapSec: { hot: 75, normal: 240, quiet: 900, dead: 3600 },
  urgencyMin: { hot: 8, normal: 9, quiet: 10, dead: 13 },
  idleOpenMin: 25,
  openerPerHour: { quiet: 1.5, dead: 0.8 },
};
b.behavior = b.behavior || {};
b.behavior.coalesceMs = Number(b.behavior.coalesceMs ?? 1600);
b.behavior.followUpMinutes = Number(b.behavior.followUpMinutes ?? 12);
fs.writeFileSync(bp, JSON.stringify(b, null, 2));
console.log('bridge.config.json：私聊阈值 =', b.proactive.impulseThreshold, '/ 日上限', b.proactive.dailyLimit, '/ 追问窗口', b.behavior.followUpMinutes, '分钟');
NODE

echo "== 3. 权限与重启"
chown -R dshpet:dshpet "$APP/lib" "$APP"/*.mjs "$APP/personas.json" "$APP/data" 2>/dev/null || true
systemctl restart dsh-pet-bot
sleep 3

echo "== 4. 自检"
echo -n "服务状态："; systemctl is-active dsh-pet-bot
echo -n "版本："; cat "$APP/VERSION" 2>/dev/null || echo （无）
echo -n "追问窗口接线："; grep -c 'inFollowUp' "$APP/qq-bridge.mjs" || true
echo -n "群档位调参："; node -e "const c=require('$APP/bridge.config.json');console.log(JSON.stringify(c.proactive.group.dailyLimit))"
echo "--- 最近日志 ---"
journalctl -u dsh-pet-bot -n 8 --no-pager || true

echo "== 5. /turn 健康检查"
PORT=$(grep -E '^TURN_PORT=' "$APP/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')
PORT=${PORT:-3030}
curl -s --max-time 3 "http://127.0.0.1:${PORT}/health" || echo "（/turn 未启动或未配 token）"
echo
