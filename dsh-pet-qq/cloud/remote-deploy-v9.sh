#!/usr/bin/env bash
# v1.11.0 部署：解包代码 → 合并 pet.json（表情概率/feeds/memory）→ 重启 → 自检（含 edge-tts）
set -euo pipefail

APP=/opt/dsh-pet
PKG=/tmp/dist.tgz
[ -f "$PKG" ] || { echo "找不到 $PKG"; exit 1; }

echo "== 1. 解包代码（保留 data/ 与 logs/）"
tar -xzf "$PKG" -C "$APP"

echo "== 2. 合并 pet.json 配置"
node - <<'NODE'
const fs = require('node:fs');
const p = '/opt/dsh-pet/data/pet.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
c.memeChancePrivate = 0.22;
c.memeChanceGroup = 0.08;
c.feeds = { enabled: true, hours: [10, 20], biliLimit: 5, douyinLimit: 5, ...(c.feeds || {}) };
c.memory = { maxHistoryTokens: 900, compressAt: 0.82, keepRecentRatio: 0.15, summaryMaxChars: 700, ...(c.memory || {}) };
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log('表情概率 =', c.memeChancePrivate, '/', c.memeChanceGroup);
NODE

echo "== 3. 权限与重启"
chown -R dshpet:dshpet "$APP/lib" "$APP"/*.mjs "$APP/personas.json" "$APP/data" 2>/dev/null || true
systemctl restart dsh-pet-bot
sleep 3

echo "== 4. 自检"
echo -n "服务状态："; systemctl is-active dsh-pet-bot
echo -n "版本："; cat "$APP/VERSION" 2>/dev/null || echo （无）
echo -n "语音依赖："; command -v edge-tts || echo 缺-edge-tts
echo -n "账本接线："; grep -c 'recordUsage' "$APP/lib/pet-api.mjs" || true
echo -n "画像接线："; grep -c 'profileBrief' "$APP/lib/pet-api.mjs" || true
echo -n "连发合并："; grep -c 'collectBatch' "$APP/qq-bridge.mjs" || true
echo "--- 最近日志 ---"
journalctl -u dsh-pet-bot -n 10 --no-pager || true

echo "== 5. /turn 健康检查"
PORT=$(grep -E '^TURN_PORT=' "$APP/.env" 2>/dev/null | cut -d= -f2 | tr -d '\r')
PORT=${PORT:-3030}
curl -s --max-time 3 "http://127.0.0.1:${PORT}/health" || echo "（/turn 未启动或未配 token）"
echo
